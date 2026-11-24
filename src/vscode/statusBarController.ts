import * as vscode from 'vscode';
import type { CliError } from '../core/cli/cliErrors';
import { buildStatusBarModel } from '../core/presentation/statusBar';
import { assessFreshness, type RefreshService } from '../core/service/refreshService';
import type { SwitchService } from '../core/service/switchService';
import { renderTooltip } from './accountsTreeProvider';
import type { AutoRefreshController } from './autoRefresh';
import { CONFIG_SECTION, type ExtensionConfiguration } from './configuration';
import { CLOCK_TICK_MS, presentationOptions } from './presentation';

export interface StatusBarDependencies {
  readonly refreshService: RefreshService;
  readonly switchService: SwitchService;
  readonly configuration: ExtensionConfiguration;
  readonly autoRefresh: AutoRefreshController;
  readonly describeError: (error: CliError) => string;
}

const LEVEL_BACKGROUND: Partial<Record<string, string>> = {
  warning: 'statusBarItem.warningBackground',
  critical: 'statusBarItem.errorBackground',
};

/** The active-account status bar item; clicking it opens quick switch. */
export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private clock: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: StatusBarDependencies) {
    this.item = vscode.window.createStatusBarItem('cswapManager.status', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Cswap Manager';
    this.item.command = 'cswapManager.quickSwitch';
    this.disposables.push(
      this.item,
      deps.refreshService.onDidChange(() => this.render()),
      deps.switchService.onDidChangeSwitching(() => this.render()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          this.render();
        }
      }),
    );
    this.render();
  }

  dispose(): void {
    this.setClock(false);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private setClock(running: boolean): void {
    if (running) {
      this.clock ??= setInterval(() => this.render(), CLOCK_TICK_MS);
    } else if (this.clock !== undefined) {
      clearInterval(this.clock);
      this.clock = undefined;
    }
  }

  private render(): void {
    const { refreshService, switchService, configuration, describeError, autoRefresh } = this.deps;
    const mode = configuration.statusBarMode();
    const state = refreshService.getState();
    const options = presentationOptions(configuration);
    const model = buildStatusBarModel(state, {
      ...options,
      mode,
      freshness: assessFreshness(state, options.now, configuration.staleAfterMs()),
      switching: switchService.isSwitching(),
      describeError,
    });

    autoRefresh.setConsumer('statusBar', model !== undefined);
    this.setClock(model !== undefined);
    if (model === undefined) {
      this.item.hide();
      return;
    }
    this.item.text = model.text;
    this.item.tooltip = renderTooltip(model.tooltip);
    this.item.accessibilityInformation = { label: model.accessibilityLabel };
    const background = LEVEL_BACKGROUND[model.level];
    this.item.backgroundColor = background ? new vscode.ThemeColor(background) : undefined;
    this.item.show();
  }
}
