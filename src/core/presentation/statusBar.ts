import type { CliError } from '../cli/cliErrors';
import type { Account } from '../model/types';
import { activeAccount } from '../model/reconcile';
import type { AccountsState, FreshnessAssessment } from '../service/refreshService';
import {
  accountLevel,
  accountName,
  hasUnavailableUsage,
  metricsDescription,
  planText,
  relativeAge,
  type PresentationOptions,
  type TooltipModel,
  type TooltipRow,
} from './accountTree';
import { formatPercent, usageAgeMs, windowLabel, type UsageLevel } from './format';

export type StatusBarMode = 'slot' | 'slotUsage' | 'nameUsage' | 'hidden';
export const STATUS_BAR_MODES: readonly StatusBarMode[] = ['slotUsage', 'slot', 'nameUsage', 'hidden'];

export function isStatusBarMode(value: unknown): value is StatusBarMode {
  return typeof value === 'string' && (STATUS_BAR_MODES as readonly string[]).includes(value);
}

export interface StatusBarModel {
  /** May contain `$(codicon)` syntax; CLI-derived text is sanitized so it cannot add icons. */
  readonly text: string;
  readonly tooltip: TooltipModel;
  readonly level: UsageLevel;
  readonly accessibilityLabel: string;
}

export interface StatusBarOptions extends PresentationOptions {
  readonly mode: StatusBarMode;
  readonly freshness: FreshnessAssessment;
  readonly switching: boolean;
  readonly describeError: (error: CliError) => string;
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

const LEVEL_ICON: Record<UsageLevel, string> = { unknown: 'account', normal: 'account', warning: 'warning', critical: 'error' };

function tooltipFor(account: Account | undefined, state: AccountsState, options: StatusBarOptions): TooltipModel {
  const { t } = options;
  const rows: TooltipRow[] = [];
  const notes: string[] = [];
  const snapshot = state.snapshot;

  if (account !== undefined && snapshot !== undefined) {
    rows.push({ label: t('Slot'), value: String(account.slot) });
    if (account.alias !== undefined) {
      rows.push({ label: t('Alias'), value: account.alias });
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
      rows.push({ label: windowLabel(window.key), value: metricsDescription(window, options) });
    }
    for (const scope of account.usage?.scoped ?? []) {
      rows.push({ label: scope.name, value: metricsDescription(scope, options) });
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
  if (options.mode === 'hidden') {
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
  const parts: string[] = [];
  switch (options.mode) {
    case 'slot':
      parts.push(slotText);
      break;
    case 'slotUsage':
      parts.push(slotText, ...(usage === undefined ? [] : [sanitizeLabel(usage)]));
      break;
    case 'nameUsage':
      parts.push(account === undefined ? slotText : sanitizeLabel(shorten(accountName(account, t))), ...(usage === undefined ? [] : [sanitizeLabel(usage)]));
      break;
  }
  const text = `$(${LEVEL_ICON[level]}) ${parts.join(' · ')}${stale ? ' $(history)' : ''}`;
  const spoken = account === undefined ? t('Cswap: active account unknown') : t('Cswap: active slot {0}. {1}', account.slot, usage ?? '');
  return { text, tooltip, level, accessibilityLabel: stale ? `${spoken} ${t('(stale)')}` : spoken };
}
