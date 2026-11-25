import { displayNameKey } from './displayNames';
import type { AccountsSnapshot } from './types';

const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** File in the extension's global storage (shared by every window on this computer). */
export const USAGE_HISTORY_FILE = 'usage-history.json';
/** The dashboard shows this much history. */
export const HISTORY_SPAN_MS = 7 * DAY_MS;
/** Readings older than this are dropped. */
export const HISTORY_KEEP_MS = 8 * DAY_MS;
/** One account's readings closer together than this are thinned; the newer one is kept. */
export const HISTORY_MIN_GAP_MS = 30 * MINUTE_MS;
/** At most this many readings in all (about 8 accounts × 8 days at one every 30 minutes); the oldest go first. */
export const HISTORY_MAX_POINTS = 3000;
/**
 * Readings dated later than this after now are dropped (from the file and from snapshots): a
 * future-dated point would otherwise outlive pruning and always win the cap.
 */
export const HISTORY_MAX_AHEAD_MS = 60 * MINUTE_MS;

/** Limits for reading the file back: it may have been damaged or edited by hand. */
const MAX_ACCOUNTS = 200;
const MAX_SERIES = 24;
const MAX_NAME_LENGTH = 64;
const MAX_PCT = 1000;

/** One measured reading of an account. */
export interface UsagePoint {
  /** When cswap measured it (its `usageFetchedAt`, else when the snapshot was read), epoch ms. */
  readonly at: number;
  /** Usage % per window key (`sevenDay`, `fiveHour`, …), as cswap reported it. */
  readonly windows: Readonly<Record<string, number>>;
  /** Usage % per scoped entry name (e.g. a model). */
  readonly scoped?: Readonly<Record<string, number>>;
}

/** Readings per account, oldest first. Keys are `displayNameKey` (a short hash): no email is stored. */
export interface UsageHistory {
  readonly accounts: Readonly<Record<string, readonly UsagePoint[]>>;
}

export interface UsageReading {
  readonly key: string;
  readonly point: UsagePoint;
}

export const EMPTY_USAGE_HISTORY: UsageHistory = { accounts: {} };

function roundPct(pct: number): number {
  return Math.round(pct * 10) / 10;
}

function percentages(entries: ReadonlyArray<{ readonly name: string; readonly pct?: number }>): Record<string, number> {
  const values: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.pct !== undefined && Number.isFinite(entry.pct)) {
      values[entry.name] = roundPct(entry.pct);
    }
  }
  return values;
}

/**
 * The readings a snapshot holds: one per account with current usage and an email (accounts are keyed
 * by its hash). The time is when cswap measured the usage; a reading without that time is only taken
 * while cswap calls the usage current, so old data is never stamped as new. A reading dated more than
 * {@link HISTORY_MAX_AHEAD_MS} after `now` is left out.
 */
export function readingsFromSnapshot(snapshot: AccountsSnapshot, now: number): UsageReading[] {
  const readings: UsageReading[] = [];
  for (const account of snapshot.accounts) {
    const key = displayNameKey(account);
    const usage = account.usage;
    if (key === undefined || usage === undefined) {
      continue;
    }
    const fetched = account.usageFetchedAt === undefined ? Number.NaN : Date.parse(account.usageFetchedAt);
    const current = account.usageStatus === undefined || account.usageStatus.toLowerCase() === 'ok';
    if (Number.isNaN(fetched) && !current) {
      continue;
    }
    const windows = percentages(usage.windows.map((window) => ({ name: window.key, pct: window.pct })));
    const scoped = percentages(usage.scoped);
    if (Object.keys(windows).length === 0 && Object.keys(scoped).length === 0) {
      continue;
    }
    const at = Number.isNaN(fetched) ? snapshot.capturedAt : fetched;
    if (at > now + HISTORY_MAX_AHEAD_MS) {
      continue;
    }
    readings.push({ key, point: { at, windows, ...(Object.keys(scoped).length === 0 ? {} : { scoped }) } });
  }
  return readings;
}

/**
 * Sorted by time; one point per time (the later one in the input wins); every point except the newest
 * at least {@link HISTORY_MIN_GAP_MS} after the one before it, so the newest reading keeps replacing
 * a tail that came too soon; nothing older than {@link HISTORY_KEEP_MS}.
 */
function normalizePoints(points: readonly UsagePoint[], now: number): UsagePoint[] {
  const oldest = now - HISTORY_KEEP_MS;
  const sorted = points
    .map((point, order) => ({ point, order }))
    .filter(({ point }) => point.at >= oldest)
    .sort((a, b) => a.point.at - b.point.at || a.order - b.order)
    .map(({ point }) => point);
  const kept: UsagePoint[] = [];
  for (const point of sorted) {
    const last = kept[kept.length - 1];
    if (last !== undefined && last.at === point.at) {
      kept[kept.length - 1] = point;
      continue;
    }
    const beforeLast = kept[kept.length - 2];
    if (last !== undefined && beforeLast !== undefined && last.at - beforeLast.at < HISTORY_MIN_GAP_MS) {
      kept.pop();
    }
    kept.push(point);
  }
  return kept;
}

/** Keeps at most {@link HISTORY_MAX_POINTS} readings (and {@link MAX_ACCOUNTS} accounts), newest first. */
function capPoints(accounts: Record<string, UsagePoint[]>): Record<string, UsagePoint[]> {
  let keys = Object.keys(accounts).filter((key) => (accounts[key]?.length ?? 0) > 0);
  const newest = (key: string): number => accounts[key]?.at(-1)?.at ?? 0;
  if (keys.length > MAX_ACCOUNTS) {
    keys = [...keys].sort((a, b) => newest(b) - newest(a)).slice(0, MAX_ACCOUNTS);
  }
  const total = keys.reduce((sum, key) => sum + (accounts[key]?.length ?? 0), 0);
  if (total <= HISTORY_MAX_POINTS) {
    return Object.fromEntries(keys.map((key) => [key, accounts[key] ?? []]));
  }
  const times = keys.flatMap((key) => (accounts[key] ?? []).map((point) => point.at)).sort((a, b) => b - a);
  const cutoff = times[HISTORY_MAX_POINTS - 1] ?? 0;
  // Ties at the cutoff time are dropped too, so the total never exceeds the cap.
  const tied = times.slice(0, HISTORY_MAX_POINTS).filter((at) => at === cutoff).length;
  let tiesLeft = tied;
  const capped: Record<string, UsagePoint[]> = {};
  for (const key of keys) {
    const points = (accounts[key] ?? []).filter((point) => {
      if (point.at > cutoff) {
        return true;
      }
      if (point.at === cutoff && tiesLeft > 0) {
        tiesLeft -= 1;
        return true;
      }
      return false;
    });
    if (points.length > 0) {
      capped[key] = points;
    }
  }
  return capped;
}

function build(sources: ReadonlyArray<Readonly<Record<string, readonly UsagePoint[]>>>, now: number): UsageHistory {
  const grouped: Record<string, UsagePoint[]> = {};
  for (const source of sources) {
    for (const [key, points] of Object.entries(source)) {
      (grouped[key] ??= []).push(...points);
    }
  }
  const normalized: Record<string, UsagePoint[]> = {};
  for (const [key, points] of Object.entries(grouped)) {
    const kept = normalizePoints(points, now);
    if (kept.length > 0) {
      normalized[key] = kept;
    }
  }
  return { accounts: capPoints(normalized) };
}

/** A series' value in a point; only own entries, so a name like `constructor` never reads an inherited member. */
export function pointValue(values: Readonly<Record<string, number>> | undefined, name: string): number | undefined {
  return values !== undefined && Object.hasOwn(values, name) ? values[name] : undefined;
}

function samePoint(a: UsagePoint | undefined, b: UsagePoint): boolean {
  const same = (x: Readonly<Record<string, number>> | undefined, y: Readonly<Record<string, number>> | undefined): boolean => {
    const xKeys = Object.keys(x ?? {});
    return xKeys.length === Object.keys(y ?? {}).length && xKeys.every((key) => pointValue(x, key) === pointValue(y, key));
  };
  return a !== undefined && a.at === b.at && same(a.windows, b.windows) && same(a.scoped, b.scoped);
}

/**
 * The history with the new readings added (thinned, pruned and capped). Returns `history` itself when
 * every reading is already its account's newest point, so callers can skip a write.
 */
export function addReadings(history: UsageHistory, readings: readonly UsageReading[], now: number): UsageHistory {
  if (readings.every((reading) => samePoint(history.accounts[reading.key]?.at(-1), reading.point))) {
    return history;
  }
  const additions: Record<string, UsagePoint[]> = {};
  for (const reading of readings) {
    (additions[reading.key] ??= []).push(reading.point);
  }
  return build([history.accounts, additions], now);
}

/** Both histories in one (another window may have written the file); `b` wins for readings at the same time. */
export function mergeUsageHistories(a: UsageHistory, b: UsageHistory, now: number): UsageHistory {
  return build([a.accounts, b.accounts], now);
}

function readPercentages(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => entry[0].length > 0 && entry[0].length <= MAX_NAME_LENGTH && typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    .filter(([, pct]) => Math.abs(pct) <= MAX_PCT)
    .slice(0, MAX_SERIES);
  return Object.fromEntries(entries);
}

function readPoint(value: unknown, now: number): UsagePoint | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const at = raw['at'];
  const windows = readPercentages(raw['windows']);
  const scoped = raw['scoped'] === undefined ? undefined : readPercentages(raw['scoped']);
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0 || at > now + HISTORY_MAX_AHEAD_MS || windows === undefined) {
    return undefined;
  }
  if (Object.keys(windows).length === 0 && (scoped === undefined || Object.keys(scoped).length === 0)) {
    return undefined;
  }
  return { at, windows, ...(scoped === undefined || Object.keys(scoped).length === 0 ? {} : { scoped }) };
}

/** Reads the stored file; malformed entries are dropped. Undefined when the file is not history at all. */
export function parseUsageHistory(text: string, now: number): UsageHistory | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof root !== 'object' || root === null || (root as Record<string, unknown>)['version'] !== 1) {
    return undefined;
  }
  const accounts = (root as Record<string, unknown>)['accounts'];
  if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) {
    return undefined;
  }
  const read: Record<string, UsagePoint[]> = {};
  for (const [key, points] of Object.entries(accounts as Record<string, unknown>).slice(0, MAX_ACCOUNTS * 2)) {
    if (/^[0-9a-f]{16}$/.test(key) && Array.isArray(points)) {
      read[key] = points
        .slice(-HISTORY_MAX_POINTS)
        .map((point) => readPoint(point, now))
        .filter((point): point is UsagePoint => point !== undefined);
    }
  }
  return build([read], now);
}

export function serializeUsageHistory(history: UsageHistory): string {
  return `${JSON.stringify({ version: 1, accounts: history.accounts })}\n`;
}

export interface SeriesPoint {
  readonly at: number;
  readonly pct: number;
}

export interface SeriesSummary {
  /** The readings of the last {@link HISTORY_SPAN_MS}, oldest first. */
  readonly points: readonly SeriesPoint[];
  /**
   * Usage added per day: the rises between consecutive readings (a drop is a reset and is left out)
   * over the measured time between the first and last reading. Only with 3 readings or more over at
   * least a day; it describes what was measured and says nothing about what comes next.
   */
  readonly averagePerDay?: number;
}

/** One usage window of one account over the last {@link HISTORY_SPAN_MS}. */
export function summarizeWindow(points: readonly UsagePoint[], windowKey: string, now: number): SeriesSummary {
  const start = now - HISTORY_SPAN_MS;
  const series = points
    .filter((point) => point.at >= start)
    .flatMap((point) => {
      const pct = pointValue(point.windows, windowKey);
      return pct === undefined ? [] : [{ at: point.at, pct }];
    });
  const first = series[0];
  const last = series[series.length - 1];
  if (first === undefined || last === undefined || series.length < 3 || last.at - first.at < DAY_MS) {
    return { points: series };
  }
  let added = 0;
  for (let index = 1; index < series.length; index++) {
    const rise = (series[index]?.pct ?? 0) - (series[index - 1]?.pct ?? 0);
    if (rise > 0) {
      added += rise;
    }
  }
  return { points: series, averagePerDay: added / ((last.at - first.at) / DAY_MS) };
}
