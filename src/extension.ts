import * as os from 'node:os';
import * as vscode from 'vscode';
import { CswapCli } from './core/cli/cswapCli';
import { CachedExecutableResolver, nodeResolverEnvironment } from './core/cli/executableResolver';
import { NodeProcessRunner } from './core/cli/processRunner';
import { ManagementService } from './core/service/managementService';
import { OperationGate } from './core/service/operationGate';
import { RefreshService } from './core/service/refreshService';
import { SwitchService } from './core/service/switchService';
import { AccountsView } from './vscode/accountsView';
import { AutoRefreshController } from './vscode/autoRefresh';
import { registerCommands } from './vscode/commands';
import { CONFIG_SECTION, ExtensionConfiguration } from './vscode/configuration';
import { DashboardController } from './vscode/dashboardPanel';
import { Logger } from './vscode/logger';
import { describeCliError } from './vscode/messages';
import { StatusBarController } from './vscode/statusBarController';

/** Exposed only when running under the extension test harness. */
export interface TestApi {
  readonly refreshService: RefreshService;
  readonly switchService: SwitchService;
  readonly managementService: ManagementService;
  readonly accountsView: AccountsView;
  readonly dashboard: DashboardController;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const homeDir = os.homedir();
  const logger = new Logger(homeDir);
  const configuration = new ExtensionConfiguration();
  const resolver = new CachedExecutableResolver(() => configuration.cliPath(), nodeResolverEnvironment());

  const cli = new CswapCli({
    runner: new NodeProcessRunner(),
    resolveExecutable: () => resolver.resolve(),
    onExecutableMissing: () => resolver.invalidate(),
    settings: () => configuration.cliRunSettings(),
    workingDirectory: homeDir,
    baseEnv: process.env,
    homeDir,
    onCommandFinished: (meta, error) => logger.commandFinished(meta, error),
  });
  const refreshService = new RefreshService({ cli });
  const gate = new OperationGate();
  const switchService = new SwitchService(cli, refreshService, gate);
  const managementService = new ManagementService(cli, refreshService, gate);
  const autoRefresh = new AutoRefreshController(refreshService, configuration);
  const accountsView = new AccountsView({ refreshService, configuration, autoRefresh, describeError: describeCliError });
  const statusBar = new StatusBarController({ refreshService, switchService, configuration, autoRefresh, describeError: describeCliError });
  const dashboard = new DashboardController({
    extensionUri: context.extensionUri,
    refreshService,
    switchService,
    managementService,
    gate,
    configuration,
    autoRefresh,
    logger,
    homeDir,
    describeError: describeCliError,
  });

  context.subscriptions.push(
    logger,
    refreshService,
    switchService,
    gate,
    autoRefresh,
    accountsView,
    statusBar,
    dashboard,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.cliPath`)) {
        resolver.invalidate();
        logger.info('cliPath setting changed; executable will be re-resolved.');
        void refreshService.refresh({ trigger: 'configuration', requireFresh: true });
      }
    }),
    ...registerCommands({ context, cli, resolver, refreshService, switchService, managementService, gate, configuration, accountsView, dashboard, homeDir }),
  );

  return context.extensionMode === vscode.ExtensionMode.Test ? { refreshService, switchService, managementService, accountsView, dashboard } : undefined;
}

export function deactivate(): void {
  // Disposables registered in activate() are cleaned up by VS Code.
}
