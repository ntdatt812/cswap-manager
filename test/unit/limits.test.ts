import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Account, UsageWindow } from '../../src/core/model/types';
import { rowColumns, usageColumnsText, type PresentationOptions, type Translate } from '../../src/core/presentation/accountTree';
import { DEFAULT_THRESHOLDS, FIGURE_SPACE, NO_WINDOW } from '../../src/core/presentation/format';
import {
  limitNames,
  limitProfile,
  mayReport,
  NO_LIMITS_KNOWN,
  showWeeklyThreshold,
  switchThresholdHelp,
  weeklyThresholdHelp,
} from '../../src/core/presentation/limits';
import { tokenUsageLabel } from '../../src/core/presentation/quickSettings';

const t: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
const NOW = Date.parse('2026-11-25T12:00:00Z');
const options: PresentationOptions = { now: NOW, thresholds: DEFAULT_THRESHOLDS, t, formatDateTime: (epoch) => new Date(epoch).toISOString() };

function account(slot: number, plan: string | undefined, windows: Record<string, number>): Account {
  const usageWindows: UsageWindow[] = Object.entries(windows).map(([key, pct]) => ({ key, pct, resetsAt: '2026-11-27T12:00:00Z' }));
  return { slot, ...(plan === undefined ? {} : { plan: { displayName: plan } }), usage: { windows: usageWindows, scoped: [] } };
}

const ultra = (slot: number, weekly = 40) => account(slot, 'Ultra', { sevenDay: weekly });
const max = (slot: number) => account(slot, 'Max', { fiveHour: 38, sevenDay: 46 });

describe('limitProfile', () => {
  it('knows nothing before any usage arrives, and then hides nothing', () => {
    const profile = limitProfile([{ slot: 1 }]);
    assert.deepEqual(profile.keys, []);
    assert.equal(mayReport(profile, 'fiveHour'), true);
    assert.equal(limitNames(profile, t), 'overall');
  });

  it('names only the weekly limit when every account is weekly-only', () => {
    const profile = limitProfile([ultra(1), ultra(2)]);
    assert.deepEqual(profile.keys, ['sevenDay']);
    assert.equal(profile.plansByKey.size, 0);
    assert.equal(mayReport(profile, 'fiveHour'), false);
    assert.equal(limitNames(profile, t), 'weekly');
    assert.equal(limitNames(profile, t, ['Fable']), 'weekly and Fable');
  });

  it('names both limits, unqualified, when every plan has both', () => {
    const profile = limitProfile([max(1), max(2)]);
    assert.equal(limitNames(profile, t), '5-hour and weekly');
    assert.equal(limitNames(profile, t, ['Fable']), '5-hour, weekly and Fable');
  });

  it('names the plans that have a limit the other plans lack', () => {
    const profile = limitProfile([max(1), ultra(2)]);
    assert.deepEqual(profile.plansByKey.get('fiveHour'), ['Max']);
    assert.equal(profile.plansByKey.has('sevenDay'), false);
    assert.equal(limitNames(profile, t), '5-hour (Max) and weekly');
  });

  it('reads the last known usage of an account whose current reading failed', () => {
    const stale: Account = { slot: 3, plan: { displayName: 'Pro' }, lastGoodUsage: { windows: [{ key: 'fiveHour', pct: 10 }], scoped: [] } };
    assert.deepEqual(limitProfile([stale]).keys, ['fiveHour']);
  });

  it('does not qualify a window by plan when plans are unknown', () => {
    const profile = limitProfile([account(1, undefined, { fiveHour: 1, sevenDay: 2 }), account(2, undefined, { sevenDay: 3 })]);
    assert.equal(limitNames(profile, t), '5-hour and weekly');
  });
});

describe('auto-switch threshold help', () => {
  it('without a 5-hour limit: one threshold, weekly wording', () => {
    const profile = limitProfile([ultra(1)]);
    assert.equal(switchThresholdHelp(profile, false, t), 'Switch when the weekly limit reaches this usage.');
    assert.equal(showWeeklyThreshold(profile, false), false);
    // Once set it stays visible, so it can be cleared.
    assert.equal(showWeeklyThreshold(profile, true), true);
    assert.match(switchThresholdHelp(profile, true, t), /no 5-hour limit, so the weekly threshold decides/);
    assert.match(weeklyThresholdHelp(profile, t), /^Used instead of the switch threshold/);
  });

  it('with 5-hour limits (or nothing known yet): both thresholds, cswap wording', () => {
    for (const profile of [limitProfile([max(1)]), NO_LIMITS_KNOWN]) {
      assert.equal(switchThresholdHelp(profile, false, t), 'Switch when the 5-hour limit reaches this usage; while no weekly threshold is set, the other limits too.');
      assert.equal(showWeeklyThreshold(profile, false), true);
      assert.match(weeklyThresholdHelp(profile, t), /^Separate line for the 7-day/);
    }
  });

  it('mixed plans: says which plans have the 5-hour limit', () => {
    assert.match(switchThresholdHelp(limitProfile([max(1), ultra(2)]), false, t), /^Switch when the 5-hour limit \(Max\) reaches/);
  });
});

describe('token usage labels', () => {
  it('name the limits the accounts have', () => {
    const weeklyOnly = limitProfile([ultra(1)]);
    assert.equal(tokenUsageLabel('haiku', t, weeklyOnly), 'Weekly limits');
    assert.equal(tokenUsageLabel('fable', t, weeklyOnly), 'Weekly and Fable limits');
    assert.equal(tokenUsageLabel('haiku', t, limitProfile([max(1)])), '5-hour and weekly limits');
    assert.equal(tokenUsageLabel('haiku', t), 'Overall limits');
    assert.equal(tokenUsageLabel('off', t, weeklyOnly), 'Off');
  });
});

describe('usage columns across plans', () => {
  it('weekly-only accounts get no 5-hour column at all', () => {
    const accounts = [ultra(1), ultra(2, 5)];
    const columns = rowColumns(accounts);
    assert.deepEqual(columns.windowKeys, ['sevenDay']);
    assert.match(usageColumnsText(accounts[1]!, options, columns)[0] ?? '', /^7d /);
  });

  it('an account without a window keeps that column, so the same windows line up', () => {
    const accounts = [max(1), ultra(2, 50)];
    const columns = rowColumns(accounts);
    assert.deepEqual(columns.windowKeys, ['fiveHour', 'sevenDay']);
    const [maxRow, ultraRow] = accounts.map((entry) => usageColumnsText(entry, options, columns));
    assert.deepEqual(maxRow?.slice(0, 2), ['5h 38%', '7d 46%']);
    assert.deepEqual(ultraRow?.slice(0, 2), [`5h ${FIGURE_SPACE}${NO_WINDOW}`, '7d 50%']);
  });

  it('draws a missing window with no percentage, so a bar can show it empty', () => {
    const accounts = [max(1), ultra(2)];
    const bars = usageColumnsText(accounts[1]!, options, rowColumns(accounts), { bar: (window) => (window.pct === undefined ? '[none]' : '[bar]') });
    assert.match(bars[0] ?? '', /\[none\]/);
    assert.match(bars[1] ?? '', /\[bar\]/);
  });
});
