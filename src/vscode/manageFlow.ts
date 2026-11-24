import * as vscode from 'vscode';
import type { AccountActionId } from '../shared/dashboardProtocol';
import type { ManageOperation } from '../core/cli/cswapCli';
import { THRESHOLD_MAX, THRESHOLD_MIN, isValidSlot, normalizeAlias, parseThreshold, type AliasProblem } from '../core/model/accountPolicy';
import type { Account, AccountsSnapshot } from '../core/model/types';
import { actionLabel, availableActions } from '../core/presentation/accountActions';
import { accountName } from '../core/presentation/accountTree';
import { formatPercent } from '../core/presentation/format';
import { sanitizeLabel } from '../core/presentation/statusBar';
import { neutralizeLinks } from '../core/security/redact';
import type { ManageOutcome, ManagementService } from '../core/service/managementService';
import type { OperationGate } from '../core/service/operationGate';
import type { RefreshService } from '../core/service/refreshService';
import { DISPLAY_NAME_MAX, cleanDisplayName, displayNameKey } from '../core/model/displayNames';
import { PRIORITY_MAX, PRIORITY_MIN, parsePriority } from '../core/model/priorities';
import type { ExtensionConfiguration } from './configuration';
import { describeCliError, showBusy, showCliFailure } from './messages';
import { t } from './presentation';
import { showSaveFailed } from './settingErrors';
import { ACCOUNTS_VIEW_ID } from './accountsView';

export interface ManageFlowDependencies {
  readonly refreshService: RefreshService;
  readonly managementService: ManagementService;
  readonly gate: OperationGate;
  readonly configuration: ExtensionConfiguration;
  readonly homeDir: string;
}

/** Account names come from the CLI: strip icon syntax and link syntax before they reach any UI text. */
function label(account: Account): string {
  return neutralizeLinks(sanitizeLabel(t('slot {0} ({1})', account.slot, accountName(account, t))));
}

export function aliasProblemText(problem: AliasProblem): string {
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

/** Picks one of cswap's accounts; the active one is marked. */
export async function pickAccount(snapshot: AccountsSnapshot, title: string, placeHolder = t('Choose an account')): Promise<Account | undefined> {
  const picked = await vscode.window.showQuickPick(
    snapshot.accounts.map((account) => ({
      label: sanitizeLabel(`${account.slot} · ${accountName(account, t)}`),
      description: snapshot.active.slot === account.slot ? t('current') : undefined,
      account,
    })),
    { title, placeHolder },
  );
  return picked?.account;
}

async function promptDisplayName(deps: ManageFlowDependencies, account: Account): Promise<void> {
  if (displayNameKey(account) === undefined) {
    void vscode.window.showWarningMessage(t('This account has no email in cswap, so a display name cannot be attached to it.'));
    return;
  }
  const value = await vscode.window.showInputBox({
    title: t('Display name for {0}', label(account)),
    prompt: t('Shown instead of the alias or email in the sidebar, status bar and dashboard. Any text up to {0} characters; kept in VS Code only, never sent to cswap. Leave empty to remove.', DISPLAY_NAME_MAX),
    value: account.displayName ?? '',
    validateInput: (input) => (input.trim().length > DISPLAY_NAME_MAX ? t('Use at most {0} characters.', DISPLAY_NAME_MAX) : undefined),
  });
  if (value === undefined) {
    return;
  }
  try {
    await deps.configuration.setDisplayName(account, value);
  } catch (error) {
    showSaveFailed(error);
    return;
  }
  const cleaned = cleanDisplayName(value);
  vscode.window.setStatusBarMessage(
    neutralizeLinks(sanitizeLabel(cleaned === '' ? t('Display name of slot {0} removed.', account.slot) : t('Slot {0} is now shown as "{1}".', account.slot, cleaned))),
    5000,
  );
}

async function promptAlias(account: Account): Promise<ManageOperation | undefined> {
  const value = await vscode.window.showInputBox({
    title: t('Set alias for {0}', label(account)),
    prompt: t('A short name for commands such as "cswap switch work". cswap stores it in lower case, using only a–z, 0–9, "-", "_" and ".". For capitals, spaces or accents, use "Set display name…".'),
    value: account.alias ?? '',
    validateInput: (input): string | vscode.InputBoxValidationMessage | undefined => {
      const result = normalizeAlias(input);
      if (!result.ok) {
        return aliasProblemText(result.problem);
      }
      // Say up front what cswap will actually store.
      return result.value === input.trim()
        ? undefined
        : { message: t('Will be saved as "{0}".', result.value), severity: vscode.InputBoxValidationSeverity.Info };
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
  return picked === undefined ? undefined : confirmMove(account, picked.slot, snapshot);
}

/** "Move to slot…" confirms in a modal; drag and drop offers Undo instead (`runDropMove`). */
async function confirmMove(account: Account, targetSlot: number, snapshot: AccountsSnapshot): Promise<ManageOperation | undefined> {
  const occupant = snapshot.accounts.find((candidate) => candidate.slot === targetSlot);
  const consequence =
    occupant === undefined
      ? t('Slot {0} becomes free.', account.slot)
      : neutralizeLinks(sanitizeLabel(t('{0} moves to slot {1}.', accountName(occupant, t), account.slot)));
  const proceed = t('Move');
  const choice = await vscode.window.showWarningMessage(
    t('Move {0} to slot {1}?', label(account), targetSlot),
    {
      modal: true,
      detail: [
        consequence,
        t('Aliases, stored logins and session history move with their accounts. Slot numbers used in commands or scripts (for example "cswap switch {0}") will then refer to a different account.', targetSlot),
      ].join('\n\n'),
    },
    proceed,
  );
  return choice === proceed ? { kind: 'move', slot: account.slot, targetSlot } : undefined;
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
    case 'remove':
      return confirmRemove(account, snapshot);
    case 'setPriority':
      return promptPriority(account);
    case 'clearPriority':
      return { kind: 'clearPriority', slot: account.slot };
    case 'setDisplayName':
      // Handled before this point: a display name is a VS Code setting, not a cswap change.
      return undefined;
  }
}

async function confirmRemove(account: Account, snapshot: AccountsSnapshot): Promise<ManageOperation | undefined> {
  const active = snapshot.active.slot === account.slot;
  const remove = t('Remove');
  const choice = await vscode.window.showWarningMessage(
    t('Remove {0} from cswap?', label(account)),
    {
      modal: true,
      detail: [
        t('cswap deletes the login it stored for this account, its session profile and its folder mappings. Your Claude account itself is not affected; you can add it again later by logging in to it and using "Add Current Login".'),
        ...(active ? [t('This is the active account: Claude Code stays logged in to it, but cswap will no longer manage it.')] : []),
      ].join('\n\n'),
    },
    remove,
  );
  return choice === remove ? { kind: 'remove', slot: account.slot } : undefined;
}

async function promptPriority(account: Account): Promise<ManageOperation | undefined> {
  const value = await vscode.window.showInputBox({
    title: t('Priority for {0}', label(account)),
    prompt: t(
      'Higher tiers are used first by the auto-switch strategy "By account priority" ({0}–{1}; default 0). Other strategies ignore it.',
      PRIORITY_MIN,
      PRIORITY_MAX,
    ),
    value: account.priority === undefined ? '' : String(account.priority),
    validateInput: (input) => (parsePriority(input) === undefined ? t('Enter a whole number from {0} to {1}.', PRIORITY_MIN, PRIORITY_MAX) : undefined),
  });
  const priority = value === undefined ? undefined : parsePriority(value);
  return priority === undefined ? undefined : { kind: 'setPriority', slot: account.slot, priority };
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
    case 'setPriority':
      return t('Priority of slot {0} set to {1}.', account.slot, operation.priority);
    case 'clearPriority':
      return t('Priority of slot {0} reset to 0.', account.slot);
    case 'remove':
      return t('{0} was removed from cswap.', accountName(account, t));
    case 'move':
      return t('{0} is now in slot {1}.', accountName(account, t), operation.targetSlot);
  }
}

/** Reports a management outcome; a confirmed result can offer an Undo action. */
function report(deps: ManageFlowDependencies, operation: ManageOperation, account: Account, outcome: ManageOutcome, undo?: () => void): void {
  switch (outcome.kind) {
    case 'busy':
      showBusy();
      return;
    case 'rejected':
      void vscode.window.showErrorMessage(
        outcome.reason === 'account-changed'
          ? t('The account in that slot changed after you confirmed. Nothing was changed; check the list and try again.')
          : t('That account is no longer listed by cswap. Refresh and try again.'),
      );
      return;
    case 'failed':
      showCliFailure(outcome.error, deps.homeDir);
      return;
    case 'applied':
      if (outcome.verification === 'confirmed') {
        const text = neutralizeLinks(sanitizeLabel(`Cswap: ${successText(operation, account)}`));
        if (undo === undefined) {
          void vscode.window.showInformationMessage(text);
        } else {
          const undoLabel = t('Undo');
          void vscode.window.showInformationMessage(text, undoLabel).then((choice) => {
            if (choice === undoLabel) {
              undo();
            }
          });
        }
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
    showBusy();
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
  if (chosen === 'setDisplayName') {
    // Not a cswap change: stored in VS Code settings only.
    await promptDisplayName(deps, account);
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

/**
 * Drag and drop in the Accounts view: the dragged account takes the slot of the account it was
 * dropped on, and the two trade places (`cswap move`). A drop is a deliberate gesture and a swap is
 * undone by swapping back, so instead of a modal the result offers **Undo**; progress shows in the
 * view itself. The move is re-checked and verified like "Move to slot…", and Undo only runs while
 * both slots still hold what the move left there.
 */
export async function runDropMove(deps: ManageFlowDependencies, slot: number, targetSlot: number, undoing = false): Promise<ManageOutcome | undefined> {
  if (!isValidSlot(slot) || !isValidSlot(targetSlot) || slot === targetSlot) {
    return undefined;
  }
  if (deps.gate.isBusy()) {
    showBusy();
    return { kind: 'busy' };
  }
  const snapshot = await snapshotOrRefresh(deps);
  if (snapshot === undefined) {
    return undefined;
  }
  const account = snapshot.accounts.find((candidate) => candidate.slot === slot);
  if (account === undefined) {
    void vscode.window.showErrorMessage(t('That account is no longer listed by cswap. Refresh and try again.'));
    return undefined;
  }
  const operation: ManageOperation = { kind: 'move', slot, targetSlot };
  const outcome = await vscode.window.withProgress({ location: { viewId: ACCOUNTS_VIEW_ID } }, () => deps.managementService.apply(operation, snapshot));
  // The dragged account now sits in targetSlot; moving it back undoes the move (a swap swaps again),
  // and the re-check against the state after this move refuses if anything changed in between.
  report(deps, operation, account, outcome, undoing ? undefined : () => void runDropMove(deps, targetSlot, slot, true));
  return outcome;
}
