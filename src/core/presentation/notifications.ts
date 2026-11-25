import { createHash } from 'node:crypto';
import { displayNameKey } from '../model/displayNames';
import { activeAccount } from '../model/reconcile';
import type { Account, AccountsSnapshot, UsageWindow } from '../model/types';
import { hasUnavailableUsage, loginDue } from './accountTree';
import { epochOf } from './format';
import { fullestWindow } from './statusBar';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** `cswapManager.notifyAtUsage` when it is not set: alert at 90% (0 turns the alert off). */
export const DEFAULT_USAGE_ALERT_PCT = 90;

/** The login-expiry reminder comes this long before a stored login expires. */
export const LOGIN_REMINDER_WITHIN_MS = 3 * DAY_MS;

/** At most this many shown notices are remembered; the oldest are forgotten first. */
export const MAX_NOTICE_RECORDS = 50;

/** Longest notice id read back from storage; a longer record is dropped as malformed. */
export const MAX_NOTICE_ID_LENGTH = 200;

/** A usage window key longer than this is named by a hash in a notice id, which keeps ids readable back. */
const MAX_ID_PART_LENGTH = 64;

/**
 * Reset and expiry times this close together are the same time: cswap's readings of a window's
 * reset time move slightly from one fetch to the next, while a new period moves it by hours.
 */
const SAME_TIME_MS = HOUR_MS;

/** A usage alert without a reset time is forgotten after this long. */
const UNTIMED_NOTICE_MS = 7 * DAY_MS;

/**
 * A notice already shown, remembered so a refresh or a window reload does not repeat it. Holds no
 * email: accounts are named by `displayNameKey` (a short hash), or by slot when they have no email.
 */
export interface NoticeRecord {
  /** Kind, account key and usage window or login phase, e.g. `usage|<key>|fiveHour`. */
  readonly id: string;
  /** The reset or login-expiry time the notice was about (epoch ms), when cswap gave one. */
  readonly at?: number;
  /** Forgotten after this time (epoch ms); without it, kept until newer notices push it out. */
  readonly until?: number;
}

/** Clamps a usage alert level to 0–100; anything that is not a number is the default. */
export function normalizeUsageAlertPct(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : DEFAULT_USAGE_ALERT_PCT;
}

function accountKey(account: Account): string {
  return displayNameKey(account) ?? `slot${account.slot}`;
}

/** cswap's own window key, or `#` and a short hash of it when it is long. */
function idPart(value: string): string {
  return value.length <= MAX_ID_PART_LENGTH ? value : `#${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function sameTime(a: number | undefined, b: number | undefined): boolean {
  return a === undefined || b === undefined ? a === b : Math.abs(a - b) < SAME_TIME_MS;
}

/** Whether this notice (same account, window or phase, and time) was shown already. */
export function noticeShown(records: readonly NoticeRecord[], notice: NoticeRecord): boolean {
  return records.some((record) => record.id === notice.id && sameTime(record.at, notice.at));
}

/** The records to keep once `notice` is shown: lapsed ones dropped, newest last, at most {@link MAX_NOTICE_RECORDS}. */
export function rememberNotice(records: readonly NoticeRecord[], notice: NoticeRecord, now: number): NoticeRecord[] {
  return [...records.filter((record) => record.until === undefined || record.until > now), notice].slice(-MAX_NOTICE_RECORDS);
}

function isNoticeRecord(value: unknown): value is NoticeRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const optionalTime = (time: unknown) => time === undefined || (typeof time === 'number' && Number.isFinite(time));
  return typeof record.id === 'string' && record.id.length <= MAX_NOTICE_ID_LENGTH && optionalTime(record.at) && optionalTime(record.until);
}

/** Records read back from storage; anything malformed is dropped. */
export function readNoticeRecords(value: unknown): NoticeRecord[] {
  return Array.isArray(value) ? value.filter(isNoticeRecord).slice(-MAX_NOTICE_RECORDS) : [];
}

export interface UsageAlert {
  readonly account: Account;
  /** The window that limits the account (the fullest one, as on the status bar). */
  readonly window: UsageWindow;
  readonly pct: number;
  /** Once per account, window and reset period. */
  readonly notice: NoticeRecord;
}

/**
 * The active account's limiting window when its usage is at or above `alertPct` (0 = off). Nothing
 * when the usage is not available, or when the window's reset time has passed (an old reading).
 */
export function usageAlert(snapshot: AccountsSnapshot, alertPct: number, now: number): UsageAlert | undefined {
  const account = activeAccount(snapshot);
  if (!(alertPct > 0) || account === undefined || hasUnavailableUsage(account)) {
    return undefined;
  }
  const window = fullestWindow(account);
  const pct = window?.pct;
  const resetAt = epochOf(window?.resetsAt);
  if (window === undefined || pct === undefined || pct < alertPct || (resetAt !== undefined && resetAt <= now)) {
    return undefined;
  }
  const id = `usage|${accountKey(account)}|${idPart(window.key)}`;
  return {
    account,
    window,
    pct,
    notice: resetAt === undefined ? { id, until: now + UNTIMED_NOTICE_MS } : { id, at: resetAt, until: resetAt },
  };
}

/** `soon`: the stored login expires within {@link LOGIN_REMINDER_WITHIN_MS}; `expired`: it has. */
export type LoginPhase = 'soon' | 'expired';

export interface LoginReminder {
  readonly account: Account;
  readonly phase: LoginPhase;
  readonly expiresAt: number;
  /** Once per account, login expiry time and phase: a renewed login has a new expiry time. */
  readonly notice: NoticeRecord;
}

/** Every account whose stored login expires within three days or has expired, in slot order. */
export function loginReminders(snapshot: AccountsSnapshot, now: number): LoginReminder[] {
  return snapshot.accounts.flatMap((account) => {
    const due = loginDue(account, now);
    if (due === undefined || due.expiresAt - now > LOGIN_REMINDER_WITHIN_MS) {
      return [];
    }
    const phase: LoginPhase = due.expired ? 'expired' : 'soon';
    const id = `login|${accountKey(account)}|${phase}`;
    // "Soon" is moot once the login has expired; "expired" stays until newer notices push it out.
    const notice: NoticeRecord = phase === 'soon' ? { id, at: due.expiresAt, until: due.expiresAt } : { id, at: due.expiresAt };
    return [{ account, phase, expiresAt: due.expiresAt, notice }];
  });
}
