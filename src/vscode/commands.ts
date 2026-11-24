import * as os from 'node:os';
import * as vscode from 'vscode';
import type { CswapCli } from '../core/cli/cswapCli';
import type { CachedExecutableResolver } from '../core/cli/executableResolver';
import { collectDiagnostics, formatDiagnosticsReport } from '../core/diagnostics/diagnostics';
import { SORT_ORDERS, type SortOrder } from '../core/presentation/format';
import type { NodeModel } from '../core/presentation/accountTree';
import type { RefreshService } from '../core/service/refreshService';
import type { ManagementService } from '../core/service/managementService';
import type { OperationGate } from '../core/service/operationGate';
import type { SwitchService } from '../core/service/switchService';
import type { AccountActionId } from '../shared/dashboardProtocol';
import type { AccountsView } from './accountsView';
import type { DashboardController } from './dashboardPanel';
import type { ExtensionConfiguration } from './configuration';
import { describeCliError } from './messages';
import { runAccountAction } from './manageFlow';
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
  readonly homeDir: string;
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const version = (context.extension.packageJSON as { version?: unknown }).version;
  return typeof version === 'string' ? version : 'unknown';
}

const SORT_LABELS: Record<SortOrder, () => string> = {
  slot: () => vscode.l10n.t('By slot number'),
  mostUsed: () => vscode.l10n.t('Highest usage first'),
  leastUsed: () => vscode.l10n.t('Most remaining quota first'),
  soonestReset: () => vscode.l10n.t('Soonest reset first'),
};

async function refreshCommand(deps: CommandDependencies): Promise<void> {
  const result = await deps.refreshService.refresh({ trigger: 'manual' });
  if (result.ok) {
    vscode.window.setStatusBarMessage(vscode.l10n.t('Cswap: {0} account(s) refreshed.', result.snapshot.accounts.length), 3000);
    return;
  }
  if (result.error.kind === 'cancelled') {
    return;
  }
  const diagnostics = vscode.l10n.t('Show Diagnostics');
  const settings = vscode.l10n.t('Open Settings');
  const stale = result.snapshot ? ` ${vscode.l10n.t('Showing last known data (stale).')}` : '';
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
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Cswap: collecting diagnostics…') },
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
  const copy = vscode.l10n.t('Copy Report');
  if ((await vscode.window.showInformationMessage(vscode.l10n.t('Cswap diagnostics report is ready (redacted).'), copy)) === copy) {
    await vscode.env.clipboard.writeText(text);
  }
}

async function filterCommand(deps: CommandDependencies): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: vscode.l10n.t('Filter Cswap accounts'),
    prompt: vscode.l10n.t('Match slot, email, organization, plan or usage status. Leave empty to clear.'),
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
      label: SORT_LABELS[order](),
      description: order === current ? vscode.l10n.t('current') : undefined,
      order,
    })),
    { title: vscode.l10n.t('Sort Cswap accounts') },
  );
  if (picked !== undefined && picked.order !== current) {
    await deps.configuration.setSortOrder(picked.order);
  }
}

/** Tree-row commands for each management action; without a row they ask for the account. */
const ACTION_COMMANDS: ReadonlyArray<[string, AccountActionId]> = [
  ['cswapManager.setAlias', 'setAlias'],
  ['cswapManager.removeAlias', 'removeAlias'],
  ['cswapManager.disableAccount', 'disable'],
  ['cswapManager.enableAccount', 'enable'],
  ['cswapManager.setThreshold', 'setThreshold'],
  ['cswapManager.clearThreshold', 'clearThreshold'],
  ['cswapManager.moveAccount', 'move'],
];

export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('cswapManager.manageAccount', (node?: NodeModel) => runAccountAction(deps, undefined, node?.slot)),
    ...ACTION_COMMANDS.map(([command, action]) =>
      vscode.commands.registerCommand(command, (node?: NodeModel) => runAccountAction(deps, action, node?.slot)),
    ),
    vscode.commands.registerCommand('cswapManager.refresh', () => refreshCommand(deps)),
    vscode.commands.registerCommand('cswapManager.showDiagnostics', () => diagnosticsCommand(deps)),
    vscode.commands.registerCommand('cswapManager.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${deps.context.extension.id}`),
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
