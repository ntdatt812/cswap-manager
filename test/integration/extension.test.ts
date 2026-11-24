/**
 * Extension-host tests (`npm run test:integration`). The account tests use the locally installed
 * cswap with read-only commands and are skipped when the CLI is not available.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { displayNameKey } from '../../src/core/model/displayNames';
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
  'cswapManager.autoSwitch',
  'cswapManager.autoSwitchPreview',
  'cswapManager.quickSettings',
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

  test('switches the UI language with cswapManager.language', async function () {
    const refreshed = await api.refreshService.refresh({ trigger: 'manual', requireFresh: true });
    const activeSlot = refreshed.ok ? refreshed.snapshot.active.slot : undefined;
    if (activeSlot === undefined) {
      this.skip();
      return;
    }
    const activeDescription = () =>
      api.accountsView.provider.getChildren().find((node) => node.id === `account:${activeSlot}`)?.description ?? '';
    const waitFor = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 40 && !predicate(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return predicate();
    };
    const config = vscode.workspace.getConfiguration('cswapManager');
    try {
      await config.update('language', 'vi', vscode.ConfigurationTarget.Global);
      assert.ok(await waitFor(() => activeDescription().startsWith('Đang dùng')), activeDescription());
      await config.update('language', 'en', vscode.ConfigurationTarget.Global);
      assert.ok(await waitFor(() => activeDescription().startsWith('Active')), activeDescription());
    } finally {
      await config.update('language', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('toggles "Ask before switching" in place from Quick Settings', async () => {
    const config = () => vscode.workspace.getConfiguration('cswapManager');
    const confirmValue = () => config().inspect<boolean>('confirmSwitch')?.globalValue;
    const waitFor = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 60 && !predicate(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return predicate();
    };
    const before = confirmValue();
    let opened: Thenable<unknown> | undefined;
    try {
      await config().update('confirmSwitch', true, vscode.ConfigurationTarget.Global);
      opened = vscode.commands.executeCommand('cswapManager.quickSettings', 'confirmSwitch');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      assert.ok(await waitFor(() => confirmValue() === false), `confirmSwitch is ${String(confirmValue())}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      assert.ok(await waitFor(() => confirmValue() === true), `confirmSwitch is ${String(confirmValue())}`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await opened;
      await config().update('confirmSwitch', before, vscode.ConfigurationTarget.Global);
    }
  });

  test('highlights the current value in a Quick Settings sub-picker, so Enter changes nothing', async () => {
    const config = () => vscode.workspace.getConfiguration('cswapManager');
    const before = config().inspect<number>('refreshIntervalSeconds')?.globalValue;
    let opened: Thenable<unknown> | undefined;
    try {
      await config().update('refreshIntervalSeconds', 300, vscode.ConfigurationTarget.Global);
      opened = vscode.commands.executeCommand('cswapManager.quickSettings', 'refresh');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(config().get<number>('refreshIntervalSeconds'), 300);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await opened;
      await config().update('refreshIntervalSeconds', before, vscode.ConfigurationTarget.Global);
    }
  });

  test('customizes the status bar: parts, bar style, buttons and live preview', async () => {
    await api.refreshService.refresh({ trigger: 'manual' });
    const config = () => vscode.workspace.getConfiguration('cswapManager');
    const keys = ['statusBar.mode', 'statusBar.parts', 'display.barStyle', 'statusBar.buttons'];
    const before = keys.map((key) => config().inspect(key)?.globalValue);
    try {
      await config().update('statusBar.parts', ['slot', 'bar'], vscode.ConfigurationTarget.Global);
      await config().update('display.barStyle', 'circles', vscode.ConfigurationTarget.Global);
      await config().update('statusBar.mode', 'custom', vscode.ConfigurationTarget.Global);
      await config().update('statusBar.buttons', ['refresh', 'dashboard'], vscode.ConfigurationTarget.Global);
      const state = api.statusBar.currentState();
      assert.match(state.text ?? '', /^#\d+( · [●◐○]{8})?$/, state.text);
      assert.deepEqual(state.buttons, ['refresh', 'dashboard']);
      api.statusBar.preview({ parts: [] });
      assert.equal(api.statusBar.currentState().text, undefined, 'previewing nothing hides the item');
      assert.deepEqual(api.statusBar.currentState().buttons, [], 'buttons go with the account item');
      api.statusBar.preview({ buttons: ['settings'] });
      assert.deepEqual(api.statusBar.currentState().buttons, ['settings']);
      api.statusBar.preview(undefined);
      assert.deepEqual(api.statusBar.currentState().buttons, ['refresh', 'dashboard'], 'ending the preview restores the saved settings');
    } finally {
      api.statusBar.preview(undefined);
      for (const [index, key] of keys.entries()) {
        await config().update(key, before[index], vscode.ConfigurationTarget.Global);
      }
    }
  });

  test('saves a new value picked in Quick Settings (refresh interval and bar style)', async () => {
    const config = () => vscode.workspace.getConfiguration('cswapManager');
    const warnings: string[] = [];
    const window = vscode.window as unknown as { showWarningMessage: (...args: unknown[]) => Thenable<unknown> };
    const original = window.showWarningMessage;
    window.showWarningMessage = (...args: unknown[]) => {
      warnings.push(String(args[0]));
      return Promise.resolve(undefined);
    };
    const before = ['refreshIntervalSeconds', 'display.barStyle'].map((key) => config().inspect(key)?.globalValue);
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const pickNext = async (row: string) => {
      const opened = vscode.commands.executeCommand('cswapManager.quickSettings', row);
      await pause(500);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await pause(500);
      await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
      await pause(200);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await pause(800);
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await opened;
    };
    try {
      await config().update('refreshIntervalSeconds', 120, vscode.ConfigurationTarget.Global);
      await config().update('display.barStyle', 'blocks', vscode.ConfigurationTarget.Global);
      await pickNext('refresh');
      await pickNext('barStyle');
      assert.deepEqual(warnings, []);
      assert.equal(config().inspect('refreshIntervalSeconds')?.globalValue, 300);
      assert.equal(config().inspect('display.barStyle')?.globalValue, 'parallelograms');
    } finally {
      window.showWarningMessage = original;
      await config().update('refreshIntervalSeconds', before[0], vscode.ConfigurationTarget.Global);
      await config().update('display.barStyle', before[1], vscode.ConfigurationTarget.Global);
    }
  });

  test('knows every contributed setting (a missing default would mean "not loaded yet")', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const contributed = Object.keys(
      (extension?.packageJSON as { contributes: { configuration: { properties: Record<string, unknown> } } }).contributes.configuration.properties,
    );
    const config = vscode.workspace.getConfiguration();
    const missing = contributed.filter((key) => config.inspect(key)?.defaultValue === undefined);
    assert.deepEqual(missing, []);
    assert.equal(vscode.workspace.getConfiguration('cswapManager').inspect('not.a.setting')?.defaultValue, undefined);
  });

  test("refreshes when another window reports a different active account", async function () {
    const first = await api.refreshService.refresh({ trigger: 'manual', requireFresh: true });
    if (!first.ok) {
      this.skip();
      return;
    }
    const shown = first.snapshot.active.slot ?? 0;
    const before = api.refreshService.getState().lastAttemptAt ?? 0;
    await fs.writeFile(api.crossWindow.file, JSON.stringify({ slot: shown + 1000, at: Date.now(), origin: 'another-window' }), 'utf8');
    let refreshed = false;
    for (let attempt = 0; attempt < 60 && !refreshed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      refreshed = (api.refreshService.getState().lastAttemptAt ?? 0) > before;
    }
    assert.ok(refreshed, 'a signal from another window triggers a refresh');
  });

  test('shows a display name in the sidebar as soon as it is saved, without calling cswap', async function () {
    const refreshed = await api.refreshService.refresh({ trigger: 'manual' });
    const target = refreshed.ok ? refreshed.snapshot.accounts.find((candidate) => displayNameKey(candidate) !== undefined) : undefined;
    const key = target === undefined ? undefined : displayNameKey(target);
    if (target === undefined || key === undefined) {
      this.skip();
      return;
    }
    const config = () => vscode.workspace.getConfiguration('cswapManager');
    const before = config().inspect('displayNames')?.globalValue;
    const label = () => {
      const node = api.accountsView.provider.getChildren().find((candidate) => candidate.id === `account:${target.slot}`);
      return typeof node?.label === 'string' ? node.label : '';
    };
    try {
      await config().update('displayNames', { [key]: 'Tên Thử Nghiệm' }, vscode.ConfigurationTarget.Global);
      let shown = false;
      for (let attempt = 0; attempt < 40 && !shown; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        shown = label().includes('Tên Thử Nghiệm');
      }
      assert.ok(shown, label());
    } finally {
      await config().update('displayNames', before, vscode.ConfigurationTarget.Global);
    }
  });

  test('runs auto-switch in notify mode with real dry runs only (never switches)', async function () {
    const before = await api.refreshService.refresh({ trigger: 'manual', requireFresh: true });
    if (!before.ok) {
      this.skip();
      return;
    }
    const config = vscode.workspace.getConfiguration('cswapManager');
    const service = api.autoSwitch.service;
    try {
      await config.update('autoSwitch.mode', 'notify', vscode.ConfigurationTarget.Global);
      // Enabling sets the mode first, then loads the rules from `cswap config` asynchronously.
      for (let attempt = 0; attempt < 100 && (service.getState().mode !== 'notify' || service.getState().rules === undefined); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(service.getState().mode, 'notify');
      assert.ok(service.getState().rules?.threshold !== undefined, 'rules read from cswap config');
      assert.equal(await service.tick(), true);
      const state = service.getState();
      assert.ok(['no-action', 'switched', 'blocked'].includes(state.lastOutcome ?? ''), String(state.lastOutcome));
      assert.equal(state.lastSwitch?.dryRun ?? true, true, 'notify mode never performs a real switch');
      const after = await api.refreshService.refresh({ trigger: 'manual', requireFresh: true });
      assert.ok(after.ok);
      assert.equal(after.snapshot.active.slot, before.snapshot.active.slot, 'active account unchanged');
    } finally {
      await config.update('autoSwitch.mode', undefined, vscode.ConfigurationTarget.Global);
    }
    for (let attempt = 0; attempt < 40 && service.getState().mode !== 'off'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(service.getState().mode, 'off');
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
