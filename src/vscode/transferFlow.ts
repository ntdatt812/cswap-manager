import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CliError } from '../core/cli/cliErrors';
import type { CswapCli } from '../core/cli/cswapCli';
import { accountName } from '../core/presentation/accountTree';
import { sanitizeLabel } from '../core/presentation/statusBar';
import { neutralizeLinks, redactText } from '../core/security/redact';
import type { OperationGate } from '../core/service/operationGate';
import { sameAccountsAt } from '../core/service/managementService';
import type { RefreshService } from '../core/service/refreshService';
import { describeCliError } from './messages';
import { t } from './presentation';

export interface TransferDependencies {
  readonly cli: CswapCli;
  readonly gate: OperationGate;
  readonly refreshService: RefreshService;
  readonly homeDir: string;
}

const JSON_FILES = { JSON: ['json'] };

function defaultFile(deps: TransferDependencies, prefix: string): vscode.Uri {
  return vscode.Uri.file(path.join(deps.homeDir, `${prefix}-${new Date().toISOString().slice(0, 10)}.json`));
}

function showBusy(): void {
  void vscode.window.showInformationMessage(t('Another cswap operation is in progress. Try again when it finishes.'));
}

function showFailure(deps: TransferDependencies, error: CliError): void {
  const detail = error.detail ? ` (${redactText(error.detail, { homeDir: deps.homeDir })})` : '';
  void vscode.window.showErrorMessage(neutralizeLinks(`${describeCliError(error)}${detail}`));
}

/** Only local files: cswap gets a path on this computer. */
function localPath(uri: vscode.Uri | undefined): string | undefined {
  if (uri === undefined) {
    return undefined;
  }
  if (uri.scheme !== 'file') {
    void vscode.window.showErrorMessage(t('Choose a file on this computer.'));
    return undefined;
  }
  return uri.fsPath;
}

/** A file of logins inside the open project is easily committed or synced by mistake. */
async function confirmOutsideProject(target: vscode.Uri): Promise<boolean> {
  if (vscode.workspace.getWorkspaceFolder(target) === undefined) {
    return true;
  }
  const saveAnyway = t('Save Here Anyway');
  const choice = await vscode.window.showWarningMessage(
    t('This file would be inside the open project.'),
    { modal: true, detail: t('Files in a project folder are easily committed, synced or shared by mistake. A folder outside the project, such as your home folder, is safer.') },
    saveAnyway,
  );
  return choice === saveAnyway;
}

/**
 * **Export Accounts to a File…** — `cswap export`. cswap writes the file with owner-only access; the
 * extension never opens it. Without `slot`, every account is exported.
 */
export async function exportAccounts(deps: TransferDependencies, slot?: number): Promise<void> {
  const confirmedWith = deps.refreshService.getState().snapshot;
  const account = slot === undefined ? undefined : confirmedWith?.accounts.find((candidate) => candidate.slot === slot);
  if (slot !== undefined && account === undefined) {
    return;
  }
  const proceed = t('Choose Where to Save…');
  const question =
    slot === undefined
      ? t('Export the logins of all accounts to a file?')
      : t('Export the login of {0} to a file?', sanitizeLabel(account === undefined ? `#${slot}` : `#${slot} ${accountName(account, t)}`));
  const confirm = await vscode.window.showWarningMessage(
    question,
    {
      modal: true,
      detail: t(
        'The file holds the logins in plain text: anyone who gets it can use these Claude accounts. Keep it private, copy it to the other computer only over a channel you trust, and delete it once it is imported there.',
      ),
    },
    proceed,
  );
  if (confirm !== proceed) {
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: t('Export accounts'),
    defaultUri: defaultFile(deps, slot === undefined ? 'cswap-accounts' : `cswap-account-${slot}`),
    filters: JSON_FILES,
    saveLabel: t('Export'),
  });
  const file = localPath(target);
  if (target === undefined || file === undefined || !(await confirmOutsideProject(target))) {
    return;
  }
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Cswap: exporting accounts…') }, () =>
    deps.gate.run(async () => {
      // The dialogs can stay open for long: a single account is exported only if its slot still
      // holds the account the user confirmed.
      if (slot !== undefined && confirmedWith !== undefined) {
        const fresh = await deps.refreshService.refresh({ trigger: 'manual', requireFresh: true });
        if (!fresh.ok) {
          return { ok: false as const, error: fresh.error };
        }
        if (!sameAccountsAt(confirmedWith, fresh.snapshot, [slot])) {
          return 'account-changed' as const;
        }
      }
      return deps.cli.exportAccounts(file, slot);
    }),
  );
  if (result === undefined) {
    showBusy();
    return;
  }
  if (result === 'account-changed') {
    void vscode.window.showWarningMessage(t('Slot {0} holds a different account than when you confirmed; nothing was exported.', slot ?? 0));
    return;
  }
  if (!result.ok) {
    showFailure(deps, result.error);
    return;
  }
  const { exported, skipped } = result.value;
  const text = [
    t('Exported {0} account(s) to {1}.', exported, path.basename(file)),
    ...(skipped > 0 ? [t('{0} account(s) were left out: cswap has no stored login for them.', skipped)] : []),
  ].join(' ');
  const reveal = t('Show File');
  void vscode.window.showInformationMessage(neutralizeLinks(sanitizeLabel(text)), reveal).then((choice) => {
    if (choice === reveal) {
      void vscode.commands.executeCommand('revealFileInOS', target);
    }
  });
}

/** **Import Accounts from a File…** — `cswap import`, confirmed first; replacing existing accounts is a separate choice. */
export async function importAccounts(deps: TransferDependencies): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: t('Import accounts from a cswap export file'),
    defaultUri: vscode.Uri.file(deps.homeDir),
    canSelectMany: false,
    filters: JSON_FILES,
    openLabel: t('Import'),
  });
  const file = localPath(picked?.[0]);
  if (file === undefined) {
    return;
  }
  const keep = t('Import');
  const replace = t('Import and Replace Existing');
  const choice = await vscode.window.showWarningMessage(
    sanitizeLabel(t('Import the accounts in {0}?', path.basename(file))),
    {
      modal: true,
      detail: t(
        'cswap adds the accounts in this file to this computer. Accounts that are already here stay as they are, unless you choose to replace them: that overwrites their stored login with the one in the file, which may be older. Import only files you exported yourself.',
      ),
    },
    keep,
    replace,
  );
  if (choice === undefined) {
    return;
  }
  const replaceExisting = choice === replace;
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Cswap: importing accounts…') }, () =>
    deps.gate.run(() => deps.cli.importAccounts(file, replaceExisting)),
  );
  if (result === undefined) {
    showBusy();
    return;
  }
  if (!result.ok) {
    showFailure(deps, result.error);
    return;
  }
  void deps.refreshService.refresh({ trigger: 'manual', requireFresh: true, verifyActive: true });
  const { imported, overwritten, replaced, skipped, liveSlot } = result.value;
  const text = [
    t('Import finished: {0} added, {1} replaced, {2} left as they were.', imported, overwritten + replaced, skipped),
    ...(skipped > 0 && !replaceExisting ? [t('To overwrite the accounts that are already here, import again and choose "Import and Replace Existing".')] : []),
  ].join(' ');
  void vscode.window.showInformationMessage(text);
  if (liveSlot !== undefined) {
    void vscode.window.showWarningMessage(
      t(
        'Slot {0} is the account Claude Code is logged in to now, so it keeps its current login, and cswap stores that login over the imported copy at the next switch. To use the imported login instead, run "cswap switch {0} --force" in a terminal.',
        liveSlot,
      ),
    );
  }
}

/** **Save Usage Readings for Another Computer…** — this computer's `cswap list --json`, as cswap printed it. */
export async function saveUsageReadings(deps: TransferDependencies): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    title: t('Save usage readings for another computer'),
    defaultUri: defaultFile(deps, 'cswap-usage'),
    filters: JSON_FILES,
    saveLabel: t('Save'),
  });
  // The file lists every account's email and organization ID, so it is kept out of the project too.
  if (localPath(target) === undefined || target === undefined || !(await confirmOutsideProject(target))) {
    return;
  }
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Cswap: reading usage…') }, () => deps.cli.usageDocument());
  if (!result.ok) {
    showFailure(deps, result.error);
    return;
  }
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(result.value, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? redactText(error.message, { homeDir: deps.homeDir }) : '';
    void vscode.window.showErrorMessage(neutralizeLinks(t('Could not save the file: {0}', reason)));
    return;
  }
  void vscode.window.showInformationMessage(
    neutralizeLinks(
      sanitizeLabel(t('Saved usage readings to {0} (emails and usage; no logins). On the other computer, use "Import Usage Readings from Another Computer…".', path.basename(target.fsPath))),
    ),
  );
}

/** **Import Usage Readings from Another Computer…** — `cswap import-usage`, with an optional pause of local fetching. */
export async function importUsage(deps: TransferDependencies): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: t('Import usage readings from another computer'),
    defaultUri: vscode.Uri.file(deps.homeDir),
    canSelectMany: false,
    filters: JSON_FILES,
    openLabel: t('Import'),
  });
  const file = localPath(picked?.[0]);
  if (file === undefined) {
    return;
  }
  type HoldItem = vscode.QuickPickItem & { readonly hold?: number };
  const items: HoldItem[] = [
    { label: t('Use the readings'), description: t('this computer keeps fetching as usual') },
    { label: t('Use the readings and pause fetching for 10 minutes'), hold: 600 },
    { label: t('Use the readings and pause fetching for 1 hour'), hold: 3600 },
    { label: t('Use the readings and resume fetching'), description: t('lifts an earlier pause'), hold: 0 },
  ];
  const hold = await vscode.window.showQuickPick(items, {
    title: t('Usage readings from {0}', sanitizeLabel(path.basename(file))),
    placeHolder: t('While fetching is paused, this computer shows the imported readings and does not ask Anthropic about those accounts.'),
  });
  if (hold === undefined) {
    return;
  }
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Cswap: importing usage readings…') }, () =>
    deps.gate.run(() => deps.cli.importUsage(file, hold.hold)),
  );
  if (result === undefined) {
    showBusy();
    return;
  }
  if (!result.ok) {
    showFailure(deps, result.error);
    return;
  }
  void deps.refreshService.refresh({ trigger: 'manual', requireFresh: true });
  const { adopted, kept, skipped } = result.value;
  void vscode.window.showInformationMessage(t('Usage readings: {0} used, {1} kept (this computer had newer ones), {2} skipped.', adopted, kept, skipped));
}
