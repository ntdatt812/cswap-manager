import type { Account, UsageMetrics } from '../model/types';

export type UsageLevel = 'unknown' | 'normal' | 'warning' | 'critical';

export interface UsageThresholds {
  readonly warning: number;
  readonly critical: number;
}

export const DEFAULT_THRESHOLDS: UsageThresholds = { warning: 80, critical: 95 };

export type SortOrder = 'slot' | 'mostUsed' | 'leastUsed' | 'soonestReset';
export const SORT_ORDERS: readonly SortOrder[] = ['slot', 'mostUsed', 'leastUsed', 'soonestReset'];

export function isSortOrder(value: unknown): value is SortOrder {
  return typeof value === 'string' && (SORT_ORDERS as readonly string[]).includes(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Display thresholds only; a misordered pair is repaired so warning never exceeds critical. */
export function normalizeThresholds(warning: number, critical: number): UsageThresholds {
  const safeWarning = Number.isFinite(warning) ? clamp(warning, 0, 100) : DEFAULT_THRESHOLDS.warning;
  const safeCritical = Number.isFinite(critical) ? clamp(critical, 0, 100) : DEFAULT_THRESHOLDS.critical;
  return { warning: Math.min(safeWarning, safeCritical), critical: safeCritical };
}

export function usageLevel(pct: number | undefined, thresholds: UsageThresholds): UsageLevel {
  if (pct === undefined) {
    return 'unknown';
  }
  if (pct >= thresholds.critical) {
    return 'critical';
  }
  return pct >= thresholds.warning ? 'warning' : 'normal';
}

const LEVEL_RANK: Record<UsageLevel, number> = { unknown: 0, normal: 1, warning: 2, critical: 3 };

export function worstLevel(levels: readonly UsageLevel[]): UsageLevel {
  return levels.reduce<UsageLevel>((worst, level) => (LEVEL_RANK[level] > LEVEL_RANK[worst] ? level : worst), 'unknown');
}

export function formatPercent(pct: number): string {
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

export const BAR_STYLES = ['blocks', 'parallelograms', 'circles', 'squares'] as const;
export type BarStyle = (typeof BAR_STYLES)[number];

export function isBarStyle(value: unknown): value is BarStyle {
  return typeof value === 'string' && (BAR_STYLES as readonly string[]).includes(value);
}

interface BarGlyphs {
  readonly full: string;
  readonly empty: string;
  /** Partly filled cells, from least to most filled; empty when the style has none. */
  readonly partial: readonly string[];
}

const BAR_GLYPHS: Record<BarStyle, BarGlyphs> = {
  // Eighths: a cell can show 1/8 … 7/8.
  blocks: { full: '█', empty: '░', partial: ['▏', '▎', '▍', '▌', '▋', '▊', '▉'] },
  // Unicode has no half parallelogram.
  parallelograms: { full: '▰', empty: '▱', partial: [] },
  circles: { full: '●', empty: '○', partial: ['◐'] },
  squares: { full: '■', empty: '□', partial: ['◧'] },
};

/**
 * Slanted cells drawn by `media/usage-bars.woff` (contributed as icons): `$(cswap-slant-0)` is empty,
 * `$(cswap-slant-8)` full, 1–7 that many eighths. Unicode has no partly filled parallelogram.
 */
function slantIcon(eighths: number): string {
  return `$(cswap-slant-${eighths})`;
}

/** A bar made only of slant icons: the one kind of `$(…)` text an icon-capable surface may render. */
export const SLANT_BAR_PATTERN = /^(?:\$\(cswap-slant-[0-8]\))+$/;

export interface BarOptions {
  /**
   * The bar is shown where `$(icon)` renders (status bar, quick picks, tooltips with theme icons).
   * Tree items cannot, so they get Unicode glyphs only.
   */
  readonly icons?: boolean;
}

/** Whole cells and the partly filled cell's step (out of `steps`), with the never-full/never-empty rules. */
function splitCells(value: number, width: number, steps: number): { whole: number; step: number } {
  const cells = (value / 100) * width;
  let whole = Math.floor(cells);
  let step = Math.round((cells - whole) * steps);
  if (step === steps) {
    whole += 1;
    step = 0;
  }
  if (value < 100 && whole >= width) {
    whole = width - 1;
    step = steps - 1;
  }
  if (value > 0 && whole === 0 && step === 0) {
    if (steps > 1) {
      step = 1;
    } else {
      whole = 1;
    }
  }
  return { whole, step };
}

/**
 * Progress bar (`cswapManager.display.barStyle`); the CLI value is clamped to 0–100 only for
 * drawing. The last cell is drawn partly filled where the style can: eighths for blocks, and for
 * slanted cells where icons render; halves for dots and squares. Below 100% the bar never looks
 * full, and above 0% it never looks empty, so a nearly used-up account is not shown as used up.
 */
export function usageBar(pct: number, width = 10, style: BarStyle = 'blocks', options: BarOptions = {}): string {
  const value = clamp(pct, 0, 100);
  if (style === 'parallelograms' && options.icons === true) {
    const { whole, step } = splitCells(value, width, 8);
    return slantIcon(8).repeat(whole) + (step > 0 ? slantIcon(step) : '') + slantIcon(0).repeat(width - whole - (step > 0 ? 1 : 0));
  }
  const { full, empty, partial } = BAR_GLYPHS[style];
  const { whole, step } = splitCells(value, width, partial.length + 1);
  const partGlyph = step > 0 ? (partial[step - 1] ?? '') : '';
  return full.repeat(whole) + partGlyph + empty.repeat(width - whole - (partGlyph === '' ? 0 : 1));
}

/**
 * U+2007 FIGURE SPACE: exactly as wide as a digit in UI fonts with tabular figures (Segoe UI, SF),
 * so numbers padded with it line up in a column even in a proportional font.
 */
export const FIGURE_SPACE = ' ';

/** Pads the number a text starts with to `digits` digits, with figure spaces in front. */
export function padDigits(text: string, digits: number): string {
  const leading = /^\d*/.exec(text)?.[0].length ?? 0;
  return FIGURE_SPACE.repeat(Math.max(0, digits - Math.max(leading, text.startsWith('?') ? 1 : 0))) + text;
}

/** Digits before the decimal point of a percentage as `formatPercent` shows it. */
export function percentDigits(pct: number): number {
  return String(Math.trunc(Math.round(pct * 10) / 10)).length;
}

/** `4d 0h` → `4d  0h` with a figure space: every part after the first takes two digits, so columns line up. */
export function alignedDuration(ms: number): string {
  return compactDuration(ms)
    .split(' ')
    .map((part, index) => (index === 0 ? part : padDigits(part, 2)))
    .join(' ');
}

/** Compact duration in the CLI's own style: `4d 0h`, `1h 18m`, `12m`, `<1m`. */
export function compactDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  if (totalMinutes < 1) {
    return '<1m';
  }
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Short labels for window keys seen in cswap output or help; any other key is humanized. */
const KNOWN_WINDOW_LABELS: Readonly<Record<string, string>> = { fiveHour: '5h', sevenDay: '7d' };

export function windowLabel(key: string): string {
  const known = KNOWN_WINDOW_LABELS[key];
  if (known !== undefined) {
    return known;
  }
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.length === 0 ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

export function epochOf(iso: string | undefined): number | undefined {
  if (iso === undefined) {
    return undefined;
  }
  const value = Date.parse(iso);
  return Number.isNaN(value) ? undefined : value;
}

function allMetrics(account: Account): UsageMetrics[] {
  return [...(account.usage?.windows ?? []), ...(account.usage?.scoped ?? [])];
}

export function maxUsagePct(account: Account): number | undefined {
  const values = allMetrics(account)
    .map((metrics) => metrics.pct)
    .filter((pct): pct is number => pct !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
}

export function soonestReset(account: Account): number | undefined {
  const values = allMetrics(account)
    .map((metrics) => epochOf(metrics.resetsAt))
    .filter((epoch): epoch is number => epoch !== undefined);
  return values.length === 0 ? undefined : Math.min(...values);
}

/** Age of the account's usage data now: the CLI-reported age plus time since the snapshot. */
export function usageAgeMs(account: Account, capturedAt: number, now: number): number | undefined {
  if (account.usageAgeSeconds !== undefined) {
    return Math.max(0, account.usageAgeSeconds * 1000 + (now - capturedAt));
  }
  const fetched = epochOf(account.usageFetchedAt);
  return fetched === undefined ? undefined : Math.max(0, now - fetched);
}

function compareOptional(a: number | undefined, b: number | undefined, direction: 1 | -1): number {
  if (a === undefined && b === undefined) {
    return 0;
  }
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  return (a - b) * direction;
}

/** Returns a new array; unknown values always sort last and ties keep slot order. */
export function sortAccounts(accounts: readonly Account[], order: SortOrder): Account[] {
  const sorted = [...accounts].sort((a, b) => a.slot - b.slot);
  switch (order) {
    case 'slot':
      return sorted;
    case 'mostUsed':
      return sorted.sort((a, b) => compareOptional(maxUsagePct(a), maxUsagePct(b), -1) || a.slot - b.slot);
    case 'leastUsed':
      return sorted.sort((a, b) => compareOptional(maxUsagePct(a), maxUsagePct(b), 1) || a.slot - b.slot);
    case 'soonestReset':
      return sorted.sort((a, b) => compareOptional(soonestReset(a), soonestReset(b), 1) || a.slot - b.slot);
  }
}

/** Every whitespace-separated term must match the slot, email, alias, organization, plan or usage status. */
export function matchesFilter(account: Account, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) {
    return true;
  }
  const haystack = [
    String(account.slot),
    `#${account.slot}`,
    account.email,
    account.alias,
    account.displayName,
    account.organizationName,
    account.plan?.label,
    account.plan?.displayName,
    account.plan?.tier,
    account.usageStatus,
  ]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toLowerCase());
  return terms.every((term) => haystack.some((value) => value.includes(term)));
}
