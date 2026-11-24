import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AUTO_SWITCH_STRATEGIES, ruleMatches, validateRuleInput, type AutoSwitchRuleKey } from '../core/cli/autoSwitchRules';
import type { CswapCli } from '../core/cli/cswapCli';
import { findEvent, type AutoSwitchRules, type AutoTickResult } from '../core/model/autoSwitch';
import { relativeAge } from '../core/presentation/accountTree';
import { formatPercent } from '../core/presentation/format';
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

function modeLabel(mode: AutoSwitchMode): string {
  switch (mode) {
    case 'off':
      return t('Off');
    case 'notify':
      return t('Notify only');
    case 'switch':
      return t('Switch automatically');
  }
}

function strategyLabel(strategy: string | undefined): string {
  switch (strategy) {
    case 'best':
      return t('most quota left');
    case 'weekly-first':
      return t('soonest weekly reset, at the threshold');
    case 'consume-first':
      return t('use the account whose week resets soonest first');
    case 'priority-consume-first':
      return t('highest priority first');
    default:
      // Only cswap-style strategy codes are shown; anything else in the config file is not echoed.
      return strategy !== undefined && /^[a-z0-9-]{1,40}$/.test(strategy) ? strategy : t('unknown');
  }
}

function rulesSummary(rules: AutoSwitchRules | undefined): string {
  if (rules === undefined) {
    return t('rules not loaded');
  }
  const parts = [t('switch at {0}', rules.threshold === undefined ? '?' : formatPercent(rules.threshold))];
  if (rules.weeklyThreshold !== undefined) {
    parts.push(t('weekly at {0}', formatPercent(rules.weeklyThreshold)));
  }
  parts.push(t('cooldown {0}s', rules.cooldownSeconds ?? '?'), t('every {0}s', rules.intervalSeconds ?? '?'), strategyLabel(rules.strategy));
  return parts.join(' · ');
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

  async openMenu(): Promise<void> {
    const state = this.service.getState();
    type Item = vscode.QuickPickItem & { action: () => Promise<unknown> };
    const modeItem = (mode: AutoSwitchMode, icon: string, description: string): Item => ({
      label: `$(${icon}) ${modeLabel(mode)}`,
      description: mode === state.mode ? `${t('current')} · ${description}` : description,
      action: () => this.chooseMode(mode),
    });
    const items: Array<Item | vscode.QuickPickItem> = [
      { label: t('Mode'), kind: vscode.QuickPickItemKind.Separator },
      modeItem('off', 'circle-slash', t('nothing runs')),
      modeItem('notify', 'eye', t('check regularly and tell me when cswap would switch')),
      modeItem('switch', 'sync', t('let cswap switch accounts by itself')),
      { label: t('Tools'), kind: vscode.QuickPickItemKind.Separator },
      { label: `$(beaker) ${t('Preview now')}`, description: t('what cswap would do right now (dry run)'), action: () => this.preview() },
      { label: `$(settings-gear) ${t('Rules…')}`, description: rulesSummary(state.rules), action: () => this.editRules() },
      { label: `$(output) ${t('Show log')}`, action: () => Promise.resolve(this.deps.logger.show()) },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: t('Cswap Auto-Switch ({0})', modeLabel(state.mode)) });
    if (picked !== undefined && 'action' in picked) {
      await picked.action();
    }
  }

  async chooseMode(mode: AutoSwitchMode): Promise<void> {
    if (mode === 'switch' && this.deps.configuration.autoSwitchMode() !== 'switch') {
      const rules = (await this.service.reloadRules()) ?? this.service.getState().rules;
      const proceed = t('Turn on');
      const choice = await vscode.window.showWarningMessage(
        t('Let cswap switch accounts automatically?'),
        {
          modal: true,
          detail: [
            t('While VS Code is open, cswap checks usage every {0} seconds and switches the active Claude Code account when it reaches the limit. Running Claude Code sessions will use the new account.', Math.round(this.service.intervalMs() / 1000)),
            t('Rules: {0}.', rulesSummary(rules)),
            t('You get a notification for every switch and can turn this off at any time.'),
          ].join('\n\n'),
        },
        proceed,
      );
      if (choice !== proceed) {
        return;
      }
    }
    await this.deps.configuration.setAutoSwitchMode(mode);
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

  async editRules(): Promise<void> {
    const rules = (await this.service.reloadRules()) ?? this.service.getState().rules;
    const valueText = (value: number | string | undefined, suffix = '') => (value === undefined ? t('not set') : `${value}${suffix}`);
    const entries: Array<{ key: AutoSwitchRuleKey; label: string; value: string; help: string }> = [
      { key: 'autoswitch.threshold', label: t('Switch threshold'), value: valueText(rules?.threshold, '%'), help: t('Switch when the 5-hour window (or any window without a weekly line) reaches this usage.') },
      { key: 'autoswitch.weeklyThreshold', label: t('Weekly threshold'), value: valueText(rules?.weeklyThreshold, '%'), help: t('Separate line for the 7-day and per-model windows; not set means the switch threshold.') },
      { key: 'autoswitch.cooldownSeconds', label: t('Cooldown'), value: valueText(rules?.cooldownSeconds, ' s'), help: t('Minimum time between two automatic switches.') },
      { key: 'autoswitch.intervalSeconds', label: t('Check interval'), value: valueText(rules?.intervalSeconds, ' s'), help: t('How often usage is checked while auto-switch is on.') },
      { key: 'autoswitch.strategy', label: t('Strategy'), value: strategyLabel(rules?.strategy), help: t('How the next account is chosen.') },
    ];
    const picked = await vscode.window.showQuickPick(
      entries.map((entry) => ({
        label: entry.label,
        description: entry.value + ((rules?.customized ?? []).includes(entry.key) ? '' : ` · ${t('default')}`),
        detail: entry.help,
        entry,
      })),
      { title: t('Cswap auto-switch rules'), placeHolder: t('These are cswap settings; they also apply to `cswap auto` in a terminal.') },
    );
    if (picked === undefined) {
      return;
    }
    const key = picked.entry.key;
    const reset = t('Reset to default');
    let newValue: string | undefined;
    if (key === 'autoswitch.strategy') {
      const strategy = await vscode.window.showQuickPick(
        [...AUTO_SWITCH_STRATEGIES.map((value) => ({ label: strategyLabel(value), description: value, value })), { label: reset, description: '', value: '' }],
        { title: picked.entry.label },
      );
      newValue = strategy?.value;
    } else {
      newValue = await vscode.window.showInputBox({
        title: picked.entry.label,
        prompt: `${picked.entry.help} ${t('Leave empty to reset to the default.')}`,
        value: '',
        validateInput: (input) => {
          if (input.trim() === '') {
            return undefined;
          }
          const result = validateRuleInput(key, input);
          return result.ok ? undefined : t('Enter a value in {0}.', result.range);
        },
      });
    }
    if (newValue === undefined) {
      return;
    }
    await this.applyRule(key, newValue.trim());
  }

  // ---- Internals ------------------------------------------------------------------------------

  private async applyRule(key: AutoSwitchRuleKey, value: string): Promise<void> {
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
      return;
    }
    if (!outcome.ok) {
      const detail = outcome.error.detail ? ` ${outcome.error.detail}` : '';
      void vscode.window.showErrorMessage(neutralizeLinks(`${describeCliError(outcome.error)}${detail}`));
      return;
    }
    const rules = await this.service.reloadRules();
    if (rules === undefined) {
      void vscode.window.showWarningMessage(t('The rule was saved, but cswap settings could not be read back.'));
      return;
    }
    this.render();
    if (!ruleMatches(rules, key, value)) {
      void vscode.window.showWarningMessage(t('cswap accepted the change, but reading the settings back shows a different value.'));
      return;
    }
    void vscode.window.showInformationMessage(neutralizeLinks(t('Cswap auto-switch rules: {0}.', rulesSummary(rules))));
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
