import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUTO_SWITCH_STRATEGIES } from '../../src/core/cli/autoSwitchRules';
import { formatMessage } from '../../src/core/presentation/language';
import {
  autoSwitchStrategyDetail,
  autoSwitchStrategyLabel,
  buildQuickSettingsRows,
  isLanguageSetting,
  isSettingKey,
  languageLabel,
  refreshChoices,
  refreshLabel,
  SETTING_KEYS,
  type QuickSettingsValues,
} from '../../src/core/presentation/quickSettings';

const t = (message: string, ...args: Array<string | number | boolean>) => formatMessage(message, args);

const values: QuickSettingsValues = {
  language: 'vi',
  confirmSwitch: false,
  autoSwitchMode: 'switch',
  autoSwitchStrategy: 'consume-first',
  statusBarMode: 'slotUsage',
  sortOrder: 'slot',
  refreshSeconds: 120,
};

describe('quick settings rows', () => {
  it('lists every setting once with its current value, grouped by separators', () => {
    const rows = buildQuickSettingsRows(values, t);
    const settings = rows.flatMap((row) => (row.separator === true ? [] : [row]));
    assert.deepEqual(
      settings.map((row) => row.key),
      [...SETTING_KEYS],
    );
    const value = (key: string) => settings.find((row) => row.key === key)?.value;
    assert.equal(value('language'), 'Tiếng Việt');
    assert.equal(value('confirmSwitch'), 'Off');
    assert.equal(value('autoSwitch'), 'Switch automatically');
    assert.equal(value('autoStrategy'), 'Use quota that resets soonest first');
    assert.equal(value('statusBar'), 'Slot and usage');
    assert.equal(value('sortOrder'), 'By slot number');
    assert.equal(value('refresh'), 'every 2 min');
    assert.ok(rows.some((row) => row.separator === true));
  });

  it('says when the auto-switch rules are not loaded instead of guessing a strategy', () => {
    const rows = buildQuickSettingsRows({ ...values, confirmSwitch: true, autoSwitchStrategy: undefined }, t);
    const value = (key: string) => rows.flatMap((row) => (row.separator !== true && row.key === key ? [row.value] : []))[0];
    assert.equal(value('autoStrategy'), 'rules not loaded');
    assert.equal(value('confirmSwitch'), 'On');
  });

  it('validates keys and language values passed from outside', () => {
    assert.equal(isSettingKey('refresh'), true);
    assert.equal(isSettingKey('cliPath'), false);
    assert.equal(isSettingKey(undefined), false);
    assert.equal(isLanguageSetting('vi'), true);
    assert.equal(isLanguageSetting('fr'), false);
    assert.equal(languageLabel('auto', t), 'Automatic (follow VS Code)');
    assert.equal(languageLabel('en', t), 'English');
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
