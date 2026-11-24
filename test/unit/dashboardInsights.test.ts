import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseListOutput } from '../../src/core/model/parsers';
import { buildSnapshot } from '../../src/core/model/reconcile';
import type { AccountsSnapshot } from '../../src/core/model/types';
import type { PresentationOptions, Translate } from '../../src/core/presentation/accountTree';
import { buildCapacity, buildInsights, buildTimeline } from '../../src/core/presentation/dashboardInsights';
import { DEFAULT_THRESHOLDS } from '../../src/core/presentation/format';

const t: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
const NOW = Date.parse('2026-11-24T04:00:00Z');
const HOUR = 3_600_000;

interface Row {
  readonly slot: number;
  readonly pct?: number;
  readonly resetInHours?: number;
  readonly disabled?: boolean;
  readonly loginInDays?: number;
}

function snapshotOf(active: number, rows: readonly Row[]): AccountsSnapshot {
  const json = JSON.stringify({
    schemaVersion: 1,
    activeAccountNumber: active,
    accounts: rows.map((row) => ({
      number: row.slot,
      email: `user${row.slot}@example.com`,
      active: row.slot === active,
      usageStatus: 'ok',
      ...(row.disabled === true ? { disabled: true } : {}),
      ...(row.loginInDays === undefined ? {} : { loginExpiresAt: new Date(NOW + row.loginInDays * 24 * HOUR).toISOString() }),
      usage:
        row.pct === undefined
          ? null
          : { sevenDay: { pct: row.pct, ...(row.resetInHours === undefined ? {} : { resetsAt: new Date(NOW + row.resetInHours * HOUR).toISOString() }) } },
    })),
  });
  const list = parseListOutput(json);
  assert.ok(list.ok);
  return buildSnapshot(list.value, undefined, NOW);
}

const options: PresentationOptions = { now: NOW, thresholds: DEFAULT_THRESHOLDS, t, formatDateTime: (epoch) => new Date(epoch).toISOString() };

describe('dashboard suggestions', () => {
  it('suggests the account with the most quota left when the active one is almost used up', () => {
    // The user's real situation: #2 at 97% resets in 2h31m; #4 is untouched.
    const snapshot = snapshotOf(2, [
      { slot: 1, pct: 0, resetInHours: 167 },
      { slot: 2, pct: 97, resetInHours: 2.5 },
      { slot: 3, pct: 47, resetInHours: 52 },
      { slot: 4, pct: 0, resetInHours: 164 },
      { slot: 5, pct: 49, resetInHours: 91 },
    ]);
    const insights = buildInsights(snapshot, options);
    assert.equal(insights[0]?.id, 'switch-now');
    assert.equal(insights[0]?.tone, 'error');
    assert.equal(insights[0]?.switchSlot, 1, 'most headroom, lowest slot on a tie');
    assert.equal(insights[0]?.text, '#2 user2@example.com has 3% left and resets in 2h 30m; #1 user1@example.com has 100% left.');
    // #2 itself resets first, so nothing else is "about to be wasted".
    assert.equal(insights.some((insight) => insight.id === 'use-before-reset'), false);
  });

  it('never suggests an account with less quota left than the active one', () => {
    const snapshot = snapshotOf(1, [
      { slot: 1, pct: 82, resetInHours: 100 },
      { slot: 2, pct: 90, resetInHours: 50 },
    ]);
    const insights = buildInsights(snapshot, options);
    assert.equal(insights[0]?.id, 'all-limited');
    assert.equal(insights.some((insight) => insight.switchSlot === 2), false);
  });

  it('pairs a reset with the window the percentage comes from', () => {
    // 7d is the fuller window; its 60% left must not be said to reset with the 5-hour window.
    const json = JSON.stringify({
      schemaVersion: 1,
      activeAccountNumber: 1,
      accounts: [
        { number: 1, email: 'a@example.com', active: true, usageStatus: 'ok', usage: { sevenDay: { pct: 30, resetsAt: new Date(NOW + 120 * HOUR).toISOString() } } },
        {
          number: 2,
          email: 'b@example.com',
          active: false,
          usageStatus: 'ok',
          usage: {
            fiveHour: { pct: 10, resetsAt: new Date(NOW + 1 * HOUR).toISOString() },
            sevenDay: { pct: 40, resetsAt: new Date(NOW + 60 * HOUR).toISOString() },
          },
        },
      ],
    });
    const list = parseListOutput(json);
    assert.ok(list.ok);
    const insights = buildInsights(buildSnapshot(list.value, undefined, NOW), options);
    assert.match(insights[0]?.text ?? '', /60% left and resets in 2d 12h/);
  });

  it('suggests spending quota that resets before the active account does', () => {
    const snapshot = snapshotOf(1, [
      { slot: 1, pct: 30, resetInHours: 120 },
      { slot: 2, pct: 40, resetInHours: 20 },
      { slot: 3, pct: 90, resetInHours: 10 },
    ]);
    const insights = buildInsights(snapshot, options);
    assert.deepEqual(
      insights.map((insight) => insight.id),
      ['use-before-reset'],
    );
    assert.equal(insights[0]?.switchSlot, 2, '#3 is above the warning line and has little left');
    assert.match(insights[0]?.text ?? '', /60% left and resets in 20h 0m/);
  });

  it('says when no other account can help, with the first reset', () => {
    const snapshot = snapshotOf(1, [
      { slot: 1, pct: 99, resetInHours: 30 },
      { slot: 2, pct: 100, resetInHours: 5 },
      { slot: 3, pct: 50, resetInHours: 2, disabled: true },
    ]);
    const insights = buildInsights(snapshot, options);
    assert.equal(insights[0]?.id, 'all-limited');
    assert.equal(insights[0]?.switchSlot, undefined);
    assert.match(insights[0]?.text ?? '', /#3 user3@example.com in 2h 0m/);
  });

  it('reports all good, and logins due within a week', () => {
    const snapshot = snapshotOf(1, [
      { slot: 1, pct: 20, resetInHours: 50 },
      { slot: 2, pct: 10, resetInHours: 100, loginInDays: 2 },
    ]);
    const insights = buildInsights(snapshot, options);
    assert.deepEqual(
      insights.map((insight) => `${insight.id}:${insight.tone}`),
      ['all-good:ok', 'relogin:warning'],
    );
    assert.match(insights[1]?.text ?? '', /#2: the stored login expires in 2d 0h/);
  });
});

describe('quota left and reset timeline', () => {
  const snapshot = snapshotOf(2, [
    { slot: 1, pct: 0, resetInHours: 200 },
    { slot: 2, pct: 97, resetInHours: 2.5 },
    { slot: 3, pct: 47, resetInHours: 52 },
    { slot: 4, pct: 20, disabled: true },
    { slot: 5 },
  ]);

  it('counts quota left in full accounts, skipping disabled and unknown ones', () => {
    const capacity = buildCapacity(snapshot, { ...options, formatDecimal: (value) => value.toFixed(1).replace('.', ',') });
    assert.equal(capacity?.value, '1,6 / 3');
    assert.equal(capacity?.detail, '2 not counted (disabled or usage unknown)');
    assert.equal(Math.round(capacity?.pct ?? 0), 52);
  });

  it('lists resets within seven days, soonest first, positioned on the axis', () => {
    const timeline = buildTimeline(snapshot, options);
    assert.deepEqual(
      timeline.map((item) => `#${item.slot} ${item.whenText} ${item.remainingText}${item.active ? ' (active)' : ''}`),
      ['#2 in 2h 30m 3% left (active)', '#3 in 2d 4h 53% left'],
    );
    assert.ok(Math.abs((timeline[1]?.position ?? 0) - (52 / 168) * 100) < 0.01);
  });
});
