import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AccountsSnapshot } from '../core/model/types';
import {
  EMPTY_USAGE_HISTORY,
  USAGE_HISTORY_FILE,
  addReadings,
  parseUsageHistory,
  readingsFromSnapshot,
  serializeUsageHistory,
  type UsageHistory,
  type UsageReading,
} from '../core/model/usageHistory';
import type { RefreshService } from '../core/service/refreshService';
import { confirm } from './confirm';
import type { Logger } from './logger';
import { t } from './presentation';
import { onFocusedSnapshotChange } from './snapshotTransitions';

/**
 * New readings are written together this long after the first unsaved one (and when the window
 * closes): a refresh every two minutes does not rewrite the file every two minutes.
 */
const WRITE_DELAY_MS = 10 * 60_000;
/** Waits for a burst of file events (write + rename) to settle before reading. */
const RELOAD_DELAY_MS = 300;
/** A larger file is not history this extension wrote (the cap keeps it far smaller). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Readings kept for a later write when one fails. */
const MAX_PENDING = 500;

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'error';
}

/**
 * The usage history behind the dashboard's "Last 7 days" (`cswapManager.usageHistory`): after each
 * refresh the window in front adds one reading per account to a JSON file in the extension's global
 * storage, which every window on this computer shares. The file is read on first use, written a few
 * seconds after new readings (merged with what is on disk, since another window may have written it;
 * through a temporary file and a rename, so it is never half-written), and a damaged file is started
 * afresh. It holds account hashes, times and percentages: no email or other account data.
 */
export class UsageHistoryStore implements vscode.Disposable {
  /** Path of the history file (exposed for extension-host tests). */
  readonly file: string;
  private history: UsageHistory | undefined;
  private loading: Promise<void> | undefined;
  /** Readings not written yet. */
  private pending: UsageReading[] = [];
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  /** Bumped by `clear`, so a write that started before it does not bring the readings back. */
  private generation = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    storage: vscode.Uri,
    refreshService: RefreshService,
    private readonly logger: Logger,
    private readonly enabled: () => boolean,
  ) {
    this.file = path.join(storage.fsPath, USAGE_HISTORY_FILE);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(storage, USAGE_HISTORY_FILE));
    this.disposables.push(
      this.changed,
      watcher,
      watcher.onDidCreate(() => this.scheduleReload()),
      watcher.onDidChange(() => this.scheduleReload()),
      watcher.onDidDelete(() => this.scheduleReload()),
      onFocusedSnapshotChange(refreshService, (_previous, current) => this.record(current)),
    );
  }

  /** The history read so far; undefined until the file has been read (reading starts here). */
  current(): UsageHistory | undefined {
    void this.load();
    return this.history;
  }

  /** Adds the snapshot's readings (when recording is on). */
  record(snapshot: AccountsSnapshot): void {
    if (!this.enabled()) {
      return;
    }
    const readings = readingsFromSnapshot(snapshot, Date.now());
    if (readings.length === 0) {
      return;
    }
    const generation = this.generation;
    void this.load().then(() => {
      if (generation !== this.generation) {
        return;
      }
      const before = this.history ?? EMPTY_USAGE_HISTORY;
      const next = addReadings(before, readings, Date.now());
      if (next === before) {
        return;
      }
      this.history = next;
      this.pending = [...this.pending, ...readings].slice(-MAX_PENDING);
      this.scheduleWrite();
      this.changed.fire();
    });
  }

  /** Deletes every reading (the file too). */
  async clear(): Promise<void> {
    this.generation += 1;
    this.pending = [];
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    await this.writing;
    this.history = EMPTY_USAGE_HISTORY;
    this.loading = Promise.resolve();
    try {
      await fs.rm(this.file, { force: true });
    } finally {
      this.changed.fire();
    }
  }

  dispose(): void {
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    if (this.reloadTimer !== undefined) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    // The window is closing: readings not written yet are written now, synchronously.
    this.flushSync();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private load(): Promise<void> {
    this.loading ??= this.readFile().then((read) => {
      // Readings added while the file was being read are kept.
      this.history = addReadings(read, this.pending, Date.now());
      this.changed.fire();
    });
    return this.loading;
  }

  private async readFile(): Promise<UsageHistory> {
    let text: string;
    try {
      const stats = await fs.stat(this.file);
      if (stats.size > MAX_FILE_BYTES) {
        this.logger.warn('Usage history: the file is too large to be history; starting afresh.');
        return EMPTY_USAGE_HISTORY;
      }
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        this.logger.warn(`Usage history: the file could not be read (${errorCode(error)}).`);
      }
      return EMPTY_USAGE_HISTORY;
    }
    return this.parse(text);
  }

  private parse(text: string): UsageHistory {
    const parsed = parseUsageHistory(text, Date.now());
    if (parsed === undefined) {
      this.logger.warn('Usage history: the file is damaged; starting afresh.');
      return EMPTY_USAGE_HISTORY;
    }
    return parsed;
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== undefined) {
      return;
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.writing = this.writing.then(() => this.flush());
    }, WRITE_DELAY_MS);
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) {
      return;
    }
    const generation = this.generation;
    const readings = this.pending;
    this.pending = [];
    const temp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      // What another window wrote meanwhile is kept: the new readings are added to the file on disk.
      const merged = addReadings(await this.readFile(), readings, Date.now());
      if (generation !== this.generation) {
        return;
      }
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temp, serializeUsageHistory(merged), 'utf8');
      await renameWithRetry(temp, this.file);
      if (generation === this.generation) {
        this.history = addReadings(merged, this.pending, Date.now());
        this.changed.fire();
      }
    } catch (error) {
      this.logger.warn(`Usage history: could not save (${errorCode(error)}); will try again with the next reading.`);
      await fs.rm(temp, { force: true }).catch(() => undefined);
      if (generation === this.generation) {
        this.pending = [...readings, ...this.pending].slice(-MAX_PENDING);
      }
    }
  }

  private flushSync(): void {
    if (this.pending.length === 0) {
      return;
    }
    const temp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      let onDisk = EMPTY_USAGE_HISTORY;
      if (fsSync.existsSync(this.file) && fsSync.statSync(this.file).size <= MAX_FILE_BYTES) {
        onDisk = parseUsageHistory(fsSync.readFileSync(this.file, 'utf8'), Date.now()) ?? EMPTY_USAGE_HISTORY;
      }
      fsSync.mkdirSync(path.dirname(this.file), { recursive: true });
      fsSync.writeFileSync(temp, serializeUsageHistory(addReadings(onDisk, this.pending, Date.now())), 'utf8');
      fsSync.renameSync(temp, this.file);
      this.pending = [];
    } catch (error) {
      this.logger.warn(`Usage history: could not save on close (${errorCode(error)}).`);
      try {
        fsSync.rmSync(temp, { force: true });
      } catch {
        // Nothing more to do while closing.
      }
    }
  }

  /** Another window wrote (or cleared) the file: read it again, keeping readings not written yet. */
  private scheduleReload(): void {
    if (this.loading === undefined) {
      return;
    }
    if (this.reloadTimer !== undefined) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      const generation = this.generation;
      void this.readFile().then((read) => {
        if (generation === this.generation) {
          this.history = addReadings(read, this.pending, Date.now());
          this.changed.fire();
        }
      });
    }, RELOAD_DELAY_MS);
  }
}

/** On Windows a rename onto a file another window is reading can fail for a moment. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= 3 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

/** `Cswap: Clear Usage History`, after a modal confirmation. */
export async function clearUsageHistory(store: UsageHistoryStore): Promise<void> {
  const clear = t('Clear');
  const choice = await confirm(
    {
      question: t('Clear the usage history of every account?'),
      detail: t('The readings this computer recorded for the dashboard\'s "Last 7 days" are deleted. cswap and your accounts are not affected.'),
      risky: true,
    },
    clear,
  );
  if (choice !== clear) {
    return;
  }
  try {
    await store.clear();
  } catch {
    void vscode.window.showErrorMessage(t('The usage history could not be deleted. Try again in a moment.'));
    return;
  }
  void vscode.window.showInformationMessage(t('Usage history cleared.'));
}
