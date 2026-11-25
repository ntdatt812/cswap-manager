import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayNameKey } from '../../src/core/model/displayNames';
import type { Account, AccountsSnapshot } from '../../src/core/model/types';
import {
  DAY_MS,
  EMPTY_USAGE_HISTORY,
  HISTORY_KEEP_MS,
  HISTORY_MAX_AHEAD_MS,
  HISTORY_MAX_POINTS,
  addReadings,
  mergeUsageHistories,
  parseUsageHistory,
  pointValue,
  readingsFromSnapshot,
  serializeUsageHistory,
  summarizeWindow,
  type UsageHistory,
  type UsagePoint,
  type UsageReading,
} from '../../src/core/model/usageHistory';
import type { Translate } from '../../src/core/presentation/accountTree';
import { buildAccountDetail, type DashboardOptions } from '../../src/core/presentation/dashboard';
import { DEFAULT_THRESHOLDS } from '../../src/core/presentation/format';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const KEY = 'aaaaaaaaaaaaaaaa';

function account(overrides: Partial<Account> = {}): Account {
  return {
    slot: 1,
    email: 'dev@example.com',
    usageStatus: 'ok',
    usageFetchedAt: new Date(NOW - 5 * MINUTE).toISOString(),
    usage: {
      windows: [
        { key: 'fiveHour', pct: 12.34 },
        { key: 'sevenDay', pct: 40 },
      ],
      scoped: [{ name: 'Fable', pct: 3 }],
    },
    ...overrides,
  };
}

function snapshot(accounts: Account[], capturedAt = NOW): AccountsSnapshot {
  return { accounts, active: { slot: 1, consistency: 'consistent', verifiedWithStatus: false }, capturedAt, warnings: [] };
}

function point(at: number, sevenDay: number, extra: Record<string, number> = {}): UsagePoint {
  return { at, windows: { sevenDay, ...extra } };
}

function reading(at: number, sevenDay: number, key = KEY): UsageReading {
  return { key, point: point(at, sevenDay) };
}

function times(history: UsageHistory, key = KEY): number[] {
  return (history.accounts[key] ?? []).map((entry) => (entry.at - NOW) / MINUTE);
}

describe('readingsFromSnapshot', () => {
  it('takes one reading per account, keyed by the hash (no email), at cswap\'s fetch time', () => {
    const subject = account();
    const [first, ...rest] = readingsFromSnapshot(snapshot([subject]), NOW);
    assert.deepEqual(rest, []);
    assert.equal(first?.key, displayNameKey(subject));
    assert.deepEqual(first?.point, { at: NOW - 5 * MINUTE, windows: { fiveHour: 12.3, sevenDay: 40 }, scoped: { Fable: 3 } });
    assert.doesNotMatch(JSON.stringify(first), /example\.com|dev@/);
  });

  it('uses the snapshot time when cswap gives no fetch time, but only for current usage', () => {
    const { usageFetchedAt: _omit, ...noTime } = account();
    assert.equal(readingsFromSnapshot(snapshot([noTime], NOW - 1000), NOW)[0]?.point.at, NOW - 1000);
    assert.deepEqual(readingsFromSnapshot(snapshot([{ ...noTime, usageStatus: 'stale' }]), NOW), []);
    assert.equal(readingsFromSnapshot(snapshot([account({ usageStatus: 'stale' })]), NOW).length, 1, 'a timed reading is real whatever the status');
  });

  it('skips accounts without email, without usage or without any percentage', () => {
    const { email: _omit, ...noEmail } = account();
    const { usage: _none, ...noUsage } = account();
    const noPct = account({ usage: { windows: [{ key: 'sevenDay' }], scoped: [] } });
    assert.deepEqual(readingsFromSnapshot(snapshot([noEmail, noUsage, noPct]), NOW), []);
  });

  it('leaves out a reading dated more than an hour ahead', () => {
    const ahead = (offset: number) => account({ usageFetchedAt: new Date(NOW + offset).toISOString() });
    assert.equal(readingsFromSnapshot(snapshot([ahead(HISTORY_MAX_AHEAD_MS)]), NOW).length, 1, 'an hour ahead (clock drift) is kept');
    assert.deepEqual(readingsFromSnapshot(snapshot([ahead(HISTORY_MAX_AHEAD_MS + 1)]), NOW), []);
    assert.deepEqual(readingsFromSnapshot(snapshot([ahead(365 * DAY_MS)]), NOW), []);
    const { usageFetchedAt: _omit, ...noTime } = account();
    assert.deepEqual(readingsFromSnapshot(snapshot([noTime], NOW + 2 * HOUR), NOW), [], 'also by the snapshot time');
  });
});

describe('addReadings', () => {
  it('keeps the newer reading when two are closer than 30 minutes, and keeps readings 30 minutes apart', () => {
    let history = EMPTY_USAGE_HISTORY;
    for (let minute = -120; minute <= 0; minute += 2) {
      history = addReadings(history, [reading(NOW + minute * MINUTE, 10)], NOW);
    }
    assert.deepEqual(times(history), [-120, -90, -60, -30, 0]);
    history = addReadings(history, [reading(NOW + 10 * MINUTE, 11)], NOW + 10 * MINUTE);
    assert.deepEqual(times(history), [-120, -90, -60, -30, 0, 10], 'the newest reading is always kept');
    history = addReadings(history, [reading(NOW + 20 * MINUTE, 12)], NOW + 20 * MINUTE);
    assert.deepEqual(times(history), [-120, -90, -60, -30, 0, 20], 'and replaces a tail that came too soon');
  });

  it('returns the same history when nothing is new (same reading again)', () => {
    const history = addReadings(EMPTY_USAGE_HISTORY, [reading(NOW, 10)], NOW);
    assert.equal(addReadings(history, [reading(NOW, 10)], NOW), history);
    assert.notEqual(addReadings(history, [reading(NOW, 11)], NOW), history, 'a corrected value at the same time replaces it');
    assert.equal(addReadings(history, [], NOW), history);
  });

  it('drops readings older than 8 days', () => {
    const old = NOW - HISTORY_KEEP_MS - MINUTE;
    const history = addReadings(EMPTY_USAGE_HISTORY, [reading(old, 5), reading(NOW - DAY_MS, 6), { ...reading(old, 5), key: 'bbbbbbbbbbbbbbbb' }], NOW);
    assert.deepEqual(times(history), [-24 * 60]);
    assert.equal(history.accounts['bbbbbbbbbbbbbbbb'], undefined, 'an account with no readings left is removed');
  });

  it('keeps at most 3000 readings in all, dropping the oldest', () => {
    // 9 accounts with a reading every 31 minutes: 9 × 372 readings fall within the 8 days kept.
    const readings: UsageReading[] = [];
    for (let index = 0; index < 9 * 400; index++) {
      const key = String(index % 9).repeat(16);
      readings.push(reading(NOW - Math.floor(index / 9) * 31 * MINUTE, 1, key));
    }
    assert.equal(readings.filter((entry) => entry.point.at >= NOW - HISTORY_KEEP_MS).length, 9 * 372);
    const history = addReadings(EMPTY_USAGE_HISTORY, readings, NOW);
    const all = Object.values(history.accounts).flat();
    assert.equal(all.length, HISTORY_MAX_POINTS);
    const newestDropped = Math.max(...readings.map((entry) => entry.point.at).filter((at) => !all.some((kept) => kept.at === at)), 0);
    assert.ok(Math.min(...all.map((entry) => entry.at)) >= newestDropped, 'only the oldest readings were dropped');
  });
});

describe('mergeUsageHistories, parse and serialize', () => {
  it('merges what another window wrote with the new readings', () => {
    const disk = addReadings(EMPTY_USAGE_HISTORY, [reading(NOW - 2 * HOUR, 10), reading(NOW - HOUR, 20, 'bbbbbbbbbbbbbbbb')], NOW);
    const mine = addReadings(EMPTY_USAGE_HISTORY, [reading(NOW - 90 * MINUTE, 15), reading(NOW, 30)], NOW);
    const merged = mergeUsageHistories(disk, mine, NOW);
    assert.deepEqual(times(merged), [-120, -90, 0]);
    assert.deepEqual(times(merged, 'bbbbbbbbbbbbbbbb'), [-60]);
  });

  it('reads back what it wrote', () => {
    const history = addReadings(EMPTY_USAGE_HISTORY, [{ key: KEY, point: { at: NOW, windows: { sevenDay: 40 }, scoped: { Fable: 2 } } }], NOW);
    assert.deepEqual(parseUsageHistory(serializeUsageHistory(history), NOW), history);
  });

  it('treats a damaged or foreign file as unreadable', () => {
    for (const text of ['', '{', 'null', '[]', '{"accounts":{}}', '{"version":2,"accounts":{}}', '{"version":1,"accounts":[]}']) {
      assert.equal(parseUsageHistory(text, NOW), undefined, text);
    }
  });

  it('drops malformed entries and keys that are not account hashes', () => {
    const text = JSON.stringify({
      version: 1,
      accounts: {
        [KEY]: [
          { at: NOW, windows: { sevenDay: 40, bad: 'x', huge: 1e9 } },
          { at: 'yesterday', windows: { sevenDay: 1 } },
          { at: NOW - HOUR, windows: {} },
          { at: NOW - 2 * HOUR, windows: { sevenDay: 5 }, scoped: 'x' },
          null,
        ],
        'dev@example.com': [{ at: NOW, windows: { sevenDay: 1 } }],
      },
    });
    const parsed = parseUsageHistory(text, NOW);
    assert.deepEqual(parsed, { accounts: { [KEY]: [{ at: NOW - 2 * HOUR, windows: { sevenDay: 5 } }, { at: NOW, windows: { sevenDay: 40 } }] } });
  });

  it('drops readings dated more than an hour ahead, so they neither outlive pruning nor win the cap', () => {
    const future = NOW + 365 * DAY_MS;
    const text = JSON.stringify({
      version: 1,
      accounts: {
        [KEY]: [
          { at: NOW - HOUR, windows: { sevenDay: 5 } },
          { at: NOW + HISTORY_MAX_AHEAD_MS, windows: { sevenDay: 6 } },
          { at: NOW + HISTORY_MAX_AHEAD_MS + 1, windows: { sevenDay: 7 } },
          { at: future, windows: { sevenDay: 8 } },
        ],
        bbbbbbbbbbbbbbbb: [{ at: future, windows: { sevenDay: 9 } }],
      },
    });
    const parsed = parseUsageHistory(text, NOW);
    assert.deepEqual(parsed, { accounts: { [KEY]: [{ at: NOW - HOUR, windows: { sevenDay: 5 } }, { at: NOW + HISTORY_MAX_AHEAD_MS, windows: { sevenDay: 6 } }] } });
    // Even years later the old points are pruned normally: nothing from the future is left to keep.
    assert.deepEqual(parseUsageHistory(serializeUsageHistory(parsed ?? EMPTY_USAGE_HISTORY), NOW + 30 * DAY_MS), EMPTY_USAGE_HISTORY);
  });
});

describe('own entries only', () => {
  it('never reads an inherited member such as constructor as a reading', () => {
    const points = [point(NOW - 2 * DAY_MS, 1), point(NOW - DAY_MS, 2), point(NOW, 3)];
    assert.deepEqual(summarizeWindow(points, 'constructor', NOW), { points: [] });
    assert.deepEqual(summarizeWindow(points, 'toString', NOW), { points: [] });
    assert.equal(pointValue({ sevenDay: 4 }, 'hasOwnProperty'), undefined);
    assert.equal(pointValue({ constructor: 4 }, 'constructor'), 4, 'an own entry with that name is read');
    const parsed = parseUsageHistory(JSON.stringify({ version: 1, accounts: { [KEY]: [{ at: NOW, windows: { constructor: 7 } }] } }), NOW);
    assert.deepEqual(parsed && summarizeWindow(parsed.accounts[KEY] ?? [], 'constructor', NOW).points, [{ at: NOW, pct: 7 }], 'read back from the file too');
  });
});

describe('summarizeWindow', () => {
  const series = (entries: Array<[number, number]>): UsagePoint[] => entries.map(([hoursAgo, pct]) => point(NOW - hoursAgo * HOUR, pct));

  it('averages the measured rises per day', () => {
    const summary = summarizeWindow(series([[48, 10], [36, 14], [24, 20], [0, 26]]), 'sevenDay', NOW);
    assert.equal(summary.points.length, 4);
    assert.equal(summary.averagePerDay, 8);
  });

  it('leaves out a drop (a reset) instead of counting it as negative', () => {
    const summary = summarizeWindow(series([[48, 80], [24, 90], [12, 2], [0, 6]]), 'sevenDay', NOW);
    assert.equal(summary.averagePerDay, (10 + 4) / 2);
  });

  it('gives no average under 3 readings or under a day measured', () => {
    assert.equal(summarizeWindow(series([[48, 10], [0, 30]]), 'sevenDay', NOW).averagePerDay, undefined);
    assert.equal(summarizeWindow(series([[20, 10], [10, 12], [0, 30]]), 'sevenDay', NOW).averagePerDay, undefined);
    assert.deepEqual(summarizeWindow([], 'sevenDay', NOW), { points: [] });
  });

  it('only uses the last 7 days and the asked window', () => {
    const points = [point(NOW - 7 * DAY_MS - HOUR, 1), point(NOW - 2 * DAY_MS, 2, { fiveHour: 50 }), point(NOW - DAY_MS, 3), point(NOW, 4, { fiveHour: 60 })];
    assert.deepEqual(
      summarizeWindow(points, 'sevenDay', NOW).points.map((entry) => entry.pct),
      [2, 3, 4],
    );
    assert.deepEqual(
      summarizeWindow(points, 'fiveHour', NOW).points.map((entry) => entry.pct),
      [50, 60],
    );
  });
});

describe('dashboard: Last 7 days', () => {
  const t: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
  const options = (usageHistory?: UsageHistory): DashboardOptions => ({
    now: NOW,
    thresholds: DEFAULT_THRESHOLDS,
    t,
    formatDateTime: (epoch) => new Date(epoch).toISOString(),
    freshness: { freshness: 'fresh' },
    switching: false,
    describeError: (error) => error.message,
    ...(usageHistory === undefined ? {} : { usageHistory }),
  });
  const subject = account({ usage: { windows: [{ key: 'fiveHour', pct: 70 }, { key: 'sevenDay', pct: 40 }], scoped: [] } });
  const key = displayNameKey(subject) ?? '';
  const history: UsageHistory = { accounts: { [key]: [point(NOW - 2 * DAY_MS, 20, { fiveHour: 10 }), point(NOW - DAY_MS, 30), point(NOW, 40, { fiveHour: 70 })] } };
  const section = (detailOptions: DashboardOptions, target: Account = subject) =>
    buildAccountDetail(target, snapshot([target]), detailOptions).sections.find((entry) => entry.key === 'history');

  it('is left out when recording is off or the account has no email', () => {
    assert.equal(section(options()), undefined);
    const { email: _omit, ...noEmail } = subject;
    assert.equal(section(options(history), noEmail), undefined);
  });

  it('shows the weekly window and the limiting one, with measured readings only', () => {
    const shown = section(options(history));
    assert.equal(shown?.title, 'Last 7 days');
    assert.deepEqual(
      shown?.sparklines?.map((line) => [line.label, line.caption]),
      [
        ['7d', 'about 10% per day (measured)'],
        ['5h', 'Not enough readings yet'],
      ],
    );
    const weekly = shown?.sparklines?.[0];
    assert.deepEqual(weekly?.points, [
      { x: 71.43, y: 20 },
      { x: 85.71, y: 30 },
      { x: 100, y: 40 },
    ]);
    assert.match(weekly?.description ?? '', /3 readings, latest 40%/);
    assert.ok((weekly?.points ?? []).every((entry) => entry.x <= 100), 'nothing is drawn past now');
  });

  it('shows the weekly line only once when it is also the limiting window, and waits for readings', () => {
    const weeklyFull = account({ usage: { windows: [{ key: 'fiveHour', pct: 5 }, { key: 'sevenDay', pct: 90 }], scoped: [] } });
    const shown = section(options(EMPTY_USAGE_HISTORY), weeklyFull);
    assert.deepEqual(
      shown?.sparklines?.map((line) => [line.label, line.points.length, line.caption]),
      [['7d', 0, 'Not enough readings yet']],
    );
  });
});
