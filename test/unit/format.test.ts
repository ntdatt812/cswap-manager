import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Account } from '../../src/core/model/types';
import {
  compactDuration,
  formatPercent,
  matchesFilter,
  maxUsagePct,
  normalizeThresholds,
  sortAccounts,
  usageAgeMs,
  usageBar,
  usageLevel,
  windowLabel,
  worstLevel,
} from '../../src/core/presentation/format';

const account = (slot: number, pct: number | undefined, resetsAt?: string, extra: Partial<Account> = {}): Account => ({
  slot,
  email: `user${slot}@example.com`,
  usage: { windows: [{ key: 'sevenDay', ...(pct === undefined ? {} : { pct }), ...(resetsAt ? { resetsAt } : {}) }], scoped: [] },
  ...extra,
});

describe('format helpers', () => {
  it('formats percentages and bars, clamping only for drawing', () => {
    assert.equal(formatPercent(40), '40%');
    assert.equal(formatPercent(42.66), '42.7%');
    assert.equal(usageBar(40), '████░░░░░░');
    assert.equal(usageBar(130), '██████████');
    assert.equal(usageBar(-5), '░░░░░░░░░░');
    // The last cell is drawn partly filled where the style allows it.
    assert.equal(usageBar(94, 8), '███████▌');
    assert.equal(usageBar(94, 8, 'circles'), '●●●●●●●◐');
    assert.equal(usageBar(94, 8, 'squares'), '■■■■■■■◧');
    assert.equal(usageBar(94, 10, 'squares'), '■■■■■■■■■◧');
    // Below 100% never looks full; above 0% never looks empty.
    assert.equal(usageBar(94, 8, 'parallelograms'), '▰▰▰▰▰▰▰▱');
    assert.equal(usageBar(99.9, 8), '███████▉');
    assert.equal(usageBar(1, 10), '▏░░░░░░░░░');
    assert.equal(usageBar(1, 8, 'parallelograms'), '▰▱▱▱▱▱▱▱');
    for (const style of ['blocks', 'parallelograms', 'circles', 'squares'] as const) {
      for (let pct = 0; pct <= 100; pct += 0.5) {
        assert.equal([...usageBar(pct, 8, style)].length, 8, `${style} ${pct}% keeps its width`);
      }
    }
    assert.equal(usageBar(50, 4, 'circles'), '●●○○');
    assert.equal(usageBar(150, 4, 'parallelograms'), '▰▰▰▰');
    assert.equal(usageBar(-5, 2, 'squares'), '□□');
  });

  it('classifies usage levels with repaired thresholds', () => {
    const thresholds = normalizeThresholds(90, 70);
    assert.deepEqual(thresholds, { warning: 70, critical: 70 });
    assert.equal(usageLevel(undefined, thresholds), 'unknown');
    assert.equal(usageLevel(69, thresholds), 'normal');
    assert.equal(usageLevel(70, thresholds), 'critical');
    assert.equal(worstLevel(['normal', 'unknown', 'warning']), 'warning');
    assert.equal(worstLevel([]), 'unknown');
  });

  it('formats durations like the CLI', () => {
    assert.equal(compactDuration(4 * 86_400_000 + 30 * 60_000), '4d 0h');
    assert.equal(compactDuration(78 * 60_000), '1h 18m');
    assert.equal(compactDuration(12 * 60_000), '12m');
    assert.equal(compactDuration(10_000), '<1m');
    assert.equal(compactDuration(-1), '<1m');
  });

  it('labels known windows compactly and humanizes unknown keys', () => {
    assert.equal(windowLabel('sevenDay'), '7d');
    assert.equal(windowLabel('fiveHour'), '5h');
    assert.equal(windowLabel('sevenDayOpus'), 'Seven day opus');
    assert.equal(windowLabel('monthly_burst'), 'Monthly burst');
  });

  it('computes max usage across windows and scopes', () => {
    const withScope: Account = { slot: 1, usage: { windows: [{ key: 'a', pct: 10 }], scoped: [{ name: 'm', pct: 55 }] } };
    assert.equal(maxUsagePct(withScope), 55);
    assert.equal(maxUsagePct({ slot: 2 }), undefined);
  });

  it('ages usage data from the CLI age plus time since capture', () => {
    assert.equal(usageAgeMs({ slot: 1, usageAgeSeconds: 60 }, 1000, 31_000), 90_000);
    assert.equal(usageAgeMs({ slot: 1, usageFetchedAt: '1970-01-01T00:00:10.000Z' }, 0, 70_000), 60_000);
    assert.equal(usageAgeMs({ slot: 1 }, 0, 1), undefined);
  });
});

describe('sortAccounts', () => {
  const accounts = [
    account(3, 50, '2026-11-25T00:00:00Z'),
    account(1, undefined),
    account(2, 90, '2026-11-24T06:00:00Z'),
    account(4, 50, '2026-11-24T05:00:00Z'),
  ];

  it('defaults to slot order', () => {
    assert.deepEqual(sortAccounts(accounts, 'slot').map((a) => a.slot), [1, 2, 3, 4]);
  });

  it('sorts by usage with unknown last and slot as tie-breaker', () => {
    assert.deepEqual(sortAccounts(accounts, 'mostUsed').map((a) => a.slot), [2, 3, 4, 1]);
    assert.deepEqual(sortAccounts(accounts, 'leastUsed').map((a) => a.slot), [3, 4, 2, 1]);
  });

  it('sorts by soonest reset', () => {
    assert.deepEqual(sortAccounts(accounts, 'soonestReset').map((a) => a.slot), [4, 2, 3, 1]);
  });

  it('does not mutate its input', () => {
    sortAccounts(accounts, 'mostUsed');
    assert.deepEqual(accounts.map((a) => a.slot), [3, 1, 2, 4]);
  });
});

describe('matchesFilter', () => {
  const target = account(5, 40, undefined, { organizationName: 'Acme Labs', plan: { label: 'Ultra', tier: 'max_20x' }, usageStatus: 'ok' });

  it('matches slot, email, organization, plan and status case-insensitively', () => {
    for (const query of ['5', '#5', 'USER5', 'acme', 'ultra', 'max_20x', 'ok', 'acme ultra']) {
      assert.equal(matchesFilter(target, query), true, query);
    }
  });

  it('requires every term to match', () => {
    assert.equal(matchesFilter(target, 'acme pro'), false);
    assert.equal(matchesFilter(target, '   '), true);
  });
});
