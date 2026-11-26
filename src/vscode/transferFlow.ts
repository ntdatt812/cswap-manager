import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CliOutcome, CswapCli } from '../core/cli/cswapCli';
import type { ExportResult } from '../core/cli/transfer';
import { slotLabel } from '../core/presentation/accountTree';
import { sanitizeLabel } from '../core/presentation/statusBar';
import { neutralizeLinks } from '../core/security/redact';
import type { OperationGate } from '../core/service/operationGate';
import { sameAccountsAt } from '../core/service/managementService';
import type { RefreshService } from '../core/service/refreshService';
import { confirm } from './confirm';
import { errorReason, showBusy, showCliFailure } from './messages';
import { t } from './presentation';

export interface TransferDependencies {
  readonly cli: CswapCli;
  readonly gate: OperationGate;
  readonly refreshService: RefreshService;
  readonly homeDir: string;
}

const JSON_FILES = { JSON: ['json'] };

/** A file the user picked, on this computer: cswap gets its path. */
interface LocalFile {
  readonly uri: vscode.Uri;
  readonly fsPath: string;
}

function defaultFile(deps: TransferDependencies, prefix: string): vscode.Uri {
  return vscode.Uri.file(path.join(deps.homeDir, `${prefix}-${new Date().toISOString().slice(0, 10)}.json`));
}

function localFile(uri: vscode.Uri | undefined): LocalFile | undefined {
  if (uri === undefined) {
    return undefined;
  }
  if (uri.scheme !== 'file') {
    void vscode.window.showErrorMessage(t('Choose a file on this computer.'));
    return undefined;
  }
  return { uri, fsPath: uri.fsPath };
}

async function pickJsonToOpen(deps: TransferDependencies, title: string): Promise<LocalFile | undefined> {
  const picked = await vscode.window.showOpenDialog({ title, defaultUri: vscode.Uri.file(deps.homeDir), canSelectMany: false, filters: JSON_FILES, openLabel: t('Import') });
  return localFile(picked?.[0]);
}

/** A file of logins or account data inside the open project is easily committed or synced by mistake. */
async function pickJsonToSave(deps: TransferDependencies, title: string, prefix: string, saveLabel: string): Promise<LocalFile | undefined> {
  const file = localFile(await vscode.window.showSaveDialog({ title, defaultUri: defaultFile(deps, prefix), filters: JSON_FILES, saveLabel }));
  if (file === undefined || vscode.workspace.getWorkspaceFolder(file.uri) === undefined) {
    return file;
  }
  const saveAnyway = t('Save Here Anyway');
  const choice = await confirm(
    {
      question: t('This file would be inside the open project.'),
      detail: t('Files in a project folder are easily committed, synced or shared by mistake. A folder outside the project, such as your home folder, is safer.'),
      risky: true,
    },
    saveAnyway,
  );
  return choice === saveAnyway ? file : undefined;
}

/**
 * Runs a cswap command under the operation gate with a progress notification. Reports "busy" and
 * failures itself, so callers get only a successful value, or a refusal of their own (a string)
 * decided inside the gate.
 */
async function runGated<T, R extends string = never>(
  deps: TransferDependencies,
  title: string,
  task: () => Promise<CliOutcome<T> | NoInfer<R>>,
): Promise<T | R | undefined> {
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => deps.gate.run(task));
  if (result === undefined) {
    showBusy();
    return undefined;
  }
  if (typeof result === 'string') {
    return result;
  }
  if (!result.ok) {
    showCliFailure(result.error, deps.homeDir);
    return undefined;
  }
  return result.value;
}

/**
 * **Export Accounts to a File…** — `cswap export`. cswap writes the file with owner-only access; the
 * extension never opens it. Without `slot`, every account is exported.
 */
export async function exportAccounts(deps: TransferDependencies, slot?: number): Promise<void> {
  const confirmedWith = deps.refreshService.getState().snapshot;
  const account = slot === undefined ? undefined : confirmedWith?.accounts.find((candidate) => candidate.slot === slot);
  if (slot !== undefined && (confirmedWith === undefined || account === undefined)) {
    return;
  }
  const proceed = t('Choose Where to Save…');
  const choice = await confirm(
    {
      question: account === undefined ? t('Export the logins of all accounts to a file?') : t('Export the login of {0} to a file?', sanitizeLabel(slotLabel(account, t))),
      detail: t(
        'The file holds the logins in plain text: anyone who gets it can use these Claude accounts. Keep it private, copy it to the other computer only over a channel you trust, and delete it once it is imported there.',
      ),
      risky: true,
    },
    proceed,
  );
  if (choice !== proceed) {
    return;
  }
  const file = await pickJsonToSave(deps, t('Export accounts'), slot === undefined ? 'cswap-accounts' : `cswap-account-${slot}`, t('Export'));
  if (file === undefined) {
    return;
  }
  const result = await runGated<ExportResult, 'account-changed'>(deps, t('Cswap: exporting accounts…'), async () => {
    // The dialogs can stay open for long: a single account is exported only if its slot still
    // holds the account the user confirmed.
    if (slot !== undefined && confirmedWith !== undefined) {
      const fresh = await deps.refreshService.refresh({ trigger: 'manual', requireFresh: true });
      if (!fresh.ok) {
        return { ok: false as const, error: fresh.error, meta: { command: 'list' as const } };
      }
      if (!sameAccountsAt(confirmedWith, fresh.snapshot, [slot])) {
        return 'account-changed' as const;
      }
    }
    return deps.cli.exportAccounts(file.fsPath, slot);
  });
  if (result === undefined) {
    return;
  }
  if (result === 'account-changed') {
    void vscode.window.showWarningMessage(t('Slot {0} holds a different account than when you confirmed; nothing was exported.', slot ?? ''));
    return;
  }
  const text = [
    t('Exported {0} account(s) to {1}.', result.exported, path.basename(file.fsPath)),
    ...(result.skipped > 0 ? [t('{0} account(s) were left out: cswap has no stored login for them.', result.skipped)] : []),
  ].join(' ');
  const reveal = t('Show File');
  void vscode.window.showInformationMessage(neutralizeLinks(sanitizeLabel(text)), reveal).then((choice) => {
    if (choice === reveal) {
      void vscode.commands.executeCommand('revealFileInOS', file.uri);
    }
  });
}

/** **Import Accounts from a File…** — `cswap import`, confirmed first; replacing existing accounts is a separate choice. */
export async function importAccounts(deps: TransferDependencies): Promise<void> {
  const file = await pickJsonToOpen(deps, t('Import accounts from a cswap export file'));
  if (file === undefined) {
    return;
  }
  const keep = t('Import');
  const replace = t('Import and Replace Existing');
  const choice = await confirm(
    {
      question: sanitizeLabel(t('Import the accounts in {0}?', path.basename(file.fsPath))),
      detail: t(
        'cswap adds the accounts in this file to this computer. Accounts that are already here stay as they are, unless you choose to replace them: that overwrites their stored login with the one in the file, which may be older. Import only files you exported yourself.',
      ),
      risky: true,
    },
    keep,
    replace,
  );
  if (choice === undefined) {
    return;
  }
  const replaceExisting = choice === replace;
  const result = await runGated(deps, t('Cswap: importing accounts…'), () => deps.cli.importAccounts(file.fsPath, replaceExisting));
  if (result === undefined) {
    return;
  }
  void deps.refreshService.refresh({ trigger: 'manual', requireFresh: true, verifyActive: true });
  const { imported, overwritten, replaced, skipped, liveSlot } = result;
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
  // The file lists every account's email and organization ID, so it is kept out of the project too.
  const file = await pickJsonToSave(deps, t('Save usage readings for another computer'), 'cswap-usage', t('Save'));
  if (file === undefined) {
    return;
  }
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Cswap: reading usage…') }, () => deps.cli.usageDocument());
  if (!result.ok) {
    showCliFailure(result.error, deps.homeDir);
    return;
  }
  try {
    await vscode.workspace.fs.writeFile(file.uri, Buffer.from(result.value, 'utf8'));
  } catch (error) {
    void vscode.window.showErrorMessage(neutralizeLinks(t('Could not save the file: {0}', errorReason(error, deps.homeDir))));
    return;
  }
  void vscode.window.showInformationMessage(
    neutralizeLinks(
      sanitizeLabel(t('Saved usage readings to {0} (emails and usage; no logins). On the other computer, use "Import Usage Readings from Another Computer…".', path.basename(file.fsPath))),
    ),
  );
}

/** **Import Usage Readings from Another Computer…** — `cswap import-usage`, with an optional pause of local fetching. */
export async function importUsage(deps: TransferDependencies): Promise<void> {
  const file = await pickJsonToOpen(deps, t('Import usage readings from another computer'));
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
    title: t('Usage readings from {0}', sanitizeLabel(path.basename(file.fsPath))),
    placeHolder: t('While fetching is paused, this computer shows the imported readings and does not ask Anthropic about those accounts.'),
  });
  if (hold === undefined) {
    return;
  }
  const result = await runGated(deps, t('Cswap: importing usage readings…'), () => deps.cli.importUsage(file.fsPath, hold.hold));
  if (result === undefined) {
    return;
  }
  void deps.refreshService.refresh({ trigger: 'manual', requireFresh: true });
  void vscode.window.showInformationMessage(t('Usage readings: {0} used, {1} kept (this computer had newer ones), {2} skipped.', result.adopted, result.kept, result.skipped));
}
