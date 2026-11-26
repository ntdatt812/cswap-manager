import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSnapshot } from '../../src/core/model/reconcile';
import type { Account, UsageWindow } from '../../src/core/model/types';
import { rowColumns, usageColumnsText, type PresentationOptions, type Translate } from '../../src/core/presentation/accountTree';
import { buildDashboardModel } from '../../src/core/presentation/dashboard';
import { DEFAULT_THRESHOLDS, FIGURE_SPACE, NO_WINDOW } from '../../src/core/presentation/format';
import {
  fiveHourLimit,
  limitNames,
  limitProfile,
  NO_LIMITS_KNOWN,
  switchThresholdHelp,
  weeklyThresholdHelp,
  weeklyThresholdVisible,
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
/** An account whose usage cannot be read (e.g. a setup-token account). */
const unread = (slot: number, plan?: string): Account => ({ slot, ...(plan === undefined ? {} : { plan: { displayName: plan } }) });

describe('limitProfile', () => {
  it('knows nothing before any usage arrives', () => {
    const profile = limitProfile([{ slot: 1 }]);
    assert.deepEqual(profile.keys, []);
    assert.equal(fiveHourLimit(profile), 'unknown');
    assert.equal(limitNames(profile, t), 'overall');
  });

  it('names only the weekly limit when every account is weekly-only', () => {
    const profile = limitProfile([ultra(1), ultra(2)]);
    assert.deepEqual(profile.keys, ['sevenDay']);
    assert.equal(profile.plansByKey.size, 0);
    assert.equal(fiveHourLimit(profile), 'no');
    assert.equal(limitNames(profile, t), 'weekly');
    assert.equal(limitNames(profile, t, ['Fable']), 'weekly and Fable');
  });

  it('names both limits, unqualified, when every plan has both', () => {
    const profile = limitProfile([max(1), max(2)]);
    assert.equal(fiveHourLimit(profile), 'yes');
    assert.equal(limitNames(profile, t), '5-hour and weekly');
    assert.equal(limitNames(profile, t, ['Fable']), '5-hour, weekly and Fable');
  });

  it('names the plans that have a limit the other plans lack', () => {
    const profile = limitProfile([max(1), ultra(2)]);
    assert.deepEqual(profile.plansByKey.get('fiveHour'), ['Max']);
    assert.equal(profile.plansByKey.has('sevenDay'), false);
    assert.equal(limitNames(profile, t), '5-hour (Max) and weekly');
  });

  it('puts list and bracket punctuation through the translator', () => {
    const zh: Translate = (message, ...args) => t(message === '{0}, {1}' ? '{0}、{1}' : message === '{0} ({1})' ? '{0}（{1}）' : message, ...args);
    assert.equal(limitNames(limitProfile([max(1), ultra(2)]), zh, ['Fable']), '5-hour（Max）、weekly and Fable');
  });

  it('reads the last known usage of an account whose current reading failed', () => {
    const stale: Account = { slot: 3, plan: { displayName: 'Pro' }, lastGoodUsage: { windows: [{ key: 'fiveHour', pct: 10 }], scoped: [] } };
    assert.deepEqual(limitProfile([stale]).keys, ['fiveHour']);
  });

  it('counts an unread account by its plan name, and stays unsure about a plan never seen', () => {
    assert.equal(fiveHourLimit(limitProfile([ultra(1), unread(2, 'Ultra')])), 'no', 'another Ultra account shows what Ultra has');
    assert.equal(fiveHourLimit(limitProfile([ultra(1), unread(2, 'Max')])), 'unknown', 'a Max account that cannot be read');
    assert.equal(fiveHourLimit(limitProfile([ultra(1), unread(2)])), 'unknown', 'no plan known');
  });

  it('does not qualify a window by plan when plans are unknown', () => {
    const profile = limitProfile([account(1, undefined, { fiveHour: 1, sevenDay: 2 }), account(2, undefined, { sevenDay: 3 })]);
    assert.equal(limitNames(profile, t), '5-hour and weekly');
  });
});

describe('auto-switch threshold help', () => {
  it('weekly-only accounts never read about a 5-hour limit, and get one threshold', () => {
    const profile = limitProfile([ultra(1)]);
    assert.equal(switchThresholdHelp(profile, false, t), 'Switch when the weekly limit reaches this usage.');
    assert.equal(switchThresholdHelp(profile, true, t), 'The weekly threshold decides when these accounts switch.');
    assert.equal(weeklyThresholdVisible(profile, false), false);
    // Once set it stays listed, so it can be cleared.
    assert.equal(weeklyThresholdVisible(profile, true), true);
    for (const text of [switchThresholdHelp(profile, false, t), switchThresholdHelp(profile, true, t), weeklyThresholdHelp(profile, t)]) {
      assert.doesNotMatch(text, /5-hour/, text);
    }
  });

  it('with 5-hour limits: both thresholds, cswap wording', () => {
    const profile = limitProfile([max(1)]);
    assert.equal(switchThresholdHelp(profile, false, t), 'Switch when the 5-hour limit reaches this usage; while no weekly threshold is set, the other limits too.');
    assert.equal(weeklyThresholdVisible(profile, false), true);
    assert.match(weeklyThresholdHelp(profile, t), /^Separate line for the 7-day/);
  });

  it('while unsure (nothing read yet, or an unread account of an unseen plan): neutral wording, both thresholds', () => {
    for (const profile of [NO_LIMITS_KNOWN, limitProfile([ultra(1), unread(2, 'Max')])]) {
      assert.match(switchThresholdHelp(profile, false, t), /^Switch when a usage limit reaches this usage/);
      assert.equal(weeklyThresholdVisible(profile, false), true);
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

  it('an account without a window keeps that column as ‒% (a figure dash is as wide as a digit), so the columns line up', () => {
    const accounts = [max(1), ultra(2, 50)];
    const columns = rowColumns(accounts);
    assert.deepEqual(columns.windowKeys, ['fiveHour', 'sevenDay']);
    const [maxRow, ultraRow] = accounts.map((entry) => usageColumnsText(entry, options, columns));
    assert.deepEqual(maxRow?.slice(0, 2), ['5h 38%', '7d 46%']);
    assert.deepEqual(ultraRow?.slice(0, 2), [`5h ${FIGURE_SPACE}${NO_WINDOW}%`, '7d 50%']);
    assert.equal(NO_WINDOW, '‒', 'FIGURE DASH');
    assert.equal(maxRow?.[0]?.length, ultraRow?.[0]?.length);
  });

  it('shows an unknown percentage as ?% so the % column stays put', () => {
    const accounts = [max(1), { slot: 2, usage: { windows: [{ key: 'fiveHour' }, { key: 'sevenDay', pct: 3 }], scoped: [] } } satisfies Account];
    const columns = rowColumns(accounts);
    assert.equal(usageColumnsText(accounts[1]!, options, columns)[0], `5h ${FIGURE_SPACE}?%`);
  });

  it('draws a missing window with no percentage, so a bar can show it empty', () => {
    const accounts = [max(1), ultra(2)];
    const bars = usageColumnsText(accounts[1]!, options, rowColumns(accounts), { bar: (window) => (window.pct === undefined ? '[none]' : '[bar]') });
    assert.match(bars[0] ?? '', /\[none\]/);
    assert.match(bars[1] ?? '', /\[bar\]/);
  });

  it('the dashboard table keeps a line for a window an account lacks, in the same order on every row', () => {
    const snapshot = buildSnapshot({ accounts: [max(1), ultra(2, 50)], warnings: [], activeAccountNumber: 1 }, undefined, NOW);
    const model = buildDashboardModel(
      { refreshing: false, snapshot, lastSuccessAt: NOW },
      { ...options, freshness: { freshness: 'fresh' }, switching: false, describeError: (error) => error.message },
    );
    const lines = model.rows.map((row) => row.usage.map((cell) => `${cell.label}${cell.absent === undefined ? '' : ' (absent)'}`));
    assert.deepEqual(lines, [
      ['5h', '7d'],
      ['5h (absent)', '7d'],
    ]);
  });
});
