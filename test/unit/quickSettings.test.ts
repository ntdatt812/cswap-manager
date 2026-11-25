import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUTO_SWITCH_STRATEGIES } from '../../src/core/cli/autoSwitchRules';
import { formatMessage } from '../../src/core/presentation/language';
import {
  autoSwitchStrategyDetail,
  autoSwitchStrategyLabel,
  buildQuickSettingsRows,
  cswapUpdatesLabel,
  cswapVersionText,
  isLanguageSetting,
  isSettingKey,
  languageLabel,
  matchingLook,
  notificationsSummary,
  statusBarSummary,
  refreshChoices,
  refreshLabel,
  SETTING_KEYS,
  shareHistoryOn,
  usageAlertChoices,
  usageAlertLabel,
  type QuickSettingsValues,
} from '../../src/core/presentation/quickSettings';

const t = (message: string, ...args: Array<string | number | boolean>) => formatMessage(message, args);

const values: QuickSettingsValues = {
  language: 'vi',
  confirmSwitch: false,
  notifications: { weeklyReset: true, usageAlertPct: 90, loginExpiry: true },
  autoSwitchMode: 'switch',
  autoSwitchStrategy: 'consume-first',
  autoSwitchModel: 'Fable',
  autoSwitchRules: 'switch at 90% · cooldown 300s · every 60s',
  shareHistory: true,
  tokenUsage: 'haiku',
  statusBarParts: ['icon', 'slot', 'bar', 'usage'],
  statusBarButtons: ['settings'],
  barStyle: 'parallelograms',
  thresholds: { warning: 80, critical: 95 },
  sortOrder: 'slot',
  refreshSeconds: 120,
  cliPath: '',
  timeoutSeconds: 30,
  cswapUpdates: { daily: true, automatic: true },
};

describe('quick settings rows', () => {
  it('lists every setting once over the two pages, with its current value, grouped by separators', () => {
    const main = buildQuickSettingsRows(values, t, 'main');
    const advanced = buildQuickSettingsRows(values, t, 'advanced');
    const rows = [...main, ...advanced];
    const settings = rows.flatMap((row) => (row.separator === true ? [] : [row]));
    assert.deepEqual(
      settings.map((row) => row.key).sort(),
      [...SETTING_KEYS].sort(),
    );
    // The main page fits without scrolling.
    assert.ok(main.filter((row) => row.separator !== true).length <= 13);
    const value = (key: string) => settings.find((row) => row.key === key)?.value;
    assert.equal(value('language'), 'Tiếng Việt');
    assert.equal(value('confirmSwitch'), 'Off');
    assert.equal(value('autoSwitch'), 'Switch automatically');
    assert.equal(value('autoStrategy'), 'Use quota that resets soonest first');
    assert.equal(value('statusBar'), 'With progress bar · 1 button(s)');
    assert.equal(value('thresholds'), 'yellow 80% · red 95%');
    // Slanted cells are icons in pickers: 60% of 10 cells = 6 full cells.
    assert.equal(value('barStyle'), `Slanted ${'$(cswap-slant-8)'.repeat(6)}${'$(cswap-slant-0)'.repeat(4)}`);
    assert.equal(value('autoRules'), 'switch at 90% · cooldown 300s · every 60s');
    assert.equal(value('autoModel'), 'Fable');
    assert.equal(value('sortOrder'), 'By slot number');
    assert.equal(value('refresh'), 'every 2 min');
    assert.equal(value('cliPath'), 'auto-detect');
    assert.equal(value('timeout'), '30 s');
    assert.equal(value('notifications'), '90% · login expiry · weekly reset');
    assert.equal(value('cswapVersion'), 'updates automatically', 'version not known yet');
    assert.ok(advanced.some((row) => row.separator !== true && row.key === 'notifications'), 'notifications sit on the Advanced page');
    assert.ok(rows.some((row) => row.separator === true));
  });

  it('shows the cswap version, a newer release and how cswap is kept up to date', () => {
    const row = (overrides: Partial<QuickSettingsValues>) =>
      buildQuickSettingsRows({ ...values, ...overrides }, t, 'advanced').flatMap((candidate) => (candidate.separator !== true && candidate.key === 'cswapVersion' ? [candidate.value] : []))[0];
    assert.equal(row({ cswapVersion: '1.2.0', cswapLatest: '1.2.0' }), '1.2.0 · updates automatically');
    assert.equal(row({ cswapVersion: '1.2.0', cswapLatest: '1.3.0' }), '1.2.0 · 1.3.0 available · updates automatically');
    assert.equal(row({ cswapVersion: '1.2.0', cswapUpdates: { daily: true, automatic: false } }), '1.2.0 · asks before updating');
    assert.equal(row({ cswapVersion: '1.2.0', cswapUpdates: { daily: false, automatic: true } }), '1.2.0 · not checked daily');
    assert.equal(cswapVersionText(undefined, '1.3.0', t), undefined);
    assert.equal(cswapUpdatesLabel({ daily: false, automatic: false }, t), 'not checked daily');
  });

  it('summarises the notifications, and says Off when none is on', () => {
    const summary = (notifications: QuickSettingsValues['notifications']) => notificationsSummary(notifications, t);
    assert.equal(summary({ weeklyReset: false, usageAlertPct: 0, loginExpiry: false }), 'Off');
    assert.equal(summary({ weeklyReset: false, usageAlertPct: 95, loginExpiry: false }), '95%');
    assert.equal(summary({ weeklyReset: true, usageAlertPct: 0, loginExpiry: true }), 'login expiry · weekly reset');
    assert.equal(usageAlertLabel(0, t), 'Off');
    assert.equal(usageAlertLabel(80, t), '80%');
  });

  it('offers Off and the usual alert levels, keeping a hand-set one', () => {
    assert.deepEqual(usageAlertChoices(90), [0, 80, 90, 95]);
    assert.deepEqual(usageAlertChoices(85), [0, 80, 85, 90, 95]);
    assert.deepEqual(usageAlertChoices(0), [0, 80, 90, 95]);
  });

  it('says when the auto-switch rules are not loaded instead of guessing a strategy', () => {
    const rows = buildQuickSettingsRows({ ...values, confirmSwitch: true, autoSwitchStrategy: undefined }, t);
    const value = (key: string) => rows.flatMap((row) => (row.separator !== true && row.key === key ? [row.value] : []))[0];
    assert.equal(value('autoStrategy'), 'rules not loaded');
    assert.equal(value('confirmSwitch'), 'On');
  });

  it('reads chat-history sharing as on unless cswap says false', () => {
    assert.equal(shareHistoryOn(undefined), undefined);
    assert.equal(shareHistoryOn({}), true);
    assert.equal(shareHistoryOn({ shareHistory: false }), false);
  });

  it('validates keys and language values passed from outside', () => {
    assert.equal(isSettingKey('refresh'), true);
    assert.equal(isSettingKey('purge'), false);
    assert.equal(isSettingKey(undefined), false);
    assert.equal(isLanguageSetting('vi'), true);
    assert.equal(isLanguageSetting('fr'), false);
    assert.equal(languageLabel('auto', t), 'Automatic (follow VS Code)');
    assert.equal(languageLabel('en', t), 'English');
  });
});

describe('status bar looks', () => {
  it('recognises a ready-made look whatever the order, and summarises the rest', () => {
    assert.equal(matchingLook(['usage', 'icon', 'slot']), 'compact');
    assert.equal(matchingLook(['icon', 'slot', 'plan', 'bar', 'usage', 'reset']), 'full');
    assert.equal(matchingLook(['icon', 'plan']), undefined);
    assert.equal(statusBarSummary([], [], t), 'Hidden');
    assert.equal(statusBarSummary(['icon', 'plan'], ['refresh', 'settings'], t), 'Custom · 2 button(s)');
  });
});

describe('refresh interval choices', () => {
  it('labels minutes, seconds and off', () => {
    assert.equal(refreshLabel(0, t), 'Off');
    assert.equal(refreshLabel(300, t), 'every 5 min');
    assert.equal(refreshLabel(45, t), 'every 45s');
  });

  it('keeps a hand-set interval in the list, sorted, without duplicates', () => {
    assert.deepEqual(refreshChoices(120), [0, 60, 120, 300, 600, 900, 1800, 3600]);
    assert.deepEqual(refreshChoices(45), [0, 45, 60, 120, 300, 600, 900, 1800, 3600]);
  });
});

describe('cswap auto-switch strategies', () => {
  it('names and explains every strategy cswap accepts', () => {
    for (const strategy of AUTO_SWITCH_STRATEGIES) {
      assert.notEqual(autoSwitchStrategyLabel(strategy, t), 'unknown', strategy);
      assert.ok(autoSwitchStrategyDetail(strategy, t).length > 20, strategy);
    }
    assert.equal(autoSwitchStrategyLabel('consume-first', t), 'Use quota that resets soonest first');
  });

  it('shows unknown strategy codes only when they look like cswap codes', () => {
    assert.equal(autoSwitchStrategyLabel('future-strategy', t), 'future-strategy');
    assert.equal(autoSwitchStrategyLabel('[link](command:x)', t), 'unknown');
    assert.equal(autoSwitchStrategyLabel(undefined, t), 'unknown');
  });
});
