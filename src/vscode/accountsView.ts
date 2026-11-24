import * as vscode from 'vscode';
import type { CliError } from '../core/cli/cliErrors';
import { identityOf } from '../core/model/accountPolicy';
import { previewMove, resolveDropTarget, type DropTarget, type PendingMove } from '../core/presentation/accountDrag';
import { buildAccountNodes, describeView, visibleAccounts, type NodeModel } from '../core/presentation/accountTree';
import { sortOrderLabel } from '../core/presentation/quickSettings';
import type { ManageOutcome } from '../core/service/managementService';
import { assessFreshness, type RefreshService } from '../core/service/refreshService';
import { AccountsDragAndDrop, MOVE_ACCOUNT_TO_COMMAND } from './accountsDragAndDrop';
import { AccountsTreeProvider } from './accountsTreeProvider';
import type { AutoRefreshController } from './autoRefresh';
import { CONFIG_SECTION, type ExtensionConfiguration } from './configuration';
import { CLOCK_TICK_MS, COUNTDOWN_TICK_MS, presentationOptions, t } from './presentation';
import { showSaveFailed } from './settingErrors';

/** How long the slot numbers a move changed stay highlighted. */
const MOVED_HIGHLIGHT_MS = 4000;

export const ACCOUNTS_VIEW_ID = 'cswapManager.accounts';

export interface AccountsViewDependencies {
  readonly refreshService: RefreshService;
  readonly configuration: ExtensionConfiguration;
  readonly autoRefresh: AutoRefreshController;
  readonly describeError: (error: CliError) => string;
}

/** Owns the Accounts tree view: rendering, view states and filter state. */
export class AccountsView implements vscode.Disposable {
  readonly provider = new AccountsTreeProvider();
  private readonly treeView: vscode.TreeView<NodeModel>;
  private readonly disposables: vscode.Disposable[] = [];
  private filter: string | undefined;
  private clock: ReturnType<typeof setInterval> | undefined;
  /** Ticks every second while the view is visible, for the countdown to the next refresh. */
  private countdownClock: ReturnType<typeof setInterval> | undefined;
  private progressDone: (() => void) | undefined;
  /** A dropped move cswap is still running: shown at once. */
  private pending: PendingMove | undefined;
  private moved: ReadonlySet<number> = new Set();
  private movedTimer: ReturnType<typeof setTimeout> | undefined;
  private sortHintShown = false;
  private viewState: string | undefined;

  constructor(private readonly deps: AccountsViewDependencies) {
    this.treeView = vscode.window.createTreeView(ACCOUNTS_VIEW_ID, {
      treeDataProvider: this.provider,
      showCollapseAll: true,
      dragAndDropController: new AccountsDragAndDrop((move) => this.drop(move)),
    });
    this.disposables.push(
      this.treeView,
      this.provider,
      deps.refreshService.onDidChange((state) => {
        this.updateProgress(state.refreshing);
        this.render();
      }),
      this.treeView.onDidChangeVisibility(() => this.onVisibilityChanged()),
      deps.autoRefresh.onDidChangeSchedule(() => this.renderHeader()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(`${CONFIG_SECTION}.sidebar.sortOrder`) ||
          event.affectsConfiguration(`${CONFIG_SECTION}.display`) ||
          event.affectsConfiguration(`${CONFIG_SECTION}.language`)
        ) {
          this.render();
        }
      }),
    );
    this.render();
    this.onVisibilityChanged();
  }

  getFilter(): string | undefined {
    return this.filter;
  }

  setFilter(filter: string | undefined): void {
    const normalized = filter?.trim();
    this.filter = normalized ? normalized : undefined;
    void vscode.commands.executeCommand('setContext', 'cswapManager.filterActive', this.filter !== undefined);
    this.render();
  }

  dispose(): void {
    this.stopClock();
    clearTimeout(this.movedTimer);
    this.progressDone?.();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /**
   * A drop: the list shows the move at once while cswap runs it (the move flow re-checks, verifies
   * and offers Undo), then the two slot numbers stay highlighted for a moment.
   */
  private async drop(move: { readonly slot: number; readonly target: DropTarget }): Promise<void> {
    const snapshot = this.deps.refreshService.getState().snapshot;
    const dragged = snapshot?.accounts.find((account) => account.slot === move.slot);
    const targetSlot = snapshot === undefined ? undefined : resolveDropTarget(move.slot, move.target, snapshot.accounts.map((account) => account.slot));
    if (dragged === undefined || targetSlot === undefined) {
      return;
    }
    this.pending = { slot: move.slot, targetSlot, dragged: identityOf(dragged) };
    this.render();
    void this.offerSlotOrder();
    let outcome: ManageOutcome | undefined;
    try {
      outcome = await vscode.commands.executeCommand<ManageOutcome | undefined>(MOVE_ACCOUNT_TO_COMMAND, move.slot, targetSlot);
    } finally {
      this.pending = undefined;
    }
    if (outcome?.kind === 'applied' && outcome.verification === 'confirmed') {
      this.highlightMoved([move.slot, targetSlot]);
    } else {
      this.render();
    }
  }

  private highlightMoved(slots: readonly number[]): void {
    clearTimeout(this.movedTimer);
    this.moved = new Set(slots);
    this.movedTimer = setTimeout(() => {
      this.moved = new Set();
      this.render();
    }, MOVED_HIGHLIGHT_MS);
    this.render();
  }

  /** Sorted by anything but slot, rows keep their place after a move; say so once per session. */
  private async offerSlotOrder(): Promise<void> {
    const order = this.deps.configuration.sortOrder();
    if (this.sortHintShown || order === 'slot') {
      return;
    }
    this.sortHintShown = true;
    const bySlot = t('Sort by Slot');
    const choice = await vscode.window.showInformationMessage(
      t('The list is sorted by {0}, so rows keep their place after a move; only the slot numbers change.', sortOrderLabel(order, t)),
      bySlot,
    );
    if (choice === bySlot) {
      try {
        await this.deps.configuration.setSortOrder('slot');
      } catch (error) {
        showSaveFailed(error);
      }
    }
  }

  private onVisibilityChanged(): void {
    const visible = this.treeView.visible;
    this.deps.autoRefresh.setConsumer('accountsView', visible);
    if (visible) {
      this.clock ??= setInterval(() => this.render(), CLOCK_TICK_MS);
      this.countdownClock ??= setInterval(() => this.renderHeader(), COUNTDOWN_TICK_MS);
      this.render();
    } else {
      this.stopClock();
    }
  }

  private stopClock(): void {
    if (this.clock !== undefined) {
      clearInterval(this.clock);
      this.clock = undefined;
    }
    if (this.countdownClock !== undefined) {
      clearInterval(this.countdownClock);
      this.countdownClock = undefined;
    }
  }

  private updateProgress(refreshing: boolean): void {
    if (refreshing && this.progressDone === undefined) {
      void vscode.window.withProgress(
        { location: { viewId: ACCOUNTS_VIEW_ID } },
        () =>
          new Promise<void>((resolve) => {
            this.progressDone = resolve;
          }),
      );
    } else if (!refreshing && this.progressDone !== undefined) {
      this.progressDone();
      this.progressDone = undefined;
    }
  }

  private render(): void {
    const { refreshService, configuration } = this.deps;
    const state = refreshService.getState();
    const options = presentationOptions(configuration);
    const sortOrder = configuration.sortOrder();
    const snapshot = state.snapshot !== undefined && this.pending !== undefined ? previewMove(state.snapshot, this.pending) : state.snapshot;
    const filter = this.filter === undefined ? {} : { filter: this.filter };
    const nodes = snapshot ? buildAccountNodes(snapshot, { ...options, sortOrder, ...filter, highlightSlots: this.moved }) : [];
    this.provider.setNodes(nodes);
    this.renderHeader();
  }

  /** The view's description and message, which hold the countdown: cheap enough to run every second. */
  private renderHeader(): void {
    const { refreshService, configuration, describeError, autoRefresh } = this.deps;
    const state = refreshService.getState();
    const now = Date.now();
    const schedule = autoRefresh.schedule();
    const filter = this.filter === undefined ? {} : { filter: this.filter };
    const presentation = describeView(state, {
      now,
      t,
      freshness: assessFreshness(state, now, configuration.staleAfterMs()),
      visibleCount: state.snapshot ? visibleAccounts(state.snapshot, configuration.sortOrder(), this.filter).length : 0,
      describeError,
      ...filter,
      ...(schedule.kind === 'scheduled' ? { nextRefreshAt: schedule.at } : {}),
    });
    if (this.treeView.description !== presentation.description) {
      this.treeView.description = presentation.description;
    }
    if (this.treeView.message !== presentation.message) {
      this.treeView.message = presentation.message;
    }
    if (this.viewState !== presentation.state) {
      this.viewState = presentation.state;
      void vscode.commands.executeCommand('setContext', 'cswapManager.viewState', presentation.state);
    }
  }
}
