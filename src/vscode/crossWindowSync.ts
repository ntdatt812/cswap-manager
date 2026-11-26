import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ACTIVE_SIGNAL_FILE, ActiveSlotTracker, parseActiveSignal, serializeActiveSignal, SignalReadTimer } from '../core/service/activeSignal';
import type { RefreshService } from '../core/service/refreshService';
import type { Logger } from './logger';

/**
 * Keeps every VS Code window on the same active account. When a refresh here shows a different
 * active slot (after a switch, an auto-switch tick, or a change made in a terminal), this window
 * writes a small signal into the extension's global storage, which all windows share; the other
 * windows watch it and refresh instead of waiting until they are focused again (timing:
 * `signalReadDelay`).
 */
export class CrossWindowSync implements vscode.Disposable {
  /** Path of the shared signal file (exposed for extension-host tests). */
  readonly file: string;
  private readonly tracker: ActiveSlotTracker;
  private readonly disposables: vscode.Disposable[] = [];
  private lastCapturedAt: number | undefined;
  private readonly reads = new SignalReadTimer(() => void this.read());

  constructor(
    storage: vscode.Uri,
    private readonly refreshService: RefreshService,
    private readonly logger: Logger,
    origin: string = vscode.env.sessionId,
  ) {
    this.tracker = new ActiveSlotTracker(origin);
    this.file = path.join(storage.fsPath, ACTIVE_SIGNAL_FILE);
    try {
      // The watcher needs the folder to exist.
      fsSync.mkdirSync(storage.fsPath, { recursive: true });
    } catch (error) {
      this.logger.warn(`Cross-window sync: storage folder unavailable (${error instanceof Error ? error.name : 'error'}).`);
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(storage, ACTIVE_SIGNAL_FILE));
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.reads.signalChanged(vscode.window.state.focused)),
      watcher.onDidChange(() => this.reads.signalChanged(vscode.window.state.focused)),
      vscode.window.onDidChangeWindowState((state) => this.reads.focusChanged(state.focused)),
      refreshService.onDidChange((state) => {
        const snapshot = state.snapshot;
        // Each fresh snapshot once; a failed refresh keeps the old snapshot and is skipped.
        if (state.refreshing || snapshot === undefined || snapshot.capturedAt === this.lastCapturedAt) {
          return;
        }
        this.lastCapturedAt = snapshot.capturedAt;
        const signal = this.tracker.observe(snapshot.active.slot, Date.now());
        if (signal !== undefined) {
          void this.write(serializeActiveSignal(signal));
        }
      }),
    );
  }

  dispose(): void {
    this.reads.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async write(content: string): Promise<void> {
    try {
      await fs.writeFile(this.file, content, 'utf8');
    } catch (error) {
      this.logger.warn(`Cross-window sync: could not write the signal (${error instanceof Error ? error.name : 'error'}).`);
    }
  }

  private async read(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch {
      return;
    }
    const signal = parseActiveSignal(text);
    if (signal === undefined) {
      return;
    }
    // Runs already under way or queued (the catch-up on focus, a poll) may show the new account:
    // let them finish rather than queue another cswap run behind them.
    await this.refreshService.whenIdle();
    if (this.tracker.shouldRefresh(signal)) {
      this.logger.info('Another window reports a different active account; refreshing.');
      await this.refreshService.refresh({ trigger: 'external', requireFresh: true });
    }
  }
}
