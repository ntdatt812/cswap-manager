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
import { AutoSwitchController } from './vscode/autoSwitchController';
import { registerCommands } from './vscode/commands';
import { CONFIG_SECTION, ExtensionConfiguration } from './vscode/configuration';
import { DashboardController } from './vscode/dashboardPanel';
import { configureLocalization } from './vscode/l10n';
import { Logger } from './vscode/logger';
import { describeCliError } from './vscode/messages';
import { applyDisplayNames } from './core/model/displayNames';
import { PriorityStore } from './core/service/priorityStore';
import { CrossWindowSync } from './vscode/crossWindowSync';
import { CswapUpdateCheck } from './vscode/cswapUpdateCheck';
import { AccountAdder } from './vscode/addAccountFlow';
import { watchWeeklyResets } from './vscode/weeklyResetNotifier';
import { ProjectAccounts } from './vscode/projectAccounts';
import { StatusBarController } from './vscode/statusBarController';

/** Exposed only when running under the extension test harness. */
export interface TestApi {
  readonly refreshService: RefreshService;
  readonly switchService: SwitchService;
  readonly managementService: ManagementService;
  readonly accountsView: AccountsView;
  readonly dashboard: DashboardController;
  readonly autoSwitch: AutoSwitchController;
  readonly statusBar: StatusBarController;
  readonly crossWindow: CrossWindowSync;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const homeDir = os.homedir();
  const logger = new Logger(homeDir);
  const configuration = new ExtensionConfiguration();
  configureLocalization(context.extensionPath, configuration.language());
  // Registered before any view so the new language is loaded before they re-render.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.language`)) {
        configureLocalization(context.extensionPath, configuration.language());
      }
    }),
  );
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
  // Display names (VS Code settings) and priorities (`cswap priority`, absent from list --json) are
  // added to every snapshot.
  const priorities = new PriorityStore(
    () => cli.priorities(),
    () => refreshService.redecorate(),
    (message) => logger.warn(message),
  );
  const refreshService = new RefreshService({
    cli,
    decorate: (snapshot) => priorities.apply(applyDisplayNames(snapshot, configuration.displayNameMap())),
  });
  const gate = new OperationGate();
  const switchService = new SwitchService(cli, refreshService, gate);
  const managementService = new ManagementService(cli, refreshService, gate);
  const firstLoad = refreshService.onDidChange((state) => {
    if (state.snapshot !== undefined && !state.refreshing) {
      firstLoad.dispose();
      void priorities.load();
    }
  });
  const autoRefresh = new AutoRefreshController(refreshService, configuration);
  const accountsView = new AccountsView({ refreshService, configuration, autoRefresh, describeError: describeCliError });
  const statusBar = new StatusBarController({ refreshService, switchService, configuration, autoRefresh, describeError: describeCliError });
  const autoSwitch = new AutoSwitchController({ context, cli, gate, refreshService, switchService, configuration, logger, homeDir });
  const crossWindow = new CrossWindowSync(context.globalStorageUri, refreshService, logger);
  const updateCheck = new CswapUpdateCheck(context, cli, resolver, logger, () => configuration.checkCswapUpdates());
  const projectAccounts = new ProjectAccounts({ cli, resolver, refreshService, gate, logger, homeDir });
  const accountAdder = new AccountAdder({ refreshService, managementService, gate, homeDir });
  const weeklyResetNotifier = watchWeeklyResets(refreshService, configuration);
  // Out of the way of start-up: one check shortly after activation, then at most daily.
  const updateTimer = setTimeout(() => void updateCheck.check(), 30_000);
  const dashboard = new DashboardController({
    extensionUri: context.extensionUri,
    autoSwitch: autoSwitch.service,
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
    firstLoad,
    managementService,
    managementService.onDidApply((event) => priorities.onApplied(event)),
    refreshService,
    switchService,
    gate,
    autoRefresh,
    accountsView,
    statusBar,
    dashboard,
    autoSwitch,
    crossWindow,
    accountAdder,
    weeklyResetNotifier,
    { dispose: () => clearTimeout(updateTimer) },
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.displayNames`)) {
        refreshService.redecorate();
      }
      if (event.affectsConfiguration(`${CONFIG_SECTION}.cliPath`)) {
        resolver.invalidate();
        logger.info('cliPath setting changed; executable will be re-resolved.');
        void refreshService.refresh({ trigger: 'configuration', requireFresh: true });
      }
    }),
    ...registerCommands({ context, cli, resolver, refreshService, switchService, managementService, gate, configuration, accountsView, dashboard, autoSwitch, statusBar, updateCheck, projectAccounts, accountAdder, homeDir }),
  );

  return context.extensionMode === vscode.ExtensionMode.Test ? { refreshService, switchService, managementService, accountsView, dashboard, autoSwitch, statusBar, crossWindow } : undefined;
}

export function deactivate(): void {
  // Disposables registered in activate() are cleaned up by VS Code.
}
