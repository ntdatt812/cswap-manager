import type { CliError } from '../cli/cliErrors';
import { accountContextValue } from './accountActions';
import { TESTED_SCHEMA_VERSIONS } from '../model/parsers';
import type { Account, AccountsSnapshot, UsageMetrics, UsageWindow } from '../model/types';
import type { AccountsState, FreshnessAssessment } from '../service/refreshService';
import {
  alignedDuration,
  compactDuration,
  epochOf,
  formatPercent,
  NO_WINDOW,
  padDigits,
  percentDigits,
  matchesFilter,
  sortAccounts,
  usageAgeMs,
  usageBar,
  usageLevel,
  windowLabel,
  worstLevel,
  type SortOrder,
  type UsageLevel,
  type UsageThresholds,
  type BarStyle,
} from './format';
import { countdownText } from '../../shared/countdown';
import { reportedWindowKeys } from './limits';

/** Localization hook: `{0}`-style placeholders, as in `vscode.l10n.t`. */
export type Translate = (message: string, ...args: Array<string | number | boolean>) => string;

export interface IconSpec {
  /** Codicon id. */
  readonly id: string;
  /** Theme color id. */
  readonly color?: string;
}

export interface TooltipRow {
  readonly label: string;
  readonly value: string;
  /** A usage bar from `usageBar` (never CLI text), shown before the value; may be slant icons. */
  readonly bar?: string;
}

/** Plain data; the VS Code layer escapes every string before rendering Markdown. */
export interface TooltipModel {
  readonly title: string;
  readonly rows: readonly TooltipRow[];
  readonly notes?: readonly string[];
}

export type NodeKind = 'account' | 'window' | 'scope' | 'detail';

export interface NodeModel {
  /** Stable across refreshes so VS Code keeps expansion state. */
  readonly id: string;
  readonly kind: NodeKind;
  /** The account's slot, on account nodes and on their child rows (used for switching and drops). */
  readonly slot?: number;
  readonly label: string;
  /** Ranges of the label shown highlighted (e.g. the slot numbers a move just changed). */
  readonly highlights?: ReadonlyArray<readonly [number, number]>;
  readonly description?: string;
  readonly tooltip?: TooltipModel;
  readonly icon?: IconSpec;
  readonly contextValue?: string;
  readonly collapsible: 'none' | 'collapsed' | 'expanded';
  readonly accessibilityLabel?: string;
  readonly children: readonly NodeModel[];
}

export interface PresentationOptions {
  readonly now: number;
  readonly thresholds: UsageThresholds;
  readonly t: Translate;
  /** Locale-aware absolute date/time formatting. */
  readonly formatDateTime: (epoch: number) => string;
  /** Progress bar look everywhere (`cswapManager.display.barStyle`); blocks when unset. */
  readonly barStyle?: BarStyle;
}

export interface TreeBuildOptions extends PresentationOptions {
  readonly sortOrder: SortOrder;
  readonly filter?: string;
  /** Slots whose number is highlighted for a moment after a move. */
  readonly highlightSlots?: ReadonlySet<number>;
}

/**
 * Widths that make the sidebar's numbers line up: tree rows have no columns and a proportional
 * font, but digits and figure spaces share one width, so numbers come first, padded, and names
 * (whose widths vary) come after them.
 */
export interface RowColumns {
  readonly slotDigits: number;
  readonly percentDigits: number;
  /**
   * Every account-wide window the listed accounts report, in first-seen order: an account without
   * one (another plan) keeps its column, so the same windows line up.
   */
  readonly windowKeys: readonly string[];
}

export function rowColumns(accounts: readonly Account[]): RowColumns {
  const percents = accounts.flatMap((account) => [...(account.usage?.windows ?? []), ...(account.usage?.scoped ?? [])].map((window) => window.pct));
  return {
    slotDigits: Math.max(1, ...accounts.map((account) => String(account.slot).length)),
    percentDigits: Math.max(1, ...percents.map((pct) => (pct === undefined ? 1 : percentDigits(pct)))),
    windowKeys: reportedWindowKeys(accounts, true),
  };
}

/** A percentage padded to the column; `?%` when unknown. */
function alignedPercent(pct: number | undefined, columns: RowColumns): string {
  return padDigits(pct === undefined ? '?%' : formatPercent(pct), columns.percentDigits);
}

const LEVEL_COLOR: Record<UsageLevel, string | undefined> = {
  unknown: undefined,
  normal: undefined,
  warning: 'charts.yellow',
  critical: 'charts.red',
};

export function relativeAge(ms: number, t: Translate): string {
  if (ms < 45_000) {
    return t('just now');
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return t('{0}m ago', minutes);
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return t('{0}h ago', hours);
  }
  return t('{0}d ago', Math.round(hours / 24));
}

export function accountName(account: Account, t: Translate): string {
  return account.displayName ?? account.alias ?? account.email ?? t('Account {0}', account.slot);
}

/** The account is shown under a name the user chose, so its email belongs on a second line. */
export function hasCustomName(account: Account): boolean {
  return account.displayName !== undefined || account.alias !== undefined;
}

export function hasUnavailableUsage(account: Account): boolean {
  return account.usageStatus !== undefined && account.usageStatus.toLowerCase() !== 'ok';
}

export function accountLevel(account: Account, thresholds: UsageThresholds): UsageLevel {
  const metrics: UsageMetrics[] = [...(account.usage?.windows ?? []), ...(account.usage?.scoped ?? [])];
  return worstLevel(metrics.map((entry) => usageLevel(entry.pct, thresholds)));
}

function resetText(resetsAt: string | undefined, options: PresentationOptions): string | undefined {
  const epoch = epochOf(resetsAt);
  if (epoch === undefined) {
    return undefined;
  }
  return epoch <= options.now
    ? options.t('reset time passed — refresh to update')
    : options.t('resets in {0}', compactDuration(epoch - options.now));
}

function percentText(pct: number | undefined, t: Translate): string {
  return pct === undefined ? t('unknown') : formatPercent(pct);
}

/** `#3 Name`: how an account is named in messages and pickers. */
export function slotLabel(account: Account, t: Translate): string {
  return `#${account.slot} ${accountName(account, t)}`;
}

function metricsDescription(metrics: UsageMetrics, options: PresentationOptions): string {
  const parts = [metrics.pct === undefined ? options.t('usage unknown') : `${usageBar(metrics.pct, 10, options.barStyle)} ${formatPercent(metrics.pct)}`];
  const reset = resetText(metrics.resetsAt, options);
  if (reset !== undefined) {
    parts.push(reset);
  }
  return parts.join(' · ');
}

/** A tooltip row for a usage window or scope: its bar (icons where the style needs them), percent and reset. */
export function metricsRow(label: string, metrics: UsageMetrics, options: PresentationOptions): TooltipRow {
  if (metrics.pct === undefined) {
    return { label, value: metricsDescription(metrics, options) };
  }
  const reset = resetText(metrics.resetsAt, options);
  return {
    label,
    bar: usageBar(metrics.pct, 10, options.barStyle, { icons: true }),
    value: [formatPercent(metrics.pct), ...(reset === undefined ? [] : [reset])].join(' · '),
  };
}

function metricsRows(metrics: UsageMetrics, options: PresentationOptions): TooltipRow[] {
  const { t } = options;
  const rows: TooltipRow[] = [{ label: t('Used'), value: percentText(metrics.pct, t) }];
  if (metrics.expectedPct !== undefined) {
    rows.push({ label: t('Even pace by now'), value: formatPercent(metrics.expectedPct) });
  }
  if (metrics.aheadOfPace !== undefined) {
    rows.push({ label: t('Ahead of pace'), value: metrics.aheadOfPace ? t('yes') : t('no') });
  }
  const projected = epochOf(metrics.projectedExhaustionAt);
  if (projected !== undefined) {
    rows.push({ label: t('Projected exhaustion'), value: options.formatDateTime(projected) });
  }
  if (metrics.willLastToReset !== undefined) {
    rows.push({ label: t('Lasts until reset'), value: metrics.willLastToReset ? t('yes') : t('no') });
  }
  const reset = epochOf(metrics.resetsAt);
  if (reset !== undefined) {
    rows.push({ label: t('Resets'), value: `${options.formatDateTime(reset)} (${resetText(metrics.resetsAt, options) ?? ''})` });
  }
  return rows;
}

/** A usage row under an account: bar and percentage first (they line up), then the window's name. */
function metricsNode(
  id: string,
  kind: 'window' | 'scope',
  label: string,
  metrics: UsageMetrics,
  options: PresentationOptions,
  slot: number,
  columns: RowColumns,
): NodeModel {
  const level = usageLevel(metrics.pct, options.thresholds);
  const color = LEVEL_COLOR[level];
  const reset = resetText(metrics.resetsAt, options);
  return {
    id,
    kind,
    slot,
    label: metrics.pct === undefined ? label : `${usageBar(metrics.pct, 10, options.barStyle)} ${alignedPercent(metrics.pct, columns)} · ${label}`,
    ...(metrics.pct === undefined ? { description: options.t('usage unknown') } : reset === undefined ? {} : { description: reset }),
    icon: { id: kind === 'window' ? 'dashboard' : 'layers', ...(color ? { color } : {}) },
    tooltip: { title: label, rows: metricsRows(metrics, options) },
    contextValue: `cswap.${kind}`,
    collapsible: 'none',
    accessibilityLabel: `${label}: ${percentText(metrics.pct, options.t)}`,
    children: [],
  };
}

function detailNode(id: string, label: string, description: string, icon: IconSpec, slot: number): NodeModel {
  return { id, kind: 'detail', slot, label, description, icon, contextValue: 'cswap.detail', collapsible: 'none', children: [] };
}

export function planText(account: Account, t: Translate): string | undefined {
  const plan = account.plan;
  if (plan === undefined) {
    return undefined;
  }
  const parts = [plan.displayName ?? plan.label ?? plan.tier].filter((part): part is string => part !== undefined);
  if (plan.subscriptionStatus !== undefined) {
    parts.push(plan.subscriptionStatus);
  }
  if (plan.expired === true) {
    parts.push(t('expired'));
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/**
 * How far ahead a stored login's expiry is worth showing — cswap's own `LOGIN_DUE_WITHIN_S` (7 days).
 * Further out, the expiry is only listed in the account detail, not flagged in the sidebar.
 */
export const LOGIN_DUE_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

export interface LoginDue {
  readonly expired: boolean;
  readonly expiresAt: number;
}

/** The stored login (refresh token) is due for a `/login` within a week, or already lapsed. */
export function loginDue(account: Account, now: number): LoginDue | undefined {
  const expiresAt = epochOf(account.loginExpiresAt);
  if (expiresAt === undefined || expiresAt - now > LOGIN_DUE_WITHIN_MS) {
    return undefined;
  }
  return { expired: expiresAt <= now, expiresAt };
}

/**
 * The organization worth showing: none for the default organization of a personal account, which
 * Anthropic names "<email>'s Organization" and so only repeats the email.
 */
export function shownOrganization(account: Account): string | undefined {
  const name = account.organizationName;
  if (name === undefined || account.email === undefined) {
    return name;
  }
  return name.toLowerCase() === `${account.email.toLowerCase()}'s organization` ? undefined : name;
}

function loginDueText(due: LoginDue, options: PresentationOptions): string {
  const when = options.formatDateTime(due.expiresAt);
  return due.expired ? options.t('now (expired {0})', when) : options.t('in {0} ({1})', compactDuration(due.expiresAt - options.now), when);
}

function accountChildren(account: Account, snapshot: AccountsSnapshot, options: PresentationOptions, columns: RowColumns): NodeModel[] {
  const { t, now } = options;
  const base = `account:${account.slot}`;
  const slot = account.slot;
  const children: NodeModel[] = [];

  for (const window of account.usage?.windows ?? []) {
    children.push(metricsNode(`${base}:window:${window.key}`, 'window', windowLabel(window.key), window, options, slot, columns));
  }
  (account.usage?.scoped ?? []).forEach((scope, index) => {
    children.push(metricsNode(`${base}:scope:${index}:${scope.name}`, 'scope', scope.name, scope, options, slot, columns));
  });

  if (hasUnavailableUsage(account)) {
    children.push(detailNode(`${base}:usageStatus`, t('Usage status'), account.usageStatus ?? '', { id: 'warning', color: 'charts.yellow' }, slot));
  } else if (account.usage === undefined) {
    children.push(detailNode(`${base}:usageStatus`, t('Usage'), t('not reported by cswap'), { id: 'question' }, slot));
  }

  const plan = planText(account, t);
  if (plan !== undefined) {
    const expired = account.plan?.expired === true;
    children.push(detailNode(`${base}:plan`, t('Plan'), plan, expired ? { id: 'warning', color: 'charts.yellow' } : { id: 'credit-card' }, slot));
  }
  const due = loginDue(account, now);
  if (due !== undefined) {
    children.push(
      detailNode(
        `${base}:login`,
        t('Re-login due'),
        loginDueText(due, options),
        { id: due.expired ? 'error' : 'warning', color: due.expired ? 'charts.red' : 'charts.yellow' },
        slot,
      ),
    );
  }
  const age = usageAgeMs(account, snapshot.capturedAt, now);
  if (age !== undefined) {
    children.push(detailNode(`${base}:fetched`, t('Usage updated'), relativeAge(age, t), { id: 'history' }, slot));
  }
  const organization = account.isOrganization === true ? shownOrganization(account) : undefined;
  if (organization !== undefined) {
    children.push(detailNode(`${base}:org`, t('Organization'), organization, { id: 'organization' }, slot));
  }
  return children;
}

function accountIcon(account: Account, isActive: boolean, level: UsageLevel): IconSpec {
  if (isActive) {
    return { id: 'pass-filled', color: LEVEL_COLOR[level] ?? 'charts.green' };
  }
  if (hasUnavailableUsage(account)) {
    return { id: 'circle-slash' };
  }
  switch (level) {
    case 'critical':
      return { id: 'error', color: 'charts.red' };
    case 'warning':
      return { id: 'warning', color: 'charts.yellow' };
    default:
      return { id: 'account' };
  }
}

/** Extras for `usageColumnsText` where a list can show more than the sidebar. */
export interface UsageColumnsStyle {
  /** Drawn between a window's label and its percentage, e.g. a usage bar; `pct` is absent for a column the account has no window for. */
  readonly bar?: (window: UsageWindow) => string;
  /** Applied to each window's label, e.g. where `$(icon)` syntax would render. */
  readonly label?: (label: string) => string;
}

/**
 * The aligned part of an account row (sidebar and switch picker): each window's percentage, then
 * the time to the first window's reset while it is ahead.
 */
export function usageColumnsText(account: Account, options: PresentationOptions, columns: RowColumns, style: UsageColumnsStyle = {}): string[] {
  const windows = account.usage?.windows ?? [];
  const keys = windows.length === 0 ? [] : [...new Set([...columns.windowKeys, ...windows.map((window) => window.key)])];
  const parts = keys.map((key) => {
    const window = windows.find((candidate) => candidate.key === key);
    const label = windowLabel(key);
    // `‒%` (figure dash) is exactly as wide as `5%`, so the columns after it stay aligned.
    const value = window === undefined ? padDigits(`${NO_WINDOW}%`, columns.percentDigits) : alignedPercent(window.pct, columns);
    return [style.label?.(label) ?? label, style.bar?.(window ?? { key }), value].filter((piece) => piece !== undefined).join(' ');
  });
  const firstReset = windows.map((window) => epochOf(window.resetsAt)).find((epoch) => epoch !== undefined);
  if (firstReset !== undefined && firstReset > options.now) {
    parts.push(`↻ ${alignedDuration(firstReset - options.now)}`);
  }
  return parts;
}

/** The dim text after an account's name: what does not line up (rotation, plan, usage problems). */
function accountDescription(account: Account, options: PresentationOptions): string {
  const { t } = options;
  const parts: string[] = [];
  if (account.disabled === true) {
    parts.push(t('disabled'));
  }
  const planLabel = account.plan?.displayName ?? account.plan?.label;
  if (planLabel !== undefined) {
    parts.push(planLabel);
  }
  if (hasUnavailableUsage(account)) {
    parts.push(t('usage {0}', account.usageStatus ?? ''));
  } else if (account.usage === undefined) {
    parts.push(t('usage unknown'));
  }
  return parts.join(' · ');
}

function accountTooltip(account: Account, isActive: boolean, snapshot: AccountsSnapshot, options: PresentationOptions): TooltipModel {
  const { t } = options;
  const rows: TooltipRow[] = [{ label: t('Slot'), value: String(account.slot) }];
  if (account.displayName !== undefined) {
    rows.push({ label: t('Display name'), value: account.displayName });
  }
  if (account.disabled === true) {
    rows.push({ label: t('Rotation'), value: t('disabled (held out of auto-rotation)') });
  }
  if (account.email !== undefined) {
    rows.push({ label: t('Email'), value: account.email });
  }
  const organization = account.isOrganization === true ? shownOrganization(account) : undefined;
  if (organization !== undefined) {
    rows.push({ label: t('Organization'), value: organization });
  }
  const plan = planText(account, t);
  if (plan !== undefined) {
    rows.push({ label: t('Plan'), value: account.plan?.tier ? `${plan} (${account.plan.tier})` : plan });
  }
  if (account.usageStatus !== undefined) {
    rows.push({ label: t('Usage status'), value: account.usageStatus });
  }
  for (const window of account.usage?.windows ?? []) {
    rows.push(metricsRow(windowLabel(window.key), window, options));
  }
  for (const scope of account.usage?.scoped ?? []) {
    rows.push(metricsRow(scope.name, scope, options));
  }
  const due = loginDue(account, options.now);
  if (due !== undefined) {
    rows.push({ label: t('Re-login due'), value: loginDueText(due, options) });
  }
  const age = usageAgeMs(account, snapshot.capturedAt, options.now);
  if (age !== undefined) {
    rows.push({ label: t('Usage updated'), value: relativeAge(age, t) });
  }
  const notes: string[] = [];
  if (isActive) {
    notes.push(snapshot.active.consistency === 'consistent' ? t('Active account.') : t('Active account (sources disagreed; taken from cswap status).'));
  }
  if (due !== undefined) {
    notes.push(t('To renew: log in to this account with /login in Claude Code; the extension then stores the new login.'));
  }
  return { title: accountName(account, t), rows, ...(notes.length > 0 ? { notes } : {}) };
}

/**
 * An account row: `slot · 7d 40% · ↻ 2d 4h · name`, numbers padded so they line up across rows
 * (`rowColumns`), then plan and problems in the dim description. The active account is marked by
 * its icon (and in its tooltip and spoken label).
 */
export function buildAccountNode(
  account: Account,
  snapshot: AccountsSnapshot,
  options: PresentationOptions & { readonly highlightSlots?: ReadonlySet<number> },
  columns: RowColumns = rowColumns(snapshot.accounts),
): NodeModel {
  const { t } = options;
  const isActive = snapshot.active.slot === account.slot;
  const level = accountLevel(account, options.thresholds);
  const description = accountDescription(account, options);
  const name = accountName(account, t);
  const slotText = padDigits(String(account.slot), columns.slotDigits);
  const usage = usageColumnsText(account, options, columns);
  const spoken = [isActive ? t('Active') : undefined, ...usage, description].filter((part): part is string => part !== undefined && part !== '').join(', ');
  return {
    id: `account:${account.slot}`,
    kind: 'account',
    slot: account.slot,
    label: [slotText, ...usage, name].join(' · '),
    ...(options.highlightSlots?.has(account.slot) === true ? { highlights: [[0, slotText.length]] as const } : {}),
    ...(description === '' ? {} : { description }),
    tooltip: accountTooltip(account, isActive, snapshot, options),
    icon: accountIcon(account, isActive, level),
    contextValue: accountContextValue(account, isActive),
    collapsible: isActive ? 'expanded' : 'collapsed',
    accessibilityLabel: t('Slot {0}, {1}. {2}', account.slot, name, spoken),
    children: accountChildren(account, snapshot, options, columns),
  };
}

export function visibleAccounts(snapshot: AccountsSnapshot, sortOrder: SortOrder, filter: string | undefined): Account[] {
  const filtered = filter ? snapshot.accounts.filter((account) => matchesFilter(account, filter)) : snapshot.accounts;
  return sortAccounts(filtered, sortOrder);
}

export function buildAccountNodes(snapshot: AccountsSnapshot, options: TreeBuildOptions): NodeModel[] {
  const accounts = visibleAccounts(snapshot, options.sortOrder, options.filter);
  const columns = rowColumns(accounts);
  return accounts.map((account) => buildAccountNode(account, snapshot, options, columns));
}

/** Drives `viewsWelcome` content via the `cswapManager.viewState` context key. */
export type ViewState =
  | 'loading'
  | 'notFound'
  | 'invalidSetting'
  | 'unsupportedExecutable'
  | 'error'
  | 'empty'
  | 'filteredEmpty'
  | 'ready';

export interface ViewPresentation {
  readonly state: ViewState;
  /** Short text next to the view title. */
  readonly description?: string;
  /** Message shown above the tree (stale data, errors, filter). */
  readonly message?: string;
}

export interface ViewPresentationOptions {
  readonly now: number;
  readonly t: Translate;
  readonly freshness: FreshnessAssessment;
  readonly filter?: string;
  readonly visibleCount: number;
  readonly describeError: (error: CliError) => string;
  /** When the next automatic refresh is due; the description then shows a countdown (`0:42`). */
  readonly nextRefreshAt?: number;
}

/**
 * The due time a countdown should show, or undefined: stale data keeps its warning instead (a
 * countdown would suggest all is well), and a refresh already running needs no countdown.
 */
export function countdownDue(nextRefreshAt: number | undefined, freshness: FreshnessAssessment, refreshing: boolean): number | undefined {
  return freshness.freshness === 'stale' || refreshing ? undefined : nextRefreshAt;
}

function errorViewState(error: CliError | undefined): ViewState {
  switch (error?.kind) {
    case undefined:
      return 'loading';
    case 'executable-not-found':
      return 'notFound';
    case 'invalid-executable-setting':
      return 'invalidSetting';
    case 'unsupported-executable':
      return 'unsupportedExecutable';
    default:
      return 'error';
  }
}

export function describeView(state: AccountsState, options: ViewPresentationOptions): ViewPresentation {
  const { t, now } = options;
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    const viewState = errorViewState(state.lastError);
    return {
      state: viewState,
      ...(state.lastError !== undefined ? { message: options.describeError(state.lastError) } : {}),
    };
  }

  const viewState: ViewState =
    snapshot.accounts.length === 0 ? 'empty' : options.visibleCount === 0 ? 'filteredEmpty' : 'ready';
  const updated = state.lastSuccessAt === undefined ? undefined : relativeAge(now - state.lastSuccessAt, t);
  const activeText = snapshot.active.slot === undefined ? t('Active: unknown') : t('Active: #{0}', snapshot.active.slot);
  const stale = options.freshness.freshness === 'stale';
  // While automatic refresh runs, the countdown to the next one says it all; otherwise the data's age.
  const due = countdownDue(options.nextRefreshAt, options.freshness, state.refreshing);
  const countdown = due === undefined ? undefined : countdownText(due - now);
  const description = [stale ? t('Stale') : undefined, activeText, countdown ?? (updated === undefined ? undefined : t('updated {0}', updated))]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  const messages: string[] = [];
  if (options.freshness.reason === 'refresh-failed' && state.lastError !== undefined) {
    messages.push(t('Last refresh failed: {0} Showing data from {1}.', options.describeError(state.lastError), updated ?? t('earlier')));
  } else if (options.freshness.reason === 'too-old') {
    messages.push(t('Data is out of date (updated {0}). Refresh to update it.', updated ?? t('earlier')));
  }
  if (snapshot.active.activeUnmanaged === true) {
    messages.push(t('Claude Code is logged in to an account cswap does not manage yet. Use + to add it.'));
  } else if (snapshot.active.consistency === 'conflict') {
    messages.push(t('cswap list and status disagree about the active account.'));
  } else if (state.lastWarning !== undefined) {
    messages.push(t('The active account could not be verified with cswap status.'));
  }
  if (snapshot.schemaVersion !== undefined && !TESTED_SCHEMA_VERSIONS.includes(snapshot.schemaVersion)) {
    messages.push(t('cswap output schema version {0} has not been tested; some fields may be missing.', snapshot.schemaVersion));
  }
  if (options.filter) {
    messages.push(t('Filter "{0}": {1} of {2} accounts.', options.filter, options.visibleCount, snapshot.accounts.length));
  }
  return { state: viewState, description, ...(messages.length > 0 ? { message: messages.join(' ') } : {}) };
}
