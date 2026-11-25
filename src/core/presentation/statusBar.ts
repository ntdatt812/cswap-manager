import type { CliError } from '../cli/cliErrors';
import type { Account } from '../model/types';
import { activeAccount } from '../model/reconcile';
import type { AccountsState, FreshnessAssessment } from '../service/refreshService';
import {
  accountLevel,
  accountName,
  countdownDue,
  hasUnavailableUsage,
  metricsRow,
  planText,
  relativeAge,
  type PresentationOptions,
  type TooltipModel,
  type TooltipRow,
} from './accountTree';
import { compactDuration, epochOf, formatPercent, usageAgeMs, usageBar, windowLabel, type BarStyle, type UsageLevel } from './format';
import type { UsageWindow } from '../model/types';
import { countdownText } from '../../shared/countdown';

export type StatusBarMode = 'slot' | 'slotUsage' | 'nameUsage' | 'custom' | 'hidden';
export const STATUS_BAR_MODES: readonly StatusBarMode[] = ['slotUsage', 'slot', 'nameUsage', 'custom', 'hidden'];

export function isStatusBarMode(value: unknown): value is StatusBarMode {
  return typeof value === 'string' && (STATUS_BAR_MODES as readonly string[]).includes(value);
}

/** Pieces the user can tick for `statusBar.mode: custom`, in display order. */
export const STATUS_BAR_PARTS = ['icon', 'slot', 'name', 'plan', 'bar', 'usage', 'reset'] as const;
export type StatusBarPart = (typeof STATUS_BAR_PARTS)[number];
export const DEFAULT_STATUS_BAR_PARTS: readonly StatusBarPart[] = ['icon', 'slot', 'usage'];

export function isStatusBarPart(value: unknown): value is StatusBarPart {
  return typeof value === 'string' && (STATUS_BAR_PARTS as readonly string[]).includes(value);
}

const PRESET_PARTS: Record<Exclude<StatusBarMode, 'custom' | 'hidden'>, readonly StatusBarPart[]> = {
  slotUsage: ['icon', 'slot', 'usage'],
  slot: ['icon', 'slot'],
  nameUsage: ['icon', 'name', 'usage'],
};

/** What the item shows for a mode, in display order; empty means hidden. */
export function statusBarParts(mode: StatusBarMode, custom: readonly StatusBarPart[]): StatusBarPart[] {
  if (mode === 'hidden') {
    return [];
  }
  const chosen = mode === 'custom' ? custom : PRESET_PARTS[mode];
  return STATUS_BAR_PARTS.filter((part) => chosen.includes(part));
}

/**
 * Extra status bar buttons, in display order. Only actions the status bar has no other way to reach:
 * switching is the account item's own click, and filter/sort only act on the Accounts view.
 */
export const STATUS_BAR_BUTTONS = ['refresh', 'dashboard', 'settings'] as const;
export type StatusBarButton = (typeof STATUS_BAR_BUTTONS)[number];
export const DEFAULT_STATUS_BAR_BUTTONS: readonly StatusBarButton[] = ['settings'];

export function isStatusBarButton(value: unknown): value is StatusBarButton {
  return typeof value === 'string' && (STATUS_BAR_BUTTONS as readonly string[]).includes(value);
}

/** How the usage level colours the item: VS Code's warning/error background, the text only, or not at all. */
export const STATUS_BAR_COLORS = ['background', 'text', 'none'] as const;
export type StatusBarColors = (typeof STATUS_BAR_COLORS)[number];

export function isStatusBarColors(value: unknown): value is StatusBarColors {
  return typeof value === 'string' && (STATUS_BAR_COLORS as readonly string[]).includes(value);
}

/** Same length as the sidebar's and the switch picker's bars, so they read alike. */
export const STATUS_BAR_BAR_WIDTH = 10;

export interface StatusBarModel {
  /** May contain `$(codicon)` syntax; CLI-derived text is sanitized so it cannot add icons. */
  readonly text: string;
  /** When `text` ends with a countdown: the text before it and its due time, so it can tick alone. */
  readonly countdown?: { readonly prefix: string; readonly at: number };
  readonly tooltip: TooltipModel;
  readonly level: UsageLevel;
  readonly accessibilityLabel: string;
}

export interface StatusBarOptions extends PresentationOptions {
  readonly mode: StatusBarMode;
  /** Used when `mode` is `custom`. */
  readonly parts?: readonly StatusBarPart[];
  /** Overrides `PresentationOptions.barStyle` (live preview). */
  readonly barStyle?: BarStyle;
  readonly freshness: FreshnessAssessment;
  readonly switching: boolean;
  readonly describeError: (error: CliError) => string;
  /** When the next automatic refresh is due: the item then ends with a countdown (`0:42`). */
  readonly nextRefreshAt?: number;
}

const MAX_NAME_LENGTH = 24;

/** Prevents account data from being interpreted as `$(icon)` syntax in status bar text. */
export function sanitizeLabel(text: string): string {
  return text.replace(/\$\(/g, '$​(');
}

function shorten(text: string): string {
  return text.length <= MAX_NAME_LENGTH ? text : `${text.slice(0, MAX_NAME_LENGTH - 1)}…`;
}

/** Concise usage: every window when there are at most two, otherwise only the fullest one. */
export function usageSummary(account: Account, options: PresentationOptions): string | undefined {
  if (hasUnavailableUsage(account)) {
    return options.t('usage {0}', account.usageStatus ?? '');
  }
  const windows = account.usage?.windows ?? [];
  if (windows.length === 0) {
    return undefined;
  }
  const shown =
    windows.length <= 2
      ? windows
      : [windows.reduce((fullest, window) => ((window.pct ?? -1) > (fullest.pct ?? -1) ? window : fullest))];
  return shown.map((window) => `${windowLabel(window.key)} ${window.pct === undefined ? '?' : formatPercent(window.pct)}`).join(' · ');
}

/** The window that limits the account: the fullest one with a known percentage. */
export function fullestWindow(account: Account): UsageWindow | undefined {
  return (account.usage?.windows ?? [])
    .filter((window) => window.pct !== undefined)
    .reduce<UsageWindow | undefined>((fullest, window) => (fullest === undefined || (window.pct ?? 0) > (fullest.pct ?? 0) ? window : fullest), undefined);
}

const LEVEL_ICON: Record<UsageLevel, string> = { unknown: 'account', normal: 'account', warning: 'warning', critical: 'error' };

function tooltipFor(account: Account | undefined, state: AccountsState, options: StatusBarOptions): TooltipModel {
  const { t } = options;
  const rows: TooltipRow[] = [];
  const notes: string[] = [];
  const snapshot = state.snapshot;

  if (account !== undefined && snapshot !== undefined) {
    rows.push({ label: t('Slot'), value: String(account.slot) });
    if (account.displayName !== undefined) {
      rows.push({ label: t('Display name'), value: account.displayName });
    }
    if (account.email !== undefined) {
      rows.push({ label: t('Email'), value: account.email });
    }
    const plan = planText(account, t);
    if (plan !== undefined) {
      rows.push({ label: t('Plan'), value: plan });
    }
    if (hasUnavailableUsage(account)) {
      rows.push({ label: t('Usage status'), value: account.usageStatus ?? '' });
    }
    for (const window of account.usage?.windows ?? []) {
      rows.push(metricsRow(windowLabel(window.key), window, options));
    }
    for (const scope of account.usage?.scoped ?? []) {
      rows.push(metricsRow(scope.name, scope, options));
    }
    const age = usageAgeMs(account, snapshot.capturedAt, options.now);
    if (age !== undefined) {
      rows.push({ label: t('Usage updated'), value: relativeAge(age, t) });
    }
  }

  if (options.switching) {
    notes.push(t('Switching accounts…'));
  }
  if (snapshot === undefined) {
    notes.push(state.lastError ? options.describeError(state.lastError) : t('Loading accounts from cswap…'));
  } else {
    if (snapshot.active.slot === undefined) {
      notes.push(
        snapshot.active.activeUnmanaged ? t('The current Claude login is not managed by cswap.') : t('The active account is unknown.'),
      );
    }
    if (options.freshness.freshness === 'stale') {
      const updated = state.lastSuccessAt === undefined ? t('earlier') : relativeAge(options.now - state.lastSuccessAt, t);
      notes.push(
        state.lastError
          ? t('Stale: last refresh failed ({0}). Data from {1}.', options.describeError(state.lastError), updated)
          : t('Stale: data from {0}.', updated),
      );
    }
  }
  notes.push(t('Click to switch accounts.'));
  return { title: t('Cswap — active account'), rows, notes };
}

/** Returns undefined when the status bar item should be hidden. */
export function buildStatusBarModel(state: AccountsState, options: StatusBarOptions): StatusBarModel | undefined {
  const shown = statusBarParts(options.mode, options.parts ?? DEFAULT_STATUS_BAR_PARTS);
  if (shown.length === 0) {
    return undefined;
  }
  const { t } = options;
  const snapshot = state.snapshot;
  const account = snapshot === undefined ? undefined : activeAccount(snapshot);
  const tooltip = tooltipFor(account, state, options);

  if (options.switching) {
    return { text: `$(sync~spin) ${t('Cswap: switching…')}`, tooltip, level: 'unknown', accessibilityLabel: t('Cswap is switching accounts') };
  }
  if (snapshot === undefined) {
    const failed = state.lastError !== undefined && !state.refreshing;
    return {
      text: failed ? '$(error) Cswap' : '$(sync~spin) Cswap',
      tooltip,
      level: failed ? 'critical' : 'unknown',
      accessibilityLabel: failed ? t('Cswap: accounts could not be loaded') : t('Cswap: loading accounts'),
    };
  }

  const level = account === undefined ? 'unknown' : accountLevel(account, options.thresholds);
  const stale = options.freshness.freshness === 'stale';
  const slotText = account === undefined ? '#?' : `#${account.slot}`;
  const usage = account === undefined ? undefined : usageSummary(account, options);
  const fullest = account === undefined || hasUnavailableUsage(account) ? undefined : fullestWindow(account);
  const has = (part: StatusBarPart) => shown.includes(part);
  const segments: string[] = [];
  if (has('slot')) {
    segments.push(slotText);
  }
  if (has('name') && (account !== undefined || !has('slot'))) {
    segments.push(account === undefined ? slotText : sanitizeLabel(shorten(accountName(account, t))));
  }
  const plan = account?.plan?.displayName ?? account?.plan?.label;
  if (has('plan') && plan !== undefined) {
    segments.push(sanitizeLabel(shorten(plan)));
  }
  // The bar sits right before the percentage it draws, as one segment.
  const usageSegment = [
    has('bar') && fullest?.pct !== undefined ? usageBar(fullest.pct, STATUS_BAR_BAR_WIDTH, options.barStyle, { icons: true }) : undefined,
    has('usage') && usage !== undefined ? sanitizeLabel(usage) : undefined,
  ].filter((piece): piece is string => piece !== undefined);
  if (usageSegment.length > 0) {
    segments.push(usageSegment.join(' '));
  }
  const reset = epochOf(fullest?.resetsAt);
  if (has('reset') && reset !== undefined && reset > options.now) {
    segments.push(`↻ ${compactDuration(reset - options.now)}`);
  }
  if (segments.length === 0 && !has('icon')) {
    // Whatever was ticked has nothing to show right now; never leave an empty item.
    segments.push(slotText);
  }
  const icon = has('icon') ? `$(${LEVEL_ICON[level]})` : '';
  const base = [icon, segments.join(' · ')].filter((piece) => piece !== '').join(' ');
  // Stale data keeps its clock icon instead of a countdown.
  const due = countdownDue(options.nextRefreshAt, options.freshness, state.refreshing);
  const countdown = due === undefined ? undefined : { prefix: `${base}${segments.length > 0 ? ' · ' : ' '}`, at: due };
  const text = countdown === undefined ? `${base}${stale ? ' $(history)' : ''}` : `${countdown.prefix}${countdownText(countdown.at - options.now)}`;
  const spoken = account === undefined ? t('Cswap: active account unknown') : t('Cswap: active slot {0}. {1}', account.slot, usage ?? '');
  return { text, ...(countdown === undefined ? {} : { countdown }), tooltip, level, accessibilityLabel: stale ? `${spoken} ${t('(stale)')}` : spoken };
}
