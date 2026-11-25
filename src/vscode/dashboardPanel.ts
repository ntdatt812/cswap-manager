import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostToWebview } from '../shared/dashboardProtocol';
import type { CliError } from '../core/cli/cliErrors';
import { buildDashboardModel } from '../core/presentation/dashboard';
import { assessFreshness, type RefreshService } from '../core/service/refreshService';
import type { AutoSwitchService } from '../core/service/autoSwitchService';
import type { ManagementService } from '../core/service/managementService';
import type { OperationGate } from '../core/service/operationGate';
import type { SwitchService } from '../core/service/switchService';
import { parseWebviewMessage } from '../core/webview/messages';
import type { AutoRefreshController } from './autoRefresh';
import { CONFIG_SECTION, type ExtensionConfiguration } from './configuration';
import type { Logger } from './logger';
import { currentLanguage, currentLocale } from './l10n';
import { CLOCK_TICK_MS, presentationOptions, t } from './presentation';
import { runAccountAction } from './manageFlow';
import { runSwitch } from './switchFlow';
import type { UsageHistoryStore } from './usageHistoryStore';

export interface DashboardDependencies {
  readonly extensionUri: vscode.Uri;
  readonly refreshService: RefreshService;
  readonly switchService: SwitchService;
  readonly managementService: ManagementService;
  readonly gate: OperationGate;
  readonly configuration: ExtensionConfiguration;
  readonly autoRefresh: AutoRefreshController;
  readonly logger: Logger;
  readonly homeDir: string;
  readonly describeError: (error: CliError) => string;
  /** Mode and cswap strategy for the overview card. */
  readonly autoSwitch: AutoSwitchService;
  /** Recorded readings for each account's "Last 7 days". */
  readonly usageHistory: UsageHistoryStore;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Static shell; all content is rendered by the bundled script from posted, host-built data. */
export function dashboardHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string, language: string): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'dashboard.js')).toString();
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'dashboard.css')).toString();
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="${escapeAttribute(language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttribute(style)}">
<title>${escapeAttribute(t('Cswap Dashboard'))}</title>
</head>
<body>
<main id="app" aria-busy="true"></main>
<script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(script)}"></script>
</body>
</html>`;
}

/** Singleton dashboard panel: posts host-built state and handles allow-listed webview requests. */
export class DashboardController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private clock: ReturnType<typeof setInterval> | undefined;
  private pendingSelection: number | undefined;

  constructor(private readonly deps: DashboardDependencies) {
    this.disposables.push(
      deps.refreshService.onDidChange(() => this.postState()),
      deps.switchService.onDidChangeSwitching(() => this.postState()),
      deps.gate.onDidChange(() => this.postState()),
      deps.autoSwitch.onDidChange(() => this.postState()),
      deps.autoRefresh.onDidChangeSchedule(() => this.postState()),
      deps.usageHistory.onDidChange(() => this.postState()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          this.postState();
        }
      }),
    );
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }

  show(slot?: number): void {
    if (slot !== undefined) {
      this.pendingSelection = slot;
    }
    if (this.panel) {
      // A hidden panel's webview reloads on reveal; its 'ready' message flushes the selection then.
      const wasVisible = this.panel.visible;
      this.panel.reveal();
      if (wasVisible) {
        this.flushSelection();
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel('cswapManager.dashboard', t('Cswap Dashboard'), vscode.ViewColumn.Active, {
      enableScripts: true,
      enableCommandUris: false,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(this.deps.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, 'resources', 'cswap.svg');
    panel.webview.html = dashboardHtml(panel.webview, this.deps.extensionUri, randomBytes(16).toString('base64'), currentLanguage());
    this.panel = panel;
    this.panelDisposables = [
      panel.webview.onDidReceiveMessage((raw: unknown) => void this.handleMessage(raw)),
      panel.onDidChangeViewState(() => this.onVisibilityChanged()),
      panel.onDidDispose(() => this.onPanelDisposed()),
    ];
    this.onVisibilityChanged();
  }

  /** Validates and dispatches a webview message. Returns whether it was accepted. */
  async handleMessage(raw: unknown): Promise<boolean> {
    const message = parseWebviewMessage(raw);
    if (message === undefined) {
      this.deps.logger.warn('Ignored an invalid message from the dashboard webview.');
      return false;
    }
    switch (message.type) {
      case 'ready':
        this.postState();
        this.flushSelection();
        return true;
      case 'refresh':
        void this.deps.refreshService.refresh({ trigger: 'manual' });
        return true;
      case 'switchToAccount': {
        const known = this.deps.refreshService.getState().snapshot?.accounts.some((account) => account.slot === message.slot) === true;
        if (!known) {
          this.deps.logger.warn('Ignored a dashboard switch request for an unknown slot.');
          return false;
        }
        void runSwitch(this.switchFlowDeps(), { kind: 'slot', slot: message.slot });
        return true;
      }
      case 'switchStrategy':
        void runSwitch(this.switchFlowDeps(), { kind: 'strategy', strategy: message.strategy });
        return true;
      case 'manageAccount': {
        const known = this.deps.refreshService.getState().snapshot?.accounts.some((account) => account.slot === message.slot) === true;
        if (!known) {
          this.deps.logger.warn('Ignored a dashboard account action for an unknown slot.');
          return false;
        }
        const { refreshService, managementService, gate, configuration, homeDir } = this.deps;
        void runAccountAction({ refreshService, managementService, gate, configuration, homeDir }, message.action, message.slot);
        return true;
      }
      case 'openSettings':
        await vscode.commands.executeCommand('cswapManager.quickSettings');
        return true;
      case 'openAutoSwitch':
        await vscode.commands.executeCommand('cswapManager.autoSwitch');
        return true;
      case 'showDiagnostics':
        await vscode.commands.executeCommand('cswapManager.showDiagnostics');
        return true;
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.onPanelDisposed();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private switchFlowDeps() {
    const { refreshService, switchService, configuration, homeDir } = this.deps;
    return { refreshService, switchService, configuration, homeDir };
  }

  private onVisibilityChanged(): void {
    const visible = this.panel?.visible === true;
    this.deps.autoRefresh.setConsumer('dashboard', visible);
    if (visible) {
      this.clock ??= setInterval(() => this.postState(), CLOCK_TICK_MS);
      this.postState();
    } else if (this.clock !== undefined) {
      clearInterval(this.clock);
      this.clock = undefined;
    }
  }

  private onPanelDisposed(): void {
    if (this.clock !== undefined) {
      clearInterval(this.clock);
      this.clock = undefined;
    }
    for (const disposable of this.panelDisposables) {
      disposable.dispose();
    }
    this.panelDisposables = [];
    this.panel = undefined;
    this.deps.autoRefresh.setConsumer('dashboard', false);
  }

  private post(message: HostToWebview): void {
    void this.panel?.webview.postMessage(message);
  }

  private flushSelection(): void {
    if (this.pendingSelection !== undefined && this.panel !== undefined) {
      this.post({ type: 'select', slot: this.pendingSelection });
      this.pendingSelection = undefined;
    }
  }

  private postState(): void {
    if (this.panel === undefined || !this.panel.visible) {
      return;
    }
    const { refreshService, switchService, configuration, describeError } = this.deps;
    const state = refreshService.getState();
    const options = presentationOptions(configuration);
    const auto = this.deps.autoSwitch.getState();
    const locale = currentLocale();
    const nextRefreshAt = this.deps.autoRefresh.nextRefreshAt();
    const usageHistory = configuration.usageHistory() ? this.deps.usageHistory.current() : undefined;
    const model = buildDashboardModel(state, {
      ...options,
      freshness: assessFreshness(state, options.now, configuration.staleAfterMs()),
      switching: switchService.isSwitching() || this.deps.gate.isBusy(),
      describeError,
      autoSwitch: { mode: configuration.autoSwitchMode(), strategy: auto.rules?.strategy },
      formatDecimal: (value) => value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      ...(nextRefreshAt === undefined ? {} : { nextRefreshAt }),
      ...(usageHistory === undefined ? {} : { usageHistory }),
    });
    // Keep the tab title in the chosen language after a language change.
    this.panel.title = t('Cswap Dashboard');
    this.post({ type: 'state', model });
  }
}
