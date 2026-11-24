import * as vscode from 'vscode';
import type { AccountActionId } from '../shared/dashboardProtocol';
import type { ManageOperation } from '../core/cli/cswapCli';
import { THRESHOLD_MAX, THRESHOLD_MIN, normalizeAlias, parseThreshold, type AliasProblem } from '../core/model/accountPolicy';
import type { Account, AccountsSnapshot } from '../core/model/types';
import { actionLabel, availableActions } from '../core/presentation/accountActions';
import { accountName } from '../core/presentation/accountTree';
import { formatPercent } from '../core/presentation/format';
import { sanitizeLabel } from '../core/presentation/statusBar';
import { neutralizeLinks, redactText } from '../core/security/redact';
import type { ManageOutcome, ManagementService } from '../core/service/managementService';
import type { OperationGate } from '../core/service/operationGate';
import type { RefreshService } from '../core/service/refreshService';
import { describeCliError } from './messages';
import { t } from './presentation';

export interface ManageFlowDependencies {
  readonly refreshService: RefreshService;
  readonly managementService: ManagementService;
  readonly gate: OperationGate;
  readonly homeDir: string;
}

/** Account names come from the CLI: strip icon syntax and link syntax before they reach any UI text. */
function label(account: Account): string {
  return neutralizeLinks(sanitizeLabel(t('slot {0} ({1})', account.slot, accountName(account, t))));
}

function aliasProblemText(problem: AliasProblem): string {
  switch (problem) {
    case 'empty':
      return t('Enter an alias, or use "Remove alias" to clear it.');
    case 'numeric':
      return t('An alias cannot be only digits (those are slot numbers).');
    case 'leading-dash':
      return t('An alias cannot start with "-".');
    case 'invalid-characters':
      return t('Use only letters, digits, "-", "_" and "." (stored in lower case).');
  }
}

async function snapshotOrRefresh(deps: ManageFlowDependencies): Promise<AccountsSnapshot | undefined> {
  const existing = deps.refreshService.getState().snapshot;
  if (existing !== undefined) {
    return existing;
  }
  const result = await deps.refreshService.refresh({ trigger: 'manual' });
  if (!result.ok && result.snapshot === undefined) {
    void vscode.window.showErrorMessage(describeCliError(result.error));
    return undefined;
  }
  return deps.refreshService.getState().snapshot;
}

async function pickAccount(snapshot: AccountsSnapshot, title: string): Promise<Account | undefined> {
  const picked = await vscode.window.showQuickPick(
    snapshot.accounts.map((account) => ({
      label: sanitizeLabel(`${account.slot} · ${accountName(account, t)}`),
      description: snapshot.active.slot === account.slot ? t('current') : undefined,
      account,
    })),
    { title, placeHolder: t('Choose an account') },
  );
  return picked?.account;
}

async function promptAlias(account: Account): Promise<ManageOperation | undefined> {
  const value = await vscode.window.showInputBox({
    title: t('Set alias for {0}', label(account)),
    prompt: t('A short name you can use instead of the slot number. Stored by cswap in lower case.'),
    value: account.alias ?? '',
    validateInput: (input) => {
      const result = normalizeAlias(input);
      return result.ok ? undefined : aliasProblemText(result.problem);
    },
  });
  if (value === undefined) {
    return undefined;
  }
  const alias = normalizeAlias(value);
  return alias.ok ? { kind: 'setAlias', slot: account.slot, alias: alias.value } : undefined;
}

async function promptThreshold(account: Account): Promise<ManageOperation | undefined> {
  const value = await vscode.window.showInputBox({
    title: t('Switch threshold for {0}', label(account)),
    prompt: t(
      'cswap auto-switch leaves this account at this usage percentage ({0}–{1}). This changes cswap behaviour, unlike the sidebar colour thresholds.',
      THRESHOLD_MIN,
      THRESHOLD_MAX,
    ),
    value: account.threshold === undefined ? '' : String(account.threshold),
    validateInput: (input) => {
      const result = parseThreshold(input);
      if (result.ok) {
        return undefined;
      }
      return result.problem === 'out-of-range'
        ? t('Enter a value between {0} and {1}.', THRESHOLD_MIN, THRESHOLD_MAX)
        : t('Enter a number such as 85 or 92.5.');
    },
  });
  if (value === undefined) {
    return undefined;
  }
  const threshold = parseThreshold(value);
  return threshold.ok ? { kind: 'setThreshold', slot: account.slot, threshold: threshold.value } : undefined;
}

async function confirmDisable(account: Account, snapshot: AccountsSnapshot): Promise<ManageOperation | undefined> {
  const active = snapshot.active.slot === account.slot;
  const remaining = snapshot.accounts.filter((candidate) => candidate.slot !== account.slot && candidate.disabled !== true).length;
  const details = [
    t('cswap auto-switch, plain rotation and the best/next-available strategies will skip this account. You can still switch to it directly.'),
    active ? t('It is the active account and stays active until you switch away.') : undefined,
    remaining === 0 ? t('No other account would remain in rotation.') : undefined,
  ].filter((line): line is string => line !== undefined);
  const proceed = t('Disable');
  const choice = await vscode.window.showWarningMessage(t('Disable {0} in rotation?', label(account)), { modal: true, detail: details.join('\n\n') }, proceed);
  return choice === proceed ? { kind: 'setDisabled', slot: account.slot, disabled: true } : undefined;
}

async function promptMove(account: Account, snapshot: AccountsSnapshot): Promise<ManageOperation | undefined> {
  const highest = Math.max(...snapshot.accounts.map((candidate) => candidate.slot));
  const items: Array<vscode.QuickPickItem & { slot: number }> = [];
  for (let slot = 1; slot <= highest + 1; slot++) {
    if (slot === account.slot) {
      continue;
    }
    const occupant = snapshot.accounts.find((candidate) => candidate.slot === slot);
    items.push({
      label: t('Slot {0}', slot),
      description: occupant === undefined ? t('empty — move there') : sanitizeLabel(t('swap with {0}', accountName(occupant, t))),
      slot,
    });
  }
  const picked = await vscode.window.showQuickPick(items, { title: t('Move {0} to…', label(account)) });
  if (picked === undefined) {
    return undefined;
  }
  const occupant = snapshot.accounts.find((candidate) => candidate.slot === picked.slot);
  const consequence =
    occupant === undefined
      ? t('Slot {0} becomes free.', account.slot)
      : neutralizeLinks(sanitizeLabel(t('{0} moves to slot {1}.', accountName(occupant, t), account.slot)));
  const proceed = t('Move');
  const choice = await vscode.window.showWarningMessage(
    t('Move {0} to slot {1}?', label(account), picked.slot),
    {
      modal: true,
      detail: [
        consequence,
        t('Aliases, stored logins and session history move with their accounts. Slot numbers used in commands or scripts (for example "cswap switch {0}") will then refer to a different account.', picked.slot),
      ].join('\n\n'),
    },
    proceed,
  );
  return choice === proceed ? { kind: 'move', slot: account.slot, targetSlot: picked.slot } : undefined;
}

async function operationFor(action: AccountActionId, account: Account, snapshot: AccountsSnapshot): Promise<ManageOperation | undefined> {
  switch (action) {
    case 'setAlias':
      return promptAlias(account);
    case 'removeAlias':
      return { kind: 'removeAlias', slot: account.slot };
    case 'disable':
      return confirmDisable(account, snapshot);
    case 'enable':
      return { kind: 'setDisabled', slot: account.slot, disabled: false };
    case 'setThreshold':
      return promptThreshold(account);
    case 'clearThreshold':
      return { kind: 'clearThreshold', slot: account.slot };
    case 'move':
      return promptMove(account, snapshot);
  }
}

function successText(operation: ManageOperation, account: Account): string {
  switch (operation.kind) {
    case 'setAlias':
      return t('Alias of slot {0} set to "{1}".', account.slot, operation.alias);
    case 'removeAlias':
      return t('Alias of slot {0} removed.', account.slot);
    case 'setDisabled':
      return operation.disabled ? t('Slot {0} is now held out of rotation.', account.slot) : t('Slot {0} is back in rotation.', account.slot);
    case 'setThreshold':
      return t('Switch threshold of slot {0} set to {1}.', account.slot, formatPercent(operation.threshold));
    case 'clearThreshold':
      return t('Slot {0} now uses the global switch threshold.', account.slot);
    case 'move':
      return t('{0} is now in slot {1}.', accountName(account, t), operation.targetSlot);
  }
}

function reportBusy(): void {
  void vscode.window.showInformationMessage(t('Another cswap operation is in progress. Try again when it finishes.'));
}

function report(deps: ManageFlowDependencies, operation: ManageOperation, account: Account, outcome: ManageOutcome): void {
  switch (outcome.kind) {
    case 'busy':
      reportBusy();
      return;
    case 'rejected':
      void vscode.window.showErrorMessage(
        outcome.reason === 'account-changed'
          ? t('The account in that slot changed after you confirmed. Nothing was changed; check the list and try again.')
          : t('That account is no longer listed by cswap. Refresh and try again.'),
      );
      return;
    case 'failed': {
      const detail = outcome.error.detail ? ` ${redactText(outcome.error.detail, { homeDir: deps.homeDir })}` : '';
      void vscode.window.showErrorMessage(neutralizeLinks(`${describeCliError(outcome.error)}${detail}`));
      return;
    }
    case 'applied':
      if (outcome.verification === 'confirmed') {
        void vscode.window.showInformationMessage(neutralizeLinks(sanitizeLabel(`Cswap: ${successText(operation, account)}`)));
      } else if (outcome.verification === 'mismatch') {
        void vscode.window.showWarningMessage(t('cswap reported success, but the refreshed account list does not show the change.'));
      } else {
        void vscode.window.showWarningMessage(
          t('cswap reported success, but the result could not be verified: {0}', outcome.refreshError ? describeCliError(outcome.refreshError) : t('unknown')),
        );
      }
      return;
  }
}

/** Prompts for an action's input/confirmation, applies it through cswap and reports the verified result. */
export async function runAccountAction(deps: ManageFlowDependencies, action: AccountActionId | undefined, slot?: number): Promise<ManageOutcome | undefined> {
  if (deps.gate.isBusy()) {
    reportBusy();
    return { kind: 'busy' };
  }
  const snapshot = await snapshotOrRefresh(deps);
  if (snapshot === undefined) {
    return undefined;
  }
  const account = slot === undefined ? await pickAccount(snapshot, t('Manage a Cswap account')) : snapshot.accounts.find((candidate) => candidate.slot === slot);
  if (account === undefined) {
    if (slot !== undefined) {
      void vscode.window.showErrorMessage(t('That account is no longer listed by cswap. Refresh and try again.'));
    }
    return undefined;
  }
  let chosen = action;
  if (chosen === undefined) {
    const picked = await vscode.window.showQuickPick(
      availableActions(account).map((id) => ({ label: actionLabel(id, t), id })),
      { title: t('Manage {0}', label(account)) },
    );
    chosen = picked?.id;
  }
  if (chosen === undefined || !availableActions(account).includes(chosen)) {
    return undefined;
  }
  const operation = await operationFor(chosen, account, snapshot);
  if (operation === undefined) {
    return undefined;
  }
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Cswap: updating {0}…', label(account)) },
    () => deps.managementService.apply(operation, snapshot),
  );
  report(deps, operation, account, outcome);
  return outcome;
}
