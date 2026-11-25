import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayNameKey } from '../../src/core/model/displayNames';
import { parseListOutput } from '../../src/core/model/parsers';
import { buildSnapshot } from '../../src/core/model/reconcile';
import type { AccountsSnapshot } from '../../src/core/model/types';
import {
  DEFAULT_USAGE_ALERT_PCT,
  MAX_NOTICE_ID_LENGTH,
  MAX_NOTICE_RECORDS,
  loginReminders,
  noticeShown,
  normalizeUsageAlertPct,
  readNoticeRecords,
  rememberNotice,
  usageAlert,
  type NoticeRecord,
} from '../../src/core/presentation/notifications';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

type Window = { pct?: number; resetsAt?: string };
type Row = { number: number; email?: string; usageStatus?: string; usage?: Record<string, Window> | null; loginExpiresAt?: string };

function snapshot(rows: Row[], active = 1): AccountsSnapshot {
  const list = parseListOutput(
    JSON.stringify({ schemaVersion: 1, activeAccountNumber: active, accounts: rows.map((row) => ({ usageStatus: 'ok', usage: null, ...row, active: row.number === active })) }),
  );
  assert.ok(list.ok);
  return buildSnapshot(list.value, undefined, 1);
}

describe('usage alert', () => {
  const usage = (fiveHour: number, sevenDay: number, reset = at(2 * HOUR)) => ({ fiveHour: { pct: fiveHour, resetsAt: reset }, sevenDay: { pct: sevenDay, resetsAt: at(4 * DAY) } });

  it("reports the active account's limiting window once it reaches the level", () => {
    const current = snapshot([
      { number: 1, email: 'a@example.com', usage: usage(92, 40) },
      { number: 2, email: 'b@example.com', usage: usage(99, 99) },
    ]);
    const alert = usageAlert(current, 90, NOW);
    assert.ok(alert);
    assert.equal(alert.account.slot, 1, 'the active account, not the fullest one');
    assert.equal(alert.window.key, 'fiveHour');
    assert.equal(alert.pct, 92);
    assert.deepEqual(alert.notice, { id: `usage|${displayNameKey(alert.account)}|fiveHour`, at: NOW + 2 * HOUR, until: NOW + 2 * HOUR });
    assert.ok(!alert.notice.id.includes('example.com'), 'no email in what is stored');
    assert.equal(usageAlert(current, 92, NOW)?.pct, 92, 'at the level counts');
  });

  it('stays quiet below the level, when off, without usage, and for a reading whose reset has passed', () => {
    const below = snapshot([{ number: 1, email: 'a@example.com', usage: usage(89.9, 40) }]);
    assert.equal(usageAlert(below, 90, NOW), undefined);
    const full = snapshot([{ number: 1, email: 'a@example.com', usage: usage(97, 40) }]);
    assert.equal(usageAlert(full, 0, NOW), undefined, '0 turns it off');
    const unavailable = snapshot([{ number: 1, email: 'a@example.com', usageStatus: 'unavailable', usage: usage(97, 40) }]);
    assert.equal(usageAlert(unavailable, 90, NOW), undefined);
    assert.equal(usageAlert(snapshot([{ number: 1, email: 'a@example.com' }]), 90, NOW), undefined, 'no usage reported');
    const old = snapshot([{ number: 1, email: 'a@example.com', usage: { fiveHour: { pct: 97, resetsAt: at(-MINUTE) } } }]);
    assert.equal(usageAlert(old, 90, NOW), undefined);
    assert.equal(usageAlert(snapshot([{ number: 2, email: 'b@example.com', usage: usage(99, 99) }]), 90, NOW), undefined, 'no active account');
  });

  it('is shown once per account, window and reset period, even when the reset time wobbles', () => {
    const first = usageAlert(snapshot([{ number: 1, email: 'a@example.com', usage: usage(91, 40) }]), 90, NOW);
    assert.ok(first);
    const records = rememberNotice([], first.notice, NOW);
    const later = usageAlert(snapshot([{ number: 1, email: 'a@example.com', usage: usage(96, 40, at(2 * HOUR + MINUTE)) }]), 90, NOW + 10 * MINUTE);
    assert.ok(later);
    assert.equal(noticeShown(records, later.notice), true, 'same period, reset time moved by a minute');
    const nextPeriod = usageAlert(snapshot([{ number: 1, email: 'a@example.com', usage: usage(91, 40, at(7 * HOUR)) }]), 90, NOW + 3 * HOUR);
    assert.ok(nextPeriod);
    assert.equal(noticeShown(records, nextPeriod.notice), false, 'a new period alerts again');
    const weekly = usageAlert(snapshot([{ number: 1, email: 'a@example.com', usage: usage(50, 93) }]), 90, NOW);
    assert.ok(weekly);
    assert.equal(noticeShown(records, weekly.notice), false, 'another window');
    const moved = usageAlert(snapshot([{ number: 1, email: 'c@example.com', usage: usage(91, 40) }]), 90, NOW);
    assert.ok(moved);
    assert.equal(noticeShown(records, moved.notice), false, 'another account in the slot');
  });

  it('names an account without an email by its slot', () => {
    const alert = usageAlert(snapshot([{ number: 3, usage: usage(95, 10) }], 3), 90, NOW);
    assert.equal(alert?.notice.id, 'usage|slot3|fiveHour');
  });

  it('keeps the id short enough to be read back when cswap reports a very long window key', () => {
    const longKey = (char: string) => char.repeat(300);
    const alertFor = (key: string) => usageAlert(snapshot([{ number: 1, email: 'a@example.com', usage: { [key]: { pct: 95, resetsAt: at(2 * HOUR) } } }]), 90, NOW);
    const alert = alertFor(longKey('w'));
    assert.ok(alert);
    assert.equal(alert.window.key, longKey('w'), 'the window itself is untouched');
    assert.ok(alert.notice.id.length <= MAX_NOTICE_ID_LENGTH, `${alert.notice.id.length} characters`);
    assert.match(alert.notice.id, /^usage\|[0-9a-f]{16}\|#[0-9a-f]{16}$/);
    const readBack = readNoticeRecords(JSON.parse(JSON.stringify(rememberNotice([], alert.notice, NOW))));
    assert.deepEqual(readBack, [alert.notice], 'not dropped on read-back');
    assert.equal(noticeShown(readBack, alertFor(longKey('w'))?.notice ?? alert.notice), true, 'so it is not repeated');
    assert.notEqual(alertFor(longKey('v'))?.notice.id, alert.notice.id, 'another long key is another notice');
    assert.equal(alertFor('x'.repeat(64))?.notice.id.endsWith(`|${'x'.repeat(64)}`), true, 'a key up to 64 characters is kept as it is');
  });

  it('reads the level from settings, clamped to 0–100', () => {
    assert.equal(normalizeUsageAlertPct(undefined), DEFAULT_USAGE_ALERT_PCT);
    assert.equal(normalizeUsageAlertPct('90'), DEFAULT_USAGE_ALERT_PCT);
    assert.equal(normalizeUsageAlertPct(Number.NaN), DEFAULT_USAGE_ALERT_PCT);
    assert.equal(normalizeUsageAlertPct(85), 85);
    assert.equal(normalizeUsageAlertPct(0), 0);
    assert.equal(normalizeUsageAlertPct(150), 100);
    assert.equal(normalizeUsageAlertPct(-5), 0);
  });
});

describe('login expiry reminder', () => {
  const expiringSoon: Row = { number: 1, email: 'a@example.com', loginExpiresAt: at(2 * DAY) };
  const rows: Row[] = [
    expiringSoon,
    { number: 2, email: 'b@example.com', loginExpiresAt: at(-DAY) },
    { number: 3, email: 'c@example.com', loginExpiresAt: at(5 * DAY) },
    { number: 4, email: 'd@example.com' },
    { number: 5, email: 'e@example.com', loginExpiresAt: at(3 * DAY) },
  ];

  it('reminds of logins expiring within three days and of expired ones, in slot order', () => {
    const reminders = loginReminders(snapshot(rows), NOW);
    assert.deepEqual(
      reminders.map((reminder) => [reminder.account.slot, reminder.phase]),
      [
        [1, 'soon'],
        [2, 'expired'],
        [5, 'soon'],
      ],
    );
    const [soon, expired] = reminders;
    assert.ok(soon && expired);
    assert.equal(soon.expiresAt, NOW + 2 * DAY);
    assert.deepEqual(soon.notice, { id: `login|${displayNameKey(soon.account)}|soon`, at: NOW + 2 * DAY, until: NOW + 2 * DAY });
    assert.deepEqual(expired.notice, { id: `login|${displayNameKey(expired.account)}|expired`, at: NOW - DAY }, 'kept until newer notices push it out');
  });

  it('is shown once per login and phase; a renewed login is a new one', () => {
    const [soon] = loginReminders(snapshot([expiringSoon]), NOW);
    assert.ok(soon);
    let records = rememberNotice([], soon.notice, NOW);
    const [again] = loginReminders(snapshot([expiringSoon]), NOW + HOUR);
    assert.ok(again);
    assert.equal(noticeShown(records, again.notice), true, 'same login, next refresh');

    const [expired] = loginReminders(snapshot([expiringSoon]), NOW + 3 * DAY);
    assert.ok(expired);
    assert.equal(expired.phase, 'expired');
    assert.equal(noticeShown(records, expired.notice), false, 'expiring is its own notice');
    records = rememberNotice(records, expired.notice, NOW + 3 * DAY);
    assert.deepEqual(
      records.map((record) => record.id),
      [expired.notice.id],
      'the "soon" notice is forgotten once the login has expired',
    );

    const renewed = loginReminders(snapshot([{ number: 1, email: 'a@example.com', loginExpiresAt: at(3 * DAY + 400 * DAY) }]), NOW + 3 * DAY);
    assert.deepEqual(renewed, [], 'a renewed login far from expiry needs no reminder');
    const [renewedSoon] = loginReminders(snapshot([{ number: 1, email: 'a@example.com', loginExpiresAt: at(30 * DAY) }]), NOW + 28 * DAY);
    assert.ok(renewedSoon);
    assert.equal(noticeShown(rememberNotice([], soon.notice, NOW), renewedSoon.notice), false, 'the new login expiry is a new reminder');
  });
});

describe('remembered notices', () => {
  it('forgets lapsed notices and keeps the newest ones', () => {
    const lapsed: NoticeRecord = { id: 'usage|k|fiveHour', at: NOW - MINUTE, until: NOW - MINUTE };
    const kept: NoticeRecord = { id: 'login|k|expired', at: NOW - DAY };
    const pending: NoticeRecord = { id: 'usage|k|sevenDay', at: NOW + DAY, until: NOW + DAY };
    const added: NoticeRecord = { id: 'login|j|soon', at: NOW + DAY, until: NOW + DAY };
    assert.deepEqual(rememberNotice([lapsed, kept, pending], added, NOW), [kept, pending, added]);

    const many = Array.from({ length: MAX_NOTICE_RECORDS + 5 }, (_, index): NoticeRecord => ({ id: `login|${index}|expired`, at: NOW }));
    const bounded = rememberNotice(many, added, NOW);
    assert.equal(bounded.length, MAX_NOTICE_RECORDS);
    assert.deepEqual(bounded.at(-1), added);
    assert.equal(bounded[0]?.id, 'login|6|expired', 'the oldest go first');
  });

  it('reads back only well-formed records', () => {
    assert.deepEqual(readNoticeRecords(undefined), []);
    assert.deepEqual(readNoticeRecords({ id: 'x' }), []);
    const good: NoticeRecord = { id: 'usage|k|fiveHour', at: NOW, until: NOW };
    assert.deepEqual(readNoticeRecords([good, null, 'text', { id: 3 }, { id: 'a', at: 'soon' }, { id: 'b', until: Number.NaN }, { id: 'login|k|expired' }]), [good, { id: 'login|k|expired' }]);
  });
});
