import * as vscode from 'vscode';
import type { SwitchTarget } from '../core/cli/cswapCli';
import type { Account } from '../core/model/types';
import { accountName } from '../core/presentation/accountTree';
import { buildQuickSwitchItems, colouredPickerIcon, type QuickSwitchAction, type QuickSwitchItemModel } from '../core/presentation/quickSwitch';
import { sanitizeLabel } from '../core/presentation/statusBar';
import { neutralizeLinks, redactText } from '../core/security/redact';
import { assessFreshness, type RefreshService } from '../core/service/refreshService';
import type { SwitchOutcome, SwitchService } from '../core/service/switchService';
import type { ExtensionConfiguration } from './configuration';
import { describeCliError, describeNoSwitchReason, errorReason } from './messages';
import { presentationOptions, t } from './presentation';
import { pickOne } from './quickPick';

export interface SwitchFlowDependencies {
  readonly refreshService: RefreshService;
  readonly switchService: SwitchService;
  readonly configuration: ExtensionConfiguration;
  readonly homeDir: string;
  /** Where the coloured picker icons are shipped; plain icons without it. */
  readonly context?: Pick<vscode.ExtensionContext, 'extensionUri'>;
}

/**
 * Every row's icon goes in the icon column (`iconPath`), so the rows line up; accounts near or at
 * their limit get a coloured image when `display.pickerColors` is on (a quick pick ignores
 * theme-icon colours and cannot colour text).
 */
function pickerIcon(deps: SwitchFlowDependencies, model: QuickSwitchItemModel): vscode.QuickPickItem['iconPath'] {
  const coloured = deps.context !== undefined && deps.configuration.pickerColors() ? colouredPickerIcon(model.iconId, model.tone) : undefined;
  if (coloured !== undefined && deps.context !== undefined) {
    const folder = vscode.Uri.joinPath(deps.context.extensionUri, 'media', 'picker');
    return { light: vscode.Uri.joinPath(folder, `${coloured}-light.svg`), dark: vscode.Uri.joinPath(folder, `${coloured}-dark.svg`) };
  }
  return model.iconId === undefined ? undefined : new vscode.ThemeIcon(model.iconId);
}

interface ActionItem extends vscode.QuickPickItem {
  readonly action?: QuickSwitchAction;
  /** The last row: add an account instead of switching. */
  readonly addAccount?: true;
}

function findAccount(deps: SwitchFlowDependencies, slot: number): Account | undefined {
  return deps.refreshService.getState().snapshot?.accounts.find((account) => account.slot === slot);
}

function targetLabel(deps: SwitchFlowDependencies, target: SwitchTarget): string {
  if (target.kind === 'strategy') {
    return target.strategy === 'best' ? t('the account with the most headroom') : t('the next available account');
  }
  const account = findAccount(deps, target.slot);
  return account === undefined ? t('slot {0}', target.slot) : t('slot {0} ({1})', target.slot, accountName(account, t));
}

async function confirm(deps: SwitchFlowDependencies, target: SwitchTarget): Promise<boolean> {
  if (!deps.configuration.confirmSwitch()) {
    return true;
  }
  const proceed = t('Switch');
  const always = t("Switch, don't ask again");
  const choice = await vscode.window.showWarningMessage(
    neutralizeLinks(t('Switch Claude Code to {0}?', targetLabel(deps, target))),
    {
      modal: true,
      detail: `${t('cswap replaces the active Claude Code login.')} ${t('Running Claude Code sessions keep running and pick up the new account by themselves; no restart needed.')}`,
    },
    proceed,
    always,
  );
  if (choice === always) {
    try {
      await deps.configuration.setConfirmSwitch(false);
      vscode.window.setStatusBarMessage(t('Cswap: switching without asking from now on. Turn it back on in Cswap Settings.'), 10_000);
    } catch (error) {
      // The switch the user asked for still goes ahead; only the preference was not saved.
      void vscode.window.showWarningMessage(neutralizeLinks(t('The setting could not be saved: {0}', errorReason(error, deps.homeDir))));
    }
  }
  return choice === proceed || choice === always;
}

function verificationNote(outcome: Extract<SwitchOutcome, { verification: unknown }>): string {
  const { verification } = outcome;
  if (verification.refreshError) {
    return t('The result could not be verified: {0}', describeCliError(verification.refreshError));
  }
  return verification.activeSlot === undefined ? t('The active account is unknown.') : t('Active account is now slot {0}.', verification.activeSlot);
}

/** Reports only what the post-switch verification confirmed, never just what the CLI claimed. */
function report(deps: SwitchFlowDependencies, outcome: SwitchOutcome): void {
  // Messages may carry CLI-derived names or reasons; they must never render as links.
  const info = (text: string) => void vscode.window.showInformationMessage(neutralizeLinks(text));
  const warn = (text: string) => void vscode.window.showWarningMessage(neutralizeLinks(text));
  switch (outcome.kind) {
    case 'busy':
      info(t('Another cswap operation is in progress. Try again when it finishes.'));
      return;
    case 'rejected':
      warn(t('The account in that slot changed after you confirmed. Nothing was switched; check the list and try again.'));
      return;
    case 'switched': {
      const slot = outcome.result.to?.slot ?? outcome.verification.activeSlot;
      const warnings = outcome.result.warnings.length > 0 ? ` ${t('cswap reported {0} warning(s).', outcome.result.warnings.length)}` : '';
      if (outcome.verification.status === 'confirmed' && slot !== undefined) {
        const account = findAccount(deps, slot);
        const name = account === undefined ? '' : ` (${accountName(account, t)})`;
        info(`${t('Cswap: switched to slot {0}{1}.', slot, name)}${warnings}`);
      } else {
        warn(`${t('cswap reported a switch, but the new state could not be confirmed.')} ${verificationNote(outcome)}${warnings}`);
      }
      return;
    }
    case 'not-switched':
      info(`${describeNoSwitchReason(outcome.result.reason)} ${verificationNote(outcome)}`);
      return;
    case 'failed': {
      const detail = outcome.error.detail ? ` (${redactText(outcome.error.detail, { homeDir: deps.homeDir })})` : '';
      void vscode.window.showErrorMessage(neutralizeLinks(`${t('Cswap switch failed: {0}', describeCliError(outcome.error))}${detail} ${verificationNote(outcome)}`));
      return;
    }
  }
}

export async function runSwitch(deps: SwitchFlowDependencies, target: SwitchTarget): Promise<SwitchOutcome | undefined> {
  if (deps.switchService.isSwitching()) {
    report(deps, { kind: 'busy' });
    return { kind: 'busy' };
  }
  // The state the user sees while confirming; the switch is refused if that slot changes meanwhile.
  const confirmedWith = deps.refreshService.getState().snapshot;
  if (target.kind === 'slot' && confirmedWith?.active.slot === target.slot) {
    void vscode.window.showInformationMessage(t('Slot {0} is already the active account.', target.slot));
    return undefined;
  }
  if (!(await confirm(deps, target))) {
    return undefined;
  }
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: neutralizeLinks(t('Cswap: switching to {0}…', targetLabel(deps, target))) },
    () => deps.switchService.switch(target, confirmedWith),
  );
  report(deps, outcome);
  return outcome;
}

async function ensureData(deps: SwitchFlowDependencies): Promise<boolean> {
  const state = deps.refreshService.getState();
  const freshness = assessFreshness(state, Date.now(), deps.configuration.staleAfterMs());
  if (freshness.freshness === 'fresh') {
    return true;
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: t('Cswap: refreshing accounts…') },
    () => deps.refreshService.refresh({ trigger: 'manual' }),
  );
  if (!result.ok && result.snapshot === undefined) {
    void vscode.window.showErrorMessage(describeCliError(result.error));
    return false;
  }
  return true;
}

export async function runQuickSwitch(deps: SwitchFlowDependencies): Promise<SwitchOutcome | undefined> {
  if (deps.switchService.isSwitching()) {
    report(deps, { kind: 'busy' });
    return { kind: 'busy' };
  }
  if (!(await ensureData(deps))) {
    return undefined;
  }
  const state = deps.refreshService.getState();
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    return undefined;
  }
  const stale = assessFreshness(state, Date.now(), deps.configuration.staleAfterMs()).freshness === 'stale';
  const items: ActionItem[] = buildQuickSwitchItems(snapshot, presentationOptions(deps.configuration)).map((model) =>
    model.separator
      ? { label: model.label, kind: vscode.QuickPickItemKind.Separator }
      : {
          label: model.label,
          iconPath: pickerIcon(deps, model),
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(model.detail === undefined ? {} : { detail: sanitizeLabel(model.detail) }),
          ...(model.action === undefined ? {} : { action: model.action }),
        },
  );
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: t('Add Account…'), iconPath: new vscode.ThemeIcon('add'), addAccount: true });
  const active = snapshot.active.slot === undefined ? t('unknown') : `#${snapshot.active.slot}`;
  const picked = await pickOne(items, {
    title: t('Cswap: switch account (active: {0})', active),
    placeholder: stale ? t('Data may be out of date. Type to search by slot, email or plan.') : t('Type to search by slot, email or plan.'),
    matchOnDescription: true,
    matchOnDetail: true,
    buttons: [
      { iconId: 'sync', tooltip: t('Cswap Auto-Switch'), run: () => vscode.commands.executeCommand('cswapManager.autoSwitch') },
      { iconId: 'gear', tooltip: t('Cswap Settings'), run: () => vscode.commands.executeCommand('cswapManager.quickSettings') },
    ],
  });
  if (picked?.addAccount === true) {
    void vscode.commands.executeCommand('cswapManager.addAccount');
    return undefined;
  }
  const action = picked?.action;
  if (action === undefined) {
    return undefined;
  }
  return runSwitch(deps, action.kind === 'strategy' ? { kind: 'strategy', strategy: action.strategy } : { kind: 'slot', slot: action.slot });
}
