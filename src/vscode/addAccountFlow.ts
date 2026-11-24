import * as vscode from 'vscode';
import { normalizeAlias } from '../core/model/accountPolicy';
import { neutralizeLinks, redactText } from '../core/security/redact';
import type { ManagementService } from '../core/service/managementService';
import type { OperationGate } from '../core/service/operationGate';
import type { RefreshService } from '../core/service/refreshService';
import { describeCliError } from './messages';
import { t } from './presentation';

export interface AddAccountDependencies {
  readonly refreshService: RefreshService;
  readonly managementService: ManagementService;
  readonly gate: OperationGate;
  readonly homeDir: string;
}

/** Free slots: gaps first, then the next number after the highest slot. */
export function freeSlots(usedSlots: readonly number[], count = 5): number[] {
  const used = new Set(usedSlots);
  const free: number[] = [];
  for (let slot = 1; free.length < count; slot++) {
    if (!used.has(slot)) {
      free.push(slot);
    }
  }
  return free;
}

/**
 * **Cswap: Add Current Login…** — runs `cswap add` for the account Claude Code is logged in to now.
 * Only free slots are offered, so cswap never asks to overwrite another account.
 */
export async function runAddAccount(deps: AddAccountDependencies): Promise<void> {
  if (deps.gate.isBusy()) {
    void vscode.window.showInformationMessage(t('Another cswap operation is in progress. Try again when it finishes.'));
    return;
  }
  const fresh = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('Cswap: refreshing accounts…') }, () =>
    deps.refreshService.refresh({ trigger: 'manual', requireFresh: true, verifyActive: true }),
  );
  if (!fresh.ok) {
    void vscode.window.showErrorMessage(describeCliError(fresh.error));
    return;
  }
  const snapshot = fresh.snapshot;
  let options: { slot?: number; alias?: string } = {};

  if (snapshot.active.slot !== undefined) {
    const refreshLogin = t('Refresh stored login');
    const choice = await vscode.window.showInformationMessage(
      t('The current Claude Code login is already in cswap (slot {0}).', snapshot.active.slot),
      {
        modal: true,
        detail: t('To add another account, log in to it with /login in Claude Code first, then run this command again. You can also refresh the login cswap stored for slot {0}.', snapshot.active.slot),
      },
      refreshLogin,
    );
    if (choice !== refreshLogin) {
      return;
    }
  } else if (snapshot.active.activeUnmanaged === true) {
    const slots = freeSlots(snapshot.accounts.map((account) => account.slot));
    const picked = await vscode.window.showQuickPick(
      slots.map((slot, index) => ({ label: t('Slot {0}', slot), ...(index === 0 ? { description: t('first free slot') } : {}), slot })),
      { title: t('Add the current Claude Code login to cswap'), placeHolder: t('Choose a free slot') },
    );
    if (picked === undefined) {
      return;
    }
    const aliasInput = await vscode.window.showInputBox({
      title: t('Alias for slot {0} (optional)', picked.slot),
      prompt: t('A short name for commands such as "cswap switch work"; lower case a–z, 0–9, "-", "_" and ".". Leave empty to skip.'),
      validateInput: (input) => {
        if (input.trim() === '') {
          return undefined;
        }
        const alias = normalizeAlias(input);
        return alias.ok ? undefined : t('Use only letters, digits, "-", "_" and "." (stored in lower case).');
      },
    });
    if (aliasInput === undefined) {
      return;
    }
    const alias = aliasInput.trim() === '' ? undefined : normalizeAlias(aliasInput);
    const proceed = t('Add');
    const confirm = await vscode.window.showWarningMessage(
      t('Store the current Claude Code login in cswap slot {0}?', picked.slot),
      { modal: true, detail: t('cswap copies the login Claude Code uses right now, checks it with Anthropic, and makes it the active account in that slot.') },
      proceed,
    );
    if (confirm !== proceed) {
      return;
    }
    options = { slot: picked.slot, ...(alias?.ok === true ? { alias: alias.value } : {}) };
  } else {
    void vscode.window.showWarningMessage(t('No Claude Code login found. Log in with /login in Claude Code first, then try again.'));
    return;
  }

  const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Cswap: adding the current login…') }, () =>
    deps.managementService.addCurrent(options),
  );
  switch (outcome.kind) {
    case 'busy':
      void vscode.window.showInformationMessage(t('Another cswap operation is in progress. Try again when it finishes.'));
      return;
    case 'cancelled':
      void vscode.window.showWarningMessage(t('cswap did not add the account (it cancelled without changes).'));
      return;
    case 'failed': {
      const detail = outcome.error.detail ? ` (${redactText(outcome.error.detail, { homeDir: deps.homeDir })})` : '';
      void vscode.window.showErrorMessage(neutralizeLinks(`${t('cswap could not add the account: {0}', describeCliError(outcome.error))}${detail}`));
      return;
    }
    case 'added': {
      const text =
        outcome.result.kind === 'updated'
          ? t('Refreshed the stored login of slot {0}.', outcome.result.slot)
          : outcome.result.kind === 'moved'
            ? t('The current login moved to slot {0}.', outcome.result.slot)
            : t('Added the current login as slot {0}.', outcome.result.slot);
      if (outcome.verification === 'confirmed') {
        void vscode.window.showInformationMessage(text);
      } else {
        void vscode.window.showWarningMessage(`${text} ${t('The result could not be verified yet; refresh to check.')}`);
      }
      return;
    }
  }
}
