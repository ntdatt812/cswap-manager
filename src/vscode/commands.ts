import * as os from 'node:os';
import * as vscode from 'vscode';
import { localize } from './l10n';
import type { CswapCli } from '../core/cli/cswapCli';
import type { CachedExecutableResolver } from '../core/cli/executableResolver';
import { collectDiagnostics, formatDiagnosticsReport } from '../core/diagnostics/diagnostics';
import { SORT_ORDERS } from '../core/presentation/format';
import { isSettingKey, sortOrderLabel } from '../core/presentation/quickSettings';
import type { NodeModel } from '../core/presentation/accountTree';
import type { RefreshService } from '../core/service/refreshService';
import type { ManagementService } from '../core/service/managementService';
import type { OperationGate } from '../core/service/operationGate';
import type { SwitchService } from '../core/service/switchService';
import type { AccountActionId } from '../shared/dashboardProtocol';
import type { AccountsView } from './accountsView';
import type { AutoSwitchController } from './autoSwitchController';
import type { DashboardController } from './dashboardPanel';
import type { ExtensionConfiguration } from './configuration';
import type { StatusBarController } from './statusBarController';
import type { CswapUpdateCheck } from './cswapUpdateCheck';
import type { ProjectAccounts } from './projectAccounts';
import { describeCliError } from './messages';
import { runAccountAction, runDropMove } from './manageFlow';
import { MOVE_ACCOUNT_TO_COMMAND } from './accountsDragAndDrop';
import type { AccountAdder } from './addAccountFlow';
import { exportAccounts, importAccounts, importUsage, saveUsageReadings } from './transferFlow';
import { t } from './presentation';
import { openQuickSettings } from './quickSettings';
import { runQuickSwitch, runSwitch } from './switchFlow';

export interface CommandDependencies {
  readonly context: vscode.ExtensionContext;
  readonly cli: CswapCli;
  readonly resolver: CachedExecutableResolver;
  readonly refreshService: RefreshService;
  readonly switchService: SwitchService;
  readonly managementService: ManagementService;
  readonly gate: OperationGate;
  readonly configuration: ExtensionConfiguration;
  readonly accountsView: AccountsView;
  readonly dashboard: DashboardController;
  readonly autoSwitch: AutoSwitchController;
  readonly statusBar: StatusBarController;
  readonly updateCheck: CswapUpdateCheck;
  readonly projectAccounts: ProjectAccounts;
  readonly accountAdder: AccountAdder;
  readonly homeDir: string;
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const version = (context.extension.packageJSON as { version?: unknown }).version;
  return typeof version === 'string' ? version : 'unknown';
}

async function checkUpdateCommand(deps: CommandDependencies): Promise<void> {
  const state = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: localize('Cswap: checking for a cswap update…') }, () =>
    deps.updateCheck.check(true),
  );
  if (state.current === undefined || state.latest === undefined) {
    void vscode.window.showWarningMessage(localize('Could not check for a cswap update right now.'));
    return;
  }
  if (state.latest.text === state.current.text) {
    void vscode.window.showInformationMessage(localize('cswap {0} is up to date.', state.current.text));
  }
}

async function refreshCommand(deps: CommandDependencies): Promise<void> {
  const result = await deps.refreshService.refresh({ trigger: 'manual' });
  if (result.ok) {
    vscode.window.setStatusBarMessage(localize('Cswap: {0} account(s) refreshed.', result.snapshot.accounts.length), 3000);
    return;
  }
  if (result.error.kind === 'cancelled') {
    return;
  }
  const diagnostics = localize('Show Diagnostics');
  const settings = localize('Open Settings');
  const stale = result.snapshot ? ` ${localize('Showing last known data (stale).')}` : '';
  const choice = await vscode.window.showErrorMessage(`${describeCliError(result.error)}${stale}`, diagnostics, settings);
  if (choice === diagnostics) {
    await vscode.commands.executeCommand('cswapManager.showDiagnostics');
  } else if (choice === settings) {
    await vscode.commands.executeCommand('cswapManager.openSettings');
  }
}

async function diagnosticsCommand(deps: CommandDependencies): Promise<void> {
  const { configuration, cli, resolver, refreshService, homeDir, context } = deps;
  const text = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: localize('Cswap: collecting diagnostics…') },
    async () => {
      const report = await collectDiagnostics({
        environment: {
          extensionVersion: extensionVersion(context),
          vscodeVersion: vscode.version,
          platform: process.platform,
          osRelease: os.release(),
          arch: process.arch,
          nodeVersion: process.version,
        },
        settings: { cliPathSetting: configuration.cliPath(), ...configuration.cliRunSettings() },
        homeDir,
        resolveExecutable: () => resolver.resolve(),
        cli: { version: () => cli.version(), list: () => cli.list(), status: () => cli.status() },
        refreshState: () => refreshService.getState(),
        now: Date.now,
      });
      return formatDiagnosticsReport(report, homeDir);
    },
  );
  const document = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
  await vscode.window.showTextDocument(document, { preview: false });
  const copy = localize('Copy Report');
  if ((await vscode.window.showInformationMessage(localize('Cswap diagnostics report is ready (redacted).'), copy)) === copy) {
    await vscode.env.clipboard.writeText(text);
  }
}

async function filterCommand(deps: CommandDependencies): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: localize('Filter Cswap accounts'),
    prompt: localize('Match slot, email, organization, plan or usage status. Leave empty to clear.'),
    value: deps.accountsView.getFilter() ?? '',
  });
  if (value !== undefined) {
    deps.accountsView.setFilter(value);
  }
}

async function sortCommand(deps: CommandDependencies): Promise<void> {
  const current = deps.configuration.sortOrder();
  const picked = await vscode.window.showQuickPick(
    SORT_ORDERS.map((order) => ({
      label: sortOrderLabel(order, t),
      description: order === current ? localize('current') : undefined,
      order,
    })),
    { title: localize('Sort Cswap accounts') },
  );
  if (picked !== undefined && picked.order !== current) {
    await deps.configuration.setSortOrder(picked.order);
  }
}

/** Tree-row commands for each management action; without a row they ask for the account. */
const ACTION_COMMANDS: ReadonlyArray<[string, AccountActionId]> = [
  ['cswapManager.setDisplayName', 'setDisplayName'],
  ['cswapManager.disableAccount', 'disable'],
  ['cswapManager.enableAccount', 'enable'],
  ['cswapManager.setThreshold', 'setThreshold'],
  ['cswapManager.clearThreshold', 'clearThreshold'],
  ['cswapManager.moveAccount', 'move'],
  ['cswapManager.removeAccount', 'remove'],
];

export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('cswapManager.autoSwitch', () => deps.autoSwitch.openMenu()),
    vscode.commands.registerCommand('cswapManager.autoSwitchPreview', () => deps.autoSwitch.preview()),
    vscode.commands.registerCommand('cswapManager.manageAccount', (node?: NodeModel) => runAccountAction(deps, undefined, node?.slot)),
    ...ACTION_COMMANDS.map(([command, action]) =>
      vscode.commands.registerCommand(command, (node?: NodeModel) => runAccountAction(deps, action, node?.slot)),
    ),
    vscode.commands.registerCommand('cswapManager.refresh', () => refreshCommand(deps)),
    vscode.commands.registerCommand('cswapManager.addAccount', () => deps.accountAdder.run()),
    // Internal (not contributed): a drop in the Accounts view. Arguments are checked again in runDropMove.
    vscode.commands.registerCommand(MOVE_ACCOUNT_TO_COMMAND, (slot: unknown, targetSlot: unknown) =>
      typeof slot === 'number' && typeof targetSlot === 'number' ? runDropMove(deps, slot, targetSlot) : undefined,
    ),
    vscode.commands.registerCommand('cswapManager.exportAccounts', () => exportAccounts(deps)),
    vscode.commands.registerCommand('cswapManager.exportAccount', (node?: NodeModel) => (node?.slot === undefined ? undefined : exportAccounts(deps, node.slot))),
    vscode.commands.registerCommand('cswapManager.importAccounts', () => importAccounts(deps)),
    vscode.commands.registerCommand('cswapManager.saveUsageReadings', () => saveUsageReadings(deps)),
    vscode.commands.registerCommand('cswapManager.importUsage', () => importUsage(deps)),
    vscode.commands.registerCommand('cswapManager.checkCswapUpdate', () => checkUpdateCommand(deps)),
    vscode.commands.registerCommand('cswapManager.openClaudeAs', (node?: NodeModel) => deps.projectAccounts.openClaude(node?.slot)),
    vscode.commands.registerCommand('cswapManager.openClaudeForProject', () => deps.projectAccounts.openClaudeForProject()),
    vscode.commands.registerCommand('cswapManager.assignProjectAccount', (node?: NodeModel) => deps.projectAccounts.assign(node?.slot)),
    vscode.commands.registerCommand('cswapManager.showDiagnostics', () => diagnosticsCommand(deps)),
    vscode.commands.registerCommand('cswapManager.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${deps.context.extension.id}`),
    ),
    vscode.commands.registerCommand('cswapManager.quickSettings', (focus?: unknown) =>
      openQuickSettings(deps, isSettingKey(focus) ? focus : undefined),
    ),
    vscode.commands.registerCommand('cswapManager.filterAccounts', () => filterCommand(deps)),
    vscode.commands.registerCommand('cswapManager.clearFilter', () => deps.accountsView.setFilter(undefined)),
    vscode.commands.registerCommand('cswapManager.sortAccounts', () => sortCommand(deps)),
    vscode.commands.registerCommand('cswapManager.openDashboard', () => deps.dashboard.show()),
    vscode.commands.registerCommand('cswapManager.showAccountDetails', (node?: NodeModel) => deps.dashboard.show(node?.slot)),
    vscode.commands.registerCommand('cswapManager.quickSwitch', () => runQuickSwitch(deps)),
    vscode.commands.registerCommand('cswapManager.switchBest', () => runSwitch(deps, { kind: 'strategy', strategy: 'best' })),
    vscode.commands.registerCommand('cswapManager.switchNextAvailable', () =>
      runSwitch(deps, { kind: 'strategy', strategy: 'next-available' }),
    ),
    // Invoked from an account row in the tree; without a row it falls back to the picker.
    vscode.commands.registerCommand('cswapManager.switchToAccount', (node?: NodeModel) =>
      node?.slot === undefined ? runQuickSwitch(deps) : runSwitch(deps, { kind: 'slot', slot: node.slot }),
    ),
  ];
}
