import * as vscode from 'vscode';
import type { CliError } from '../core/cli/cliErrors';
import { buildAccountNodes, describeView, visibleAccounts, type NodeModel } from '../core/presentation/accountTree';
import { assessFreshness, type RefreshService } from '../core/service/refreshService';
import { AccountsTreeProvider } from './accountsTreeProvider';
import type { AutoRefreshController } from './autoRefresh';
import { CONFIG_SECTION, type ExtensionConfiguration } from './configuration';
import { CLOCK_TICK_MS, presentationOptions, t } from './presentation';

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
  private progressDone: (() => void) | undefined;

  constructor(private readonly deps: AccountsViewDependencies) {
    this.treeView = vscode.window.createTreeView(ACCOUNTS_VIEW_ID, { treeDataProvider: this.provider, showCollapseAll: true });
    this.disposables.push(
      this.treeView,
      this.provider,
      deps.refreshService.onDidChange((state) => {
        this.updateProgress(state.refreshing);
        this.render();
      }),
      this.treeView.onDidChangeVisibility(() => this.onVisibilityChanged()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(`${CONFIG_SECTION}.sidebar.sortOrder`) ||
          event.affectsConfiguration(`${CONFIG_SECTION}.display`)
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
    this.progressDone?.();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private onVisibilityChanged(): void {
    const visible = this.treeView.visible;
    this.deps.autoRefresh.setConsumer('accountsView', visible);
    if (visible) {
      this.clock ??= setInterval(() => this.render(), CLOCK_TICK_MS);
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
    const { refreshService, configuration, describeError } = this.deps;
    const state = refreshService.getState();
    const options = presentationOptions(configuration);
    const sortOrder = configuration.sortOrder();
    const snapshot = state.snapshot;
    const filter = this.filter === undefined ? {} : { filter: this.filter };
    const nodes = snapshot ? buildAccountNodes(snapshot, { ...options, sortOrder, ...filter }) : [];
    const presentation = describeView(state, {
      now: options.now,
      t,
      freshness: assessFreshness(state, options.now, configuration.staleAfterMs()),
      visibleCount: snapshot ? visibleAccounts(snapshot, sortOrder, this.filter).length : 0,
      describeError,
      ...filter,
    });

    this.provider.setNodes(nodes);
    this.treeView.description = presentation.description;
    this.treeView.message = presentation.message;
    void vscode.commands.executeCommand('setContext', 'cswapManager.viewState', presentation.state);
  }
}
