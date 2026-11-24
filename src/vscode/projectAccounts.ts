import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { CswapCli } from '../core/cli/cswapCli';
import type { CachedExecutableResolver } from '../core/cli/executableResolver';
import { mappingFor, ownMapping, type MappingEntry } from '../core/model/mappings';
import type { Account } from '../core/model/types';
import { accountName, slotLabel } from '../core/presentation/accountTree';
import { sanitizeLabel } from '../core/presentation/statusBar';
import { neutralizeLinks } from '../core/security/redact';
import type { OperationGate } from '../core/service/operationGate';
import type { RefreshService } from '../core/service/refreshService';
import type { Logger } from './logger';
import { pickAccount } from './manageFlow';
import { showBusy, showCliFailure } from './messages';
import { t } from './presentation';
import { createGuardedTerminal } from './terminals';

export interface ProjectAccountDependencies {
  readonly cli: CswapCli;
  readonly resolver: CachedExecutableResolver;
  readonly refreshService: RefreshService;
  readonly gate: OperationGate;
  readonly logger: Logger;
  readonly homeDir: string;
}

/** What Quick Settings shows for the open project. */
export interface ProjectMapping {
  readonly folderName: string;
  /** Mapped slot; undefined when the folder has no account. */
  readonly slot?: number;
  /** True while `cswap map` has not been read successfully: the mapping is unknown, not absent. */
  readonly unknown?: boolean;
}

/**
 * Per-project accounts with cswap's own `map` and `run`: a folder can be mapped to an account, and
 * `cswap run` starts Claude Code in a terminal with that account only. The global login is not
 * switched, so other windows and sessions keep running untouched.
 */
export class ProjectAccounts {
  private entries: readonly MappingEntry[] | undefined;
  private readonly resolved = new Map<string, string>();

  constructor(private readonly deps: ProjectAccountDependencies) {}

  /** Reads `cswap map` (on demand, e.g. when Quick Settings opens); keeps the last good list when that fails. */
  async load(): Promise<readonly MappingEntry[] | undefined> {
    return (await this.readFresh()) ?? this.entries;
  }

  /** The account mapped to the first workspace folder, from the last read. */
  currentMapping(): ProjectMapping | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) {
      return undefined;
    }
    if (this.entries === undefined) {
      return { folderName: folder.name, unknown: true };
    }
    const entry = mappingFor(this.resolvedPath(folder), this.entries);
    return { folderName: folder.name, ...(entry?.slot === undefined ? {} : { slot: entry.slot }) };
  }

  /** Opens a terminal whose process is `cswap run <slot>`: Claude Code as that account, here only. */
  async openClaude(slot?: number): Promise<void> {
    const snapshot = this.deps.refreshService.getState().snapshot;
    const account =
      slot === undefined
        ? snapshot === undefined
          ? undefined
          : await pickAccount(snapshot, t('Open Claude Code as…'), t('Claude Code starts in a new terminal with this account; the account used elsewhere does not change.'))
        : this.account(slot);
    if (account === undefined) {
      return;
    }
    await this.startRun(['run', String(account.slot)], t('Claude · {0}', sanitizeLabel(slotLabel(account, t))));
  }

  /** Opens Claude Code with the account mapped to this project (a bare `cswap run` in the folder). */
  async openClaudeForProject(): Promise<void> {
    const folder = await this.pickFolder();
    if (folder === undefined) {
      return;
    }
    const entries = await this.readFresh();
    if (entries === undefined) {
      void vscode.window.showErrorMessage(t('cswap map could not be read; try again or check Cswap: Show Diagnostics.'));
      return;
    }
    const entry = mappingFor(this.resolvedPath(folder), entries);
    if (entry?.slot === undefined) {
      const assign = t('Assign an account…');
      const choice = await vscode.window.showInformationMessage(t('No account is assigned to {0} yet.', folder.name), assign);
      if (choice === assign) {
        await this.assign(undefined, folder);
      }
      return;
    }
    const account = this.account(entry.slot);
    await this.startRun(['run'], t('Claude · {0}', sanitizeLabel(account === undefined ? `#${entry.slot}` : slotLabel(account, t))), folder);
  }

  /** Maps (or unmaps) a project folder to an account with `cswap map/unmap`, then reads it back. */
  async assign(slot?: number, chosenFolder?: vscode.WorkspaceFolder): Promise<void> {
    const folder = chosenFolder ?? (await this.pickFolder());
    if (folder === undefined) {
      return;
    }
    const path = this.resolvedPath(folder);
    const target = slot ?? (await this.pickMappingTarget(folder, path));
    if (target === undefined) {
      return;
    }
    const slotToMap = target === 'clear' ? undefined : target;
    const result = await this.deps.gate.run(() => this.deps.cli.setMapping(path, slotToMap));
    if (result === undefined) {
      showBusy();
      return;
    }
    if (!result.ok) {
      showCliFailure(result.error, this.deps.homeDir);
      return;
    }
    // Verified against a fresh read only; the cached list would prove nothing. After unmapping, a
    // parent folder's mapping may still apply, so only this folder's own entry must be gone.
    const after = await this.readFresh();
    const confirmed = after !== undefined && (slotToMap === undefined ? ownMapping(path, after) === undefined : mappingFor(path, after)?.slot === slotToMap);
    const text =
      slotToMap === undefined ? t('{0} no longer has its own account.', folder.name) : t('{0} now uses slot {1} for "Open Claude Code for this project".', folder.name, slotToMap);
    if (confirmed) {
      void vscode.window.showInformationMessage(neutralizeLinks(sanitizeLabel(text)));
    } else {
      void vscode.window.showWarningMessage(neutralizeLinks(sanitizeLabel(`${text} ${t('Reading the mappings back shows something else; check with cswap map.')}`)));
    }
  }

  /** The account for a folder, or "clear" to remove its own mapping; the current one is marked from the last read. */
  private async pickMappingTarget(folder: vscode.WorkspaceFolder, path: string): Promise<number | 'clear' | undefined> {
    const entries = this.entries ?? (await this.load());
    const current = entries === undefined ? undefined : mappingFor(path, entries);
    type Item = vscode.QuickPickItem & { readonly value: number | 'clear' };
    const items: Item[] = [
      ...(this.deps.refreshService.getState().snapshot?.accounts ?? []).map((account) => ({
        label: sanitizeLabel(`${account.slot} · ${accountName(account, t)}`),
        ...(current?.slot === account.slot ? { description: t('current') } : {}),
        value: account.slot,
      })),
      ...(current === undefined ? [] : [{ label: `$(close) ${t('Remove the assignment')}`, value: 'clear' as const }]),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Account for {0}', folder.name),
      placeHolder: t('"Open Claude Code for this project" will use this account in this folder only; other windows keep theirs.'),
    });
    return picked?.value;
  }

  /** `cswap map` now; undefined when it cannot be read (the cache is updated only on success). */
  private async readFresh(): Promise<readonly MappingEntry[] | undefined> {
    const read = await this.deps.cli.mappings();
    if (!read.ok) {
      this.deps.logger.warn(`cswap map could not be read (${read.error.kind}).`);
      return undefined;
    }
    this.entries = read.value;
    return read.value;
  }

  /**
   * The folder as cswap stores it: cswap resolves symlinks, junctions and substituted drives
   * (`Path.resolve()`), so the extension compares and passes the resolved path too. Resolved once
   * per folder, since Quick Settings asks on every render.
   */
  private resolvedPath(folder: vscode.WorkspaceFolder): string {
    const key = folder.uri.toString();
    let resolved = this.resolved.get(key);
    if (resolved === undefined) {
      try {
        resolved = fs.realpathSync.native(folder.uri.fsPath);
      } catch {
        resolved = folder.uri.fsPath;
      }
      this.resolved.set(key, resolved);
    }
    return resolved;
  }

  private account(slot: number): Account | undefined {
    return this.deps.refreshService.getState().snapshot?.accounts.find((candidate) => candidate.slot === slot);
  }

  private async pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showInformationMessage(t('Open a project folder first.'));
      return undefined;
    }
    if (folders.length === 1) {
      return folders[0];
    }
    return vscode.window.showWorkspaceFolderPick({ placeHolder: t('Choose the project folder') });
  }

  /**
   * The terminal's own process is cswap (no shell in between), so nothing is interpolated into a
   * command line: arguments are a fixed verb plus a validated slot number. Claude Code runs in the
   * project folder, so the folder must be trusted, and the guarded terminal keeps a `claude` program
   * placed in the project from being found instead of the real one (cswap uses `shutil.which`).
   */
  private async startRun(args: readonly string[], name: string, chosenFolder?: vscode.WorkspaceFolder): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      const manage = t('Manage Workspace Trust');
      const choice = await vscode.window.showWarningMessage(t('Claude Code is started in this folder, so the folder must be trusted first.'), manage);
      if (choice === manage) {
        void vscode.commands.executeCommand('workbench.trust.manage');
      }
      return;
    }
    const resolution = await this.deps.resolver.resolve();
    if (!resolution.ok) {
      void vscode.window.showErrorMessage(t('The cswap executable was not found. Check the cswap path in Cswap Settings.'));
      return;
    }
    const folder = chosenFolder ?? vscode.workspace.workspaceFolders?.[0];
    const terminal = createGuardedTerminal({
      name,
      shellPath: resolution.path,
      shellArgs: [...args],
      ...(folder === undefined ? {} : { cwd: this.resolvedPath(folder) }),
      iconPath: new vscode.ThemeIcon('account'),
    });
    terminal.show();
  }
}
