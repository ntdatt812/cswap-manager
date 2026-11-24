import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AUTO_SWITCH_STRATEGIES, ruleMatches, validateRuleInput, type AutoSwitchRuleKey, type AutoSwitchStrategy } from '../core/cli/autoSwitchRules';
import type { CswapCli } from '../core/cli/cswapCli';
import { findEvent, type AutoSwitchRules, type AutoTickResult } from '../core/model/autoSwitch';
import { relativeAge } from '../core/presentation/accountTree';
import { formatPercent } from '../core/presentation/format';
import { autoSwitchModeLabel, autoSwitchStrategyDetail, autoSwitchStrategyLabel } from '../core/presentation/quickSettings';
import { neutralizeLinks, redactText } from '../core/security/redact';
import {
  AutoSwitchService,
  ERROR_NOTICE_AFTER,
  LEASE_UNAVAILABLE,
  FileLease,
  type AutoSwitchMode,
  type AutoSwitchNotice,
  type AutoSwitchState,
} from '../core/service/autoSwitchService';
import type { OperationGate } from '../core/service/operationGate';
import type { RefreshService } from '../core/service/refreshService';
import type { SwitchService } from '../core/service/switchService';
import { renderTooltip } from './accountsTreeProvider';
import { CONFIG_SECTION, type ExtensionConfiguration } from './configuration';
import type { Logger } from './logger';
import { describeCliError } from './messages';
import { CLOCK_TICK_MS, formatDateTime, t } from './presentation';
import { askWithBack, BACK, pickOne } from './quickPick';
import { runSwitch } from './switchFlow';

export interface AutoSwitchDependencies {
  readonly context: vscode.ExtensionContext;
  readonly cli: CswapCli;
  readonly gate: OperationGate;
  readonly refreshService: RefreshService;
  readonly switchService: SwitchService;
  readonly configuration: ExtensionConfiguration;
  readonly logger: Logger;
  readonly homeDir: string;
}

/** Human text for cswap's `no-switch` reasons (from the CLI source); unknown codes are shown as-is. */
export function describeAutoReason(reason: string | undefined): string {
  switch (reason) {
    case 'below-threshold':
      return t('the active account is below the switch threshold');
    case 'cooldown':
      return t('waiting for the cooldown after the last switch');
    case 'no-qualifying-candidate':
    case 'no-viable-target':
    case 'no-candidates':
      return t('no other account has enough quota left');
    case 'stale-usage':
      return t('usage data is too old to decide');
    case 'active-usage-unknown':
    case 'reset-unknown':
    case 'no-comparison':
      return t('usage is not known well enough to decide');
    case 'unmanaged-active-account':
      return t('the current Claude login is not managed by cswap');
    case 'no-active-account':
      return t('there is no active account');
    case 'active-idle':
      return t('the active account is idle');
    case 'active-api-key':
      return t('the active account is an API key');
    case 'already-active':
    case 'already-consuming-soonest':
    case 'already-consuming-priority':
      return t('the active account is already the preferred one');
    case undefined:
      return t('no reason given');
    default:
      return /^[a-z0-9-]{1,64}$/.test(reason) ? reason : t('no reason given');
  }
}

const modeLabel = (mode: AutoSwitchMode): string => autoSwitchModeLabel(mode, t);
const strategyLabel = (strategy: string | undefined): string => autoSwitchStrategyLabel(strategy, t);

/** The strategy that spends quota before it resets instead of letting it expire unused. */
const CONSUME_FIRST: AutoSwitchStrategy = 'consume-first';

function rulesSummary(rules: AutoSwitchRules | undefined, withStrategy = true): string {
  if (rules === undefined) {
    return t('rules not loaded');
  }
  const parts = [t('switch at {0}', rules.threshold === undefined ? '?' : formatPercent(rules.threshold))];
  if (rules.weeklyThreshold !== undefined) {
    parts.push(t('weekly at {0}', formatPercent(rules.weeklyThreshold)));
  }
  parts.push(t('cooldown {0}s', rules.cooldownSeconds ?? '?'), t('every {0}s', rules.intervalSeconds ?? '?'));
  if (withStrategy) {
    parts.push(strategyLabel(rules.strategy));
  }
  return parts.join(' · ');
}

/**
 * How a menu ended: `back` (the ← Back button), `done` (an action finished; a caller such as Quick
 * Settings shows its own list again) or `closed` (dismissed, or it handed over to other UI).
 */
export type MenuResult = 'back' | 'done' | 'closed';

export interface MenuOptions {
  /** Show the ← Back button (the menu was opened from another list). */
  readonly back?: boolean;
}

/** Status bar item, menu, notifications and lease wiring for `cswap auto`. */
export class AutoSwitchController implements vscode.Disposable {
  readonly service: AutoSwitchService;
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private clock: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: AutoSwitchDependencies) {
    const storage = deps.context.globalStorageUri.fsPath;
    const leasePath = path.join(storage, 'auto-switch.lease.json');
    const lease = new FileLease(
      {
        read: async () => {
          try {
            return await fs.readFile(leasePath, 'utf8');
          } catch {
            return undefined;
          }
        },
        write: async (content) => {
          await fs.mkdir(storage, { recursive: true });
          await fs.writeFile(leasePath, content, 'utf8');
        },
        remove: async () => {
          await fs.rm(leasePath, { force: true });
        },
      },
      vscode.env.sessionId,
      () => 3 * this.service.intervalMs(),
    );
    this.service = new AutoSwitchService({
      cli: deps.cli,
      refresher: deps.refreshService,
      gate: deps.gate,
      lease,
      onNotice: (notice) => void this.notify(notice),
    });
    this.item = vscode.window.createStatusBarItem('cswapManager.autoSwitch', vscode.StatusBarAlignment.Right, 99);
    this.item.name = t('Cswap Auto-Switch');
    this.item.command = 'cswapManager.autoSwitch';
    this.disposables.push(
      this.item,
      this.service,
      this.service.onDidChange((state) => {
        this.logState(state);
        this.render();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${CONFIG_SECTION}.autoSwitch.mode`)) {
          void this.service.setMode(deps.configuration.autoSwitchMode());
        }
        if (event.affectsConfiguration(`${CONFIG_SECTION}.language`)) {
          this.item.name = t('Cswap Auto-Switch');
          this.render();
        }
      }),
    );
    void this.service.setMode(deps.configuration.autoSwitchMode());
    this.render();
  }

  dispose(): void {
    if (this.clock !== undefined) {
      clearInterval(this.clock);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  // ---- Menu -----------------------------------------------------------------------------------

  async openMenu(options: MenuOptions = {}): Promise<MenuResult> {
    for (;;) {
      const result = await this.showMenuOnce(options);
      // A sub-menu's ← Back returns here; everything else ends the menu.
      if (result !== 'again') {
        return result;
      }
    }
  }

  private async showMenuOnce(options: MenuOptions): Promise<MenuResult | 'again'> {
    if (this.service.getState().rules === undefined) {
      // Rules are only loaded once auto-switch runs; read them so the menu shows the real strategy.
      await this.service.reloadRules();
    }
    const state = this.service.getState();
    type Item = vscode.QuickPickItem & { action: () => Promise<MenuResult>; mode?: AutoSwitchMode };
    const modeItem = (mode: AutoSwitchMode, icon: string, description: string): Item => ({
      label: `$(${icon}) ${modeLabel(mode)}`,
      description: mode === state.mode ? `${t('current')} · ${description}` : description,
      mode,
      action: async () => ((await this.chooseMode(mode)) ? 'done' : 'closed'),
    });
    const consuming = state.mode === 'switch' && state.rules?.strategy === CONSUME_FIRST;
    const items: Array<Item | vscode.QuickPickItem> = [
      {
        label: `$(flame) ${t('Switch automatically, use quota before it resets')}`,
        description: consuming ? t('current') : t('recommended'),
        detail: autoSwitchStrategyDetail(CONSUME_FIRST, t),
        action: async () => {
          await this.useConsumeFirst();
          return 'done';
        },
      },
      { label: t('Mode'), kind: vscode.QuickPickItemKind.Separator },
      modeItem('off', 'circle-slash', t('nothing runs')),
      modeItem('notify', 'eye', t('check regularly and tell me when cswap would switch')),
      modeItem('switch', 'sync', t('let cswap switch accounts by itself')),
      { label: t('Tools'), kind: vscode.QuickPickItemKind.Separator },
      { label: `$(lightbulb) ${t('Strategy…')}`, description: strategyLabel(state.rules?.strategy), action: () => this.chooseStrategy({ back: true }) },
      {
        label: `$(beaker) ${t('Preview now')}`,
        description: t('what cswap would do right now (dry run)'),
        action: async () => {
          await this.preview();
          return 'closed';
        },
      },
      { label: `$(settings-gear) ${t('Rules…')}`, description: rulesSummary(state.rules), action: () => this.editRules({ back: true }) },
      {
        label: `$(output) ${t('Show log')}`,
        action: () => {
          this.deps.logger.show();
          return Promise.resolve('closed');
        },
      },
    ];
    // The current mode is highlighted, so Enter on an unchanged menu never changes anything.
    const picked = await pickOne(items, {
      title: t('Cswap Auto-Switch ({0})', modeLabel(state.mode)),
      isActive: (item) => 'mode' in item && item.mode === state.mode,
      back: options.back === true,
    });
    if (picked === BACK) {
      return 'back';
    }
    if (picked === undefined || !('action' in picked)) {
      return 'closed';
    }
    const result = await picked.action();
    return result === 'back' ? 'again' : result;
  }

  /** cswap's thresholds, cooldown and check interval (not the strategy); undefined until loaded. */
  rulesText(): string | undefined {
    const rules = this.service.getState().rules;
    return rules === undefined ? undefined : rulesSummary(rules, false);
  }

  /** Returns false when the user declined turning automatic switching on. */
  async chooseMode(mode: AutoSwitchMode): Promise<boolean> {
    if (mode === 'switch' && this.deps.configuration.autoSwitchMode() !== 'switch' && !(await this.confirmAutomaticSwitching())) {
      return false;
    }
    await this.deps.configuration.setAutoSwitchMode(mode);
    return true;
  }

  /**
   * One step to the "don't waste quota" setup: cswap's own `consume-first` strategy plus automatic
   * switching. The strategy is saved before the mode, so no tick runs with the old strategy.
   */
  async useConsumeFirst(): Promise<void> {
    const enabling = this.deps.configuration.autoSwitchMode() !== 'switch';
    if (enabling && !(await this.confirmAutomaticSwitching(CONSUME_FIRST))) {
      return;
    }
    const rules = (await this.service.reloadRules()) ?? this.service.getState().rules;
    if (rules?.strategy !== CONSUME_FIRST && !(await this.applyRule('autoswitch.strategy', CONSUME_FIRST))) {
      if (enabling) {
        void vscode.window.showWarningMessage(t('Automatic switching was not turned on.'));
      }
      return;
    }
    if (enabling) {
      await this.deps.configuration.setAutoSwitchMode('switch');
    }
  }

  /**
   * Picks one of cswap's auto-switch strategies (or cswap's default) and saves it in cswap's config.
   */
  async chooseStrategy(options: MenuOptions = {}): Promise<MenuResult> {
    const rules = (await this.service.reloadRules()) ?? this.service.getState().rules;
    const current = rules?.strategy;
    const customized = (rules?.customized ?? []).includes('autoswitch.strategy');
    type StrategyItem = vscode.QuickPickItem & { readonly value: string };
    const items: StrategyItem[] = [
      ...AUTO_SWITCH_STRATEGIES.map((value) => ({
        label: `${value === CONSUME_FIRST ? '$(flame)' : '$(circle-large-outline)'} ${strategyLabel(value)}`,
        description: value === current ? t('current') : value,
        detail: autoSwitchStrategyDetail(value, t),
        value,
      })),
      ...(customized ? [{ label: `$(discard) ${t('Reset to default')}`, value: '' }] : []),
    ];
    const picked = await pickOne(items, {
      title: t('Auto-switch strategy'),
      placeholder: t('These are cswap settings; they also apply to `cswap auto` in a terminal.'),
      isActive: (item) => item.value === current,
      back: options.back === true,
    });
    if (picked === BACK) {
      return 'back';
    }
    if (picked === undefined) {
      return 'closed';
    }
    if (picked.value !== current) {
      await this.applyRule('autoswitch.strategy', picked.value);
    }
    return 'done';
  }

  private async confirmAutomaticSwitching(strategy?: AutoSwitchStrategy): Promise<boolean> {
    const loaded = (await this.service.reloadRules()) ?? this.service.getState().rules;
    const rules = loaded !== undefined && strategy !== undefined ? { ...loaded, strategy } : loaded;
    const proceed = t('Turn on');
    const choice = await vscode.window.showWarningMessage(
      t('Let cswap switch accounts automatically?'),
      {
        modal: true,
        detail: [
          (strategy ?? rules?.strategy) === CONSUME_FIRST
            ? t('While VS Code is open, cswap checks usage every {0} seconds and moves early to an account with quota left whose week resets sooner, so that quota is not wasted.', Math.round(this.service.intervalMs() / 1000))
            : t('While VS Code is open, cswap checks usage every {0} seconds and switches the active Claude Code account when it reaches the limit.', Math.round(this.service.intervalMs() / 1000)),
          t('Running Claude Code sessions keep running and pick up the new account by themselves; no restart needed.'),
          t('Rules: {0}.', rulesSummary(rules)),
          t('You get a notification for every switch and can turn this off at any time.'),
        ].join('\n\n'),
      },
      proceed,
    );
    return choice === proceed;
  }

  async preview(): Promise<AutoTickResult | undefined> {
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Cswap: checking what auto-switch would do…') },
      () => this.service.preview(),
    );
    if (!outcome.ok) {
      void vscode.window.showErrorMessage(neutralizeLinks(describeCliError(outcome.error)));
      return undefined;
    }
    const result = outcome.value;
    const switchEvent = findEvent(result, 'switch');
    const exhausted = findEvent(result, 'all-exhausted');
    if (switchEvent !== undefined) {
      const switchNow = t('Switch now');
      const choice = await vscode.window.showInformationMessage(
        t('Auto-switch would move from slot {0} to slot {1} now.', switchEvent.fromSlot ?? '?', switchEvent.toSlot ?? '?'),
        ...(switchEvent.toSlot === undefined ? [] : [switchNow]),
      );
      if (choice === switchNow && switchEvent.toSlot !== undefined) {
        await runSwitch(this.switchDeps(), { kind: 'slot', slot: switchEvent.toSlot });
      }
    } else if (exhausted !== undefined || result.outcome === 'blocked') {
      void vscode.window.showWarningMessage(this.blockedText(exhausted?.earliestResetAt));
    } else {
      void vscode.window.showInformationMessage(
        neutralizeLinks(t('Auto-switch would not switch now: {0}.', describeAutoReason(findEvent(result, 'no-switch')?.reason))),
      );
    }
    return result;
  }

  /** cswap's auto-switch rules; after each change the list shows again with the new values. */
  async editRules(options: MenuOptions = {}): Promise<MenuResult> {
    for (;;) {
      const result = await this.editRuleOnce(options);
      if (result !== 'again') {
        return result;
      }
    }
  }

  private async editRuleOnce(options: MenuOptions): Promise<MenuResult | 'again'> {
    const rules = (await this.service.reloadRules()) ?? this.service.getState().rules;
    const valueText = (value: number | string | undefined, suffix = '') => (value === undefined ? t('not set') : `${value}${suffix}`);
    const entries: Array<{ key: AutoSwitchRuleKey; label: string; value: string; help: string }> = [
      { key: 'autoswitch.threshold', label: t('Switch threshold'), value: valueText(rules?.threshold, '%'), help: t('Switch when the 5-hour window (or any window without a weekly line) reaches this usage.') },
      { key: 'autoswitch.weeklyThreshold', label: t('Weekly threshold'), value: valueText(rules?.weeklyThreshold, '%'), help: t('Separate line for the 7-day and per-model windows; not set means the switch threshold.') },
      { key: 'autoswitch.cooldownSeconds', label: t('Cooldown'), value: valueText(rules?.cooldownSeconds, ' s'), help: t('Minimum time between two automatic switches.') },
      { key: 'autoswitch.intervalSeconds', label: t('Check interval'), value: valueText(rules?.intervalSeconds, ' s'), help: t('How often usage is checked while auto-switch is on.') },
      { key: 'autoswitch.strategy', label: t('Strategy'), value: strategyLabel(rules?.strategy), help: t('How the next account is chosen.') },
    ];
    const picked = await pickOne(
      entries.map((entry) => ({
        label: entry.label,
        description: entry.value + ((rules?.customized ?? []).includes(entry.key) ? '' : ` · ${t('default')}`),
        detail: entry.help,
        entry,
      })),
      { title: t('Cswap auto-switch rules'), placeholder: t('These are cswap settings; they also apply to `cswap auto` in a terminal.'), back: options.back === true },
    );
    if (picked === BACK) {
      return 'back';
    }
    if (picked === undefined) {
      return 'closed';
    }
    const key = picked.entry.key;
    if (key === 'autoswitch.strategy') {
      return (await this.chooseStrategy({ back: true })) === 'closed' ? 'closed' : 'again';
    }
    const newValue = await askWithBack({
      title: picked.entry.label,
      prompt: `${picked.entry.help} ${t('Leave empty to reset to the default.')}`,
      value: '',
      validate: (input) => {
        if (input.trim() === '') {
          return undefined;
        }
        const result = validateRuleInput(key, input);
        return result.ok ? undefined : t('Enter a value in {0}.', result.range);
      },
    });
    if (newValue === BACK) {
      return 'again';
    }
    if (newValue === undefined) {
      return 'closed';
    }
    await this.applyRule(key, newValue.trim());
    return 'again';
  }

  // ---- Internals ------------------------------------------------------------------------------

  /** Saves one rule in cswap's config and verifies it by reading the config back. */
  private async applyRule(key: AutoSwitchRuleKey, value: string): Promise<boolean> {
    const outcome = await this.deps.gate.run(async () => {
      if (value === '') {
        return this.deps.cli.resetAutoSwitchRule(key);
      }
      const validated = validateRuleInput(key, value);
      if (!validated.ok) {
        return undefined;
      }
      const update =
        key === 'autoswitch.strategy'
          ? { key, value: validated.value as (typeof AUTO_SWITCH_STRATEGIES)[number] }
          : { key, value: Number(validated.value) };
      return this.deps.cli.setAutoSwitchRule(update);
    });
    if (outcome === undefined) {
      void vscode.window.showInformationMessage(t('Another cswap operation is in progress. Try again when it finishes.'));
      return false;
    }
    if (!outcome.ok) {
      const detail = outcome.error.detail ? ` ${outcome.error.detail}` : '';
      void vscode.window.showErrorMessage(neutralizeLinks(`${describeCliError(outcome.error)}${detail}`));
      return false;
    }
    const rules = await this.service.reloadRules();
    if (rules === undefined) {
      void vscode.window.showWarningMessage(t('The rule was saved, but cswap settings could not be read back.'));
      return false;
    }
    this.render();
    if (!ruleMatches(rules, key, value)) {
      void vscode.window.showWarningMessage(t('cswap accepted the change, but reading the settings back shows a different value.'));
      return false;
    }
    void vscode.window.showInformationMessage(neutralizeLinks(t('Cswap auto-switch rules: {0}.', rulesSummary(rules))));
    return true;
  }

  private switchDeps() {
    const { refreshService, switchService, configuration, homeDir } = this.deps;
    return { refreshService, switchService, configuration, homeDir };
  }

  private blockedText(earliestResetAt: string | undefined): string {
    const epoch = earliestResetAt === undefined ? Number.NaN : Date.parse(earliestResetAt);
    return Number.isNaN(epoch)
      ? t('Cswap auto-switch: every account is at its limit.')
      : t('Cswap auto-switch: every account is at its limit. The first one resets at {0}.', formatDateTime(epoch));
  }

  private async notify(notice: AutoSwitchNotice): Promise<void> {
    switch (notice.kind) {
      case 'switched': {
        const text = t('Cswap auto-switch moved from slot {0} to slot {1}.', notice.fromSlot ?? '?', notice.toSlot ?? '?');
        if (notice.verification === 'confirmed') {
          void vscode.window.showInformationMessage(text);
        } else if (notice.verification === 'mismatch' && notice.activeSlot !== undefined) {
          void vscode.window.showWarningMessage(
            t('Cswap auto-switch reported a move to slot {0}, but slot {1} is now active.', notice.toSlot ?? '?', notice.activeSlot),
          );
        } else {
          void vscode.window.showWarningMessage(`${text} ${t('The new active account could not be confirmed yet.')}`);
        }
        return;
      }
      case 'would-switch': {
        const switchNow = t('Switch now');
        const automatic = t('Switch automatically');
        const choice = await vscode.window.showInformationMessage(
          t('Cswap auto-switch would move from slot {0} to slot {1}.', notice.fromSlot ?? '?', notice.toSlot ?? '?'),
          ...(notice.toSlot === undefined ? [] : [switchNow]),
          automatic,
        );
        if (choice === switchNow && notice.toSlot !== undefined) {
          await runSwitch(this.switchDeps(), { kind: 'slot', slot: notice.toSlot });
        } else if (choice === automatic) {
          await this.chooseMode('switch');
        }
        return;
      }
      case 'blocked':
        void vscode.window.showWarningMessage(this.blockedText(notice.earliestResetAt));
        return;
      case 'failing': {
        const reason = notice.error
          ? describeCliError(notice.error)
          : notice.message === LEASE_UNAVAILABLE
            ? t('the coordination file between VS Code windows could not be written')
            : notice.message === undefined
              ? t('unknown')
              : redactText(notice.message, { homeDir: this.deps.homeDir, maxLength: 200 });
        const log = t('Show log');
        const choice = await vscode.window.showWarningMessage(
          neutralizeLinks(t('Cswap auto-switch failed {0} times in a row: {1}', ERROR_NOTICE_AFTER, reason)),
          log,
        );
        if (choice === log) {
          this.deps.logger.show();
        }
        return;
      }
    }
  }

  private lastLoggedTick: number | undefined;

  private logState(state: AutoSwitchState): void {
    if (state.lastTickAt === undefined || state.lastTickAt === this.lastLoggedTick || state.ticking) {
      return;
    }
    this.lastLoggedTick = state.lastTickAt;
    const moved = state.lastSwitch?.at === state.lastTickAt ? ` ${state.lastSwitch.fromSlot ?? '?'} -> ${state.lastSwitch.toSlot ?? '?'}${state.lastSwitch.dryRun ? ' (dry run)' : ''}` : '';
    this.deps.logger.info(`auto-switch tick (${state.mode}): ${state.lastOutcome ?? 'unknown'}${state.lastReason ? ` [${state.lastReason}]` : ''}${moved}`);
  }

  private render(): void {
    const state = this.service.getState();
    if (state.mode === 'off') {
      this.item.hide();
      if (this.clock !== undefined) {
        clearInterval(this.clock);
        this.clock = undefined;
      }
      return;
    }
    this.clock ??= setInterval(() => this.render(), CLOCK_TICK_MS);
    const icon = state.ticking ? 'sync~spin' : state.mode === 'switch' ? 'sync' : 'eye';
    const threshold = state.rules?.threshold === undefined ? '' : ` ${formatPercent(state.rules.threshold)}`;
    this.item.text = `$(${icon}) ${t('Auto')}${state.mode === 'switch' ? threshold : ''}`;
    const rows = [
      { label: t('Mode'), value: modeLabel(state.mode) },
      { label: t('Rules'), value: rulesSummary(state.rules) },
      {
        label: t('Runs in'),
        value: state.role === 'standby' ? t('another VS Code window') : state.role === 'leader' ? t('this window') : t('starting…'),
      },
    ];
    if (state.lastTickAt !== undefined) {
      const result =
        state.lastOutcome === 'error'
          ? t('error ({0} in a row)', state.consecutiveErrors)
          : state.lastSwitch?.at === state.lastTickAt
            ? state.lastSwitch.dryRun
              ? t('would switch slot {0} → {1}', state.lastSwitch.fromSlot ?? '?', state.lastSwitch.toSlot ?? '?')
              : t('switched slot {0} → {1}', state.lastSwitch.fromSlot ?? '?', state.lastSwitch.toSlot ?? '?')
            : describeAutoReason(state.lastReason);
      rows.push({ label: t('Last check'), value: `${relativeAge(Date.now() - state.lastTickAt, t)} · ${result}` });
    }
    this.item.tooltip = renderTooltip({ title: t('Cswap Auto-Switch'), rows, notes: [t('Click for options.')] });
    this.item.accessibilityInformation = { label: `${t('Cswap Auto-Switch')}: ${modeLabel(state.mode)}` };
    this.item.backgroundColor = state.consecutiveErrors >= ERROR_NOTICE_AFTER ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }
}
