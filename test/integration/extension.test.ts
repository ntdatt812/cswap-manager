/**
 * Extension-host tests (`npm run test:integration`). The account tests use the locally installed
 * cswap with read-only commands and are skipped when the CLI is not available.
 */
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';

const EXTENSION_ID = 'nguyenthanhdat.cswap-manager';
const COMMANDS = [
  'cswapManager.refresh',
  'cswapManager.showDiagnostics',
  'cswapManager.openSettings',
  'cswapManager.filterAccounts',
  'cswapManager.clearFilter',
  'cswapManager.sortAccounts',
  'cswapManager.quickSwitch',
  'cswapManager.switchBest',
  'cswapManager.switchNextAvailable',
  'cswapManager.switchToAccount',
  'cswapManager.openDashboard',
  'cswapManager.showAccountDetails',
  'cswapManager.manageAccount',
  'cswapManager.setAlias',
  'cswapManager.removeAlias',
  'cswapManager.disableAccount',
  'cswapManager.enableAccount',
  'cswapManager.setThreshold',
  'cswapManager.clearThreshold',
  'cswapManager.moveAccount',
];

suite('Cswap Manager (extension host)', () => {
  let api: TestApi;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
    assert.ok(extension, 'extension is installed in the test host');
    const exported = await extension.activate();
    assert.ok(exported, 'test API is exposed in test mode');
    api = exported;
  });

  test('registers every contributed command', async () => {
    const registered = await vscode.commands.getCommands(true);
    for (const command of COMMANDS) {
      assert.ok(registered.includes(command), command);
    }
  });

  test('opens the Accounts view', async () => {
    await vscode.commands.executeCommand('cswapManager.accounts.focus');
  });

  test('renders live accounts in slot order with dynamic usage children', async function () {
    const result = await api.refreshService.refresh({ trigger: 'manual', requireFresh: true });
    if (!result.ok && result.error.kind === 'executable-not-found') {
      this.skip();
    }
    assert.ok(result.ok, result.ok ? '' : result.error.kind);

    const roots = api.accountsView.provider.getChildren();
    assert.equal(roots.length, result.snapshot.accounts.length);
    const slots = roots.map((node) => Number(node.id.split(':')[1]));
    assert.deepEqual(slots, [...slots].sort((a, b) => a - b), 'slot order by default');

    const activeSlot = result.snapshot.active.slot;
    if (activeSlot !== undefined) {
      const active = roots.find((node) => node.id === `account:${activeSlot}`);
      assert.match(active?.contextValue ?? '', /^cswap.account:active:/);
    }

    const first = roots[0];
    assert.ok(first);
    const item = api.accountsView.provider.getTreeItem(first);
    assert.ok(item.iconPath instanceof vscode.ThemeIcon);
    assert.ok(item.tooltip instanceof vscode.MarkdownString);
    assert.equal(item.tooltip.isTrusted, false, 'tooltips never trust CLI content');
    const windowKeys = result.snapshot.accounts[0]?.usage?.windows.map((window) => window.key) ?? [];
    for (const key of windowKeys) {
      assert.ok(first.children.some((node) => node.id === `${first.id}:window:${key}`), key);
    }
  });

  test('switching to the already-active slot is a verified no-op (real CLI)', async function () {
    const refreshed = await api.refreshService.refresh({ trigger: 'manual', verifyActive: true, requireFresh: true });
    const activeSlot = refreshed.ok ? refreshed.snapshot.active.slot : undefined;
    if (activeSlot === undefined) {
      this.skip();
      return;
    }
    const outcome = await api.switchService.switch({ kind: 'slot', slot: activeSlot });
    assert.equal(outcome.kind, 'not-switched');
    assert.ok(outcome.kind === 'not-switched');
    assert.equal(outcome.result.reason, 'already-active');
    assert.equal(outcome.result.to?.slot, activeSlot);
    assert.deepEqual(outcome.verification, { status: 'confirmed', activeSlot });
    assert.equal(api.switchService.isSwitching(), false);
  });

  test('opens the dashboard and only accepts allow-listed webview messages', async () => {
    await vscode.commands.executeCommand('cswapManager.openDashboard');
    assert.equal(api.dashboard.isOpen(), true);

    assert.equal(await api.dashboard.handleMessage({ type: 'executeCommand', command: 'workbench.action.terminal.new' }), false);
    assert.equal(await api.dashboard.handleMessage({ type: 'switchToAccount', slot: '1' }), false);
    assert.equal(await api.dashboard.handleMessage({ type: 'switchToAccount', slot: 987_654 }), false, 'unknown slot');
    assert.equal(await api.dashboard.handleMessage({ type: 'ready' }), true);
    assert.equal(await api.dashboard.handleMessage({ type: 'refresh' }), true);

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    assert.equal(api.dashboard.isOpen(), false);
  });

  test('sets and removes an alias end-to-end with verification (opt-in: CSWAP_E2E_MUTATE=1)', async function () {
    if (process.env.CSWAP_E2E_MUTATE !== '1') {
      this.skip();
      return;
    }
    const refreshed = await api.refreshService.refresh({ trigger: 'manual', requireFresh: true });
    assert.ok(refreshed.ok);
    // Only an inactive account without an alias, so removing the alias restores the exact state.
    const target = refreshed.snapshot.accounts.find((account) => account.slot !== refreshed.snapshot.active.slot && account.alias === undefined);
    if (target === undefined) {
      this.skip();
      return;
    }
    const set = await api.managementService.apply({ kind: 'setAlias', slot: target.slot, alias: 'cswap-e2e-probe' });
    const removed = await api.managementService.apply({ kind: 'removeAlias', slot: target.slot });
    assert.deepEqual(set, { kind: 'applied', verification: 'confirmed' });
    assert.deepEqual(removed, { kind: 'applied', verification: 'confirmed' });
    assert.equal(api.refreshService.getState().snapshot?.accounts.find((account) => account.slot === target.slot)?.alias, undefined);
  });

  test('filters and clears through the commands', async function () {
    const snapshot = api.refreshService.getState().snapshot;
    const firstAccount = snapshot?.accounts[0];
    if (firstAccount === undefined || snapshot === undefined) {
      this.skip();
      return;
    }
    api.accountsView.setFilter(`#${firstAccount.slot}`);
    assert.equal(api.accountsView.provider.getChildren().length, 1);
    await vscode.commands.executeCommand('cswapManager.clearFilter');
    assert.equal(api.accountsView.getFilter(), undefined);
    assert.equal(api.accountsView.provider.getChildren().length, snapshot.accounts.length);
  });
});
