import * as vscode from 'vscode';
import { RefreshScheduler, type RefreshSchedule } from '../core/service/refreshScheduler';
import type { RefreshService } from '../core/service/refreshService';
import { CONFIG_SECTION, type ExtensionConfiguration } from './configuration';

export type RefreshConsumer = 'accountsView' | 'statusBar' | 'dashboard';

/**
 * Runs the periodic refresh while at least one consumer needs data (the Accounts view is visible
 * or the status bar item is shown) and this window is focused, so background windows do not poll.
 */
export class AutoRefreshController implements vscode.Disposable {
  private readonly consumers = new Set<RefreshConsumer>();
  private readonly scheduler: RefreshScheduler;
  private readonly scheduleChanged = new vscode.EventEmitter<void>();
  /** The next automatic refresh moved (scheduled, started, paused or turned off). */
  readonly onDidChangeSchedule = this.scheduleChanged.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly refreshService: RefreshService,
    private readonly configuration: ExtensionConfiguration,
  ) {
    this.scheduler = new RefreshScheduler({
      tick: () => refreshService.refresh({ trigger: 'interval' }),
      lastRefreshAt: () => refreshService.getState().lastAttemptAt,
      onChange: () => this.scheduleChanged.fire(),
    });
    this.scheduler.configure(configuration.refreshIntervalMs());
    this.disposables.push(
      this.scheduler,
      this.scheduleChanged,
      refreshService.onDidChange((state) => {
        if (!state.refreshing) {
          this.scheduler.reschedule();
        }
      }),
      vscode.window.onDidChangeWindowState(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${CONFIG_SECTION}.refreshIntervalSeconds`)) {
          this.scheduler.configure(this.configuration.refreshIntervalMs());
        }
      }),
    );
  }

  /** For the countdown to the next automatic refresh. */
  schedule(): RefreshSchedule {
    return this.scheduler.schedule();
  }

  setConsumer(consumer: RefreshConsumer, needsData: boolean): void {
    if (needsData) {
      this.consumers.add(consumer);
    } else {
      this.consumers.delete(consumer);
    }
    this.update();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private update(): void {
    const active = vscode.window.state.focused && this.consumers.size > 0;
    this.scheduler.setActive(active);
    // With automatic refresh off, still load once when data is first needed.
    const state = this.refreshService.getState();
    if (active && state.lastAttemptAt === undefined && !state.refreshing) {
      void this.refreshService.refresh({ trigger: 'activation' });
    }
  }
}
