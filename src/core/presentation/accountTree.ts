import type { CliError } from '../cli/cliErrors';
import { accountContextValue } from './accountActions';
import { TESTED_SCHEMA_VERSIONS } from '../model/parsers';
import type { Account, AccountsSnapshot, UsageMetrics } from '../model/types';
import type { AccountsState, FreshnessAssessment } from '../service/refreshService';
import {
  compactDuration,
  epochOf,
  formatPercent,
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
} from './format';

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
  /** Set on account nodes; the identity used for switching. */
  readonly slot?: number;
  readonly label: string;
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
}

export interface TreeBuildOptions extends PresentationOptions {
  readonly sortOrder: SortOrder;
  readonly filter?: string;
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
  return account.alias ?? account.email ?? t('Account {0}', account.slot);
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

export function metricsDescription(metrics: UsageMetrics, options: PresentationOptions): string {
  const parts = [metrics.pct === undefined ? options.t('usage unknown') : `${usageBar(metrics.pct)} ${formatPercent(metrics.pct)}`];
  const reset = resetText(metrics.resetsAt, options);
  if (reset !== undefined) {
    parts.push(reset);
  }
  return parts.join(' · ');
}

function metricsRows(metrics: UsageMetrics, options: PresentationOptions): TooltipRow[] {
  const { t } = options;
  const rows: TooltipRow[] = [{ label: t('Used'), value: percentText(metrics.pct, t) }];
  if (metrics.expectedPct !== undefined) {
    rows.push({ label: t('Expected by now'), value: formatPercent(metrics.expectedPct) });
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

function metricsNode(
  id: string,
  kind: 'window' | 'scope',
  label: string,
  metrics: UsageMetrics,
  options: PresentationOptions,
): NodeModel {
  const level = usageLevel(metrics.pct, options.thresholds);
  const color = LEVEL_COLOR[level];
  const description = metricsDescription(metrics, options);
  return {
    id,
    kind,
    label,
    description,
    icon: { id: kind === 'window' ? 'dashboard' : 'layers', ...(color ? { color } : {}) },
    tooltip: { title: label, rows: metricsRows(metrics, options) },
    contextValue: `cswap.${kind}`,
    collapsible: 'none',
    accessibilityLabel: `${label}: ${percentText(metrics.pct, options.t)}`,
    children: [],
  };
}

function detailNode(id: string, label: string, description: string, icon: IconSpec): NodeModel {
  return { id, kind: 'detail', label, description, icon, contextValue: 'cswap.detail', collapsible: 'none', children: [] };
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

function loginText(account: Account, options: PresentationOptions): string | undefined {
  const expires = epochOf(account.loginExpiresAt);
  if (expires === undefined) {
    return undefined;
  }
  const when = options.formatDateTime(expires);
  return expires <= options.now
    ? options.t('expired ({0})', when)
    : options.t('in {0} ({1})', compactDuration(expires - options.now), when);
}

function accountChildren(account: Account, snapshot: AccountsSnapshot, options: PresentationOptions): NodeModel[] {
  const { t, now } = options;
  const base = `account:${account.slot}`;
  const children: NodeModel[] = [];

  for (const window of account.usage?.windows ?? []) {
    children.push(metricsNode(`${base}:window:${window.key}`, 'window', windowLabel(window.key), window, options));
  }
  (account.usage?.scoped ?? []).forEach((scope, index) => {
    children.push(metricsNode(`${base}:scope:${index}:${scope.name}`, 'scope', scope.name, scope, options));
  });

  if (hasUnavailableUsage(account)) {
    children.push(detailNode(`${base}:usageStatus`, t('Usage status'), account.usageStatus ?? '', { id: 'warning', color: 'charts.yellow' }));
  } else if (account.usage === undefined) {
    children.push(detailNode(`${base}:usageStatus`, t('Usage'), t('not reported by cswap'), { id: 'question' }));
  }

  const plan = planText(account, t);
  if (plan !== undefined) {
    const expired = account.plan?.expired === true;
    children.push(detailNode(`${base}:plan`, t('Plan'), plan, expired ? { id: 'warning', color: 'charts.yellow' } : { id: 'credit-card' }));
  }
  const login = loginText(account, options);
  if (login !== undefined) {
    const expired = (epochOf(account.loginExpiresAt) ?? Infinity) <= now;
    children.push(detailNode(`${base}:login`, t('Login expires'), login, expired ? { id: 'warning', color: 'charts.yellow' } : { id: 'key' }));
  }
  const age = usageAgeMs(account, snapshot.capturedAt, now);
  if (age !== undefined) {
    children.push(detailNode(`${base}:fetched`, t('Usage updated'), relativeAge(age, t), { id: 'history' }));
  }
  if (account.isOrganization === true && account.organizationName !== undefined) {
    children.push(detailNode(`${base}:org`, t('Organization'), account.organizationName, { id: 'organization' }));
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

function accountDescription(account: Account, isActive: boolean, options: PresentationOptions): string {
  const { t } = options;
  const parts: string[] = [];
  if (isActive) {
    parts.push(t('Active'));
  }
  if (account.disabled === true) {
    parts.push(t('disabled'));
  }
  const planLabel = account.plan?.displayName ?? account.plan?.label;
  if (planLabel !== undefined) {
    parts.push(planLabel);
  }
  const windows = account.usage?.windows ?? [];
  for (const window of windows) {
    parts.push(`${windowLabel(window.key)} ${window.pct === undefined ? '?' : formatPercent(window.pct)}`);
  }
  const firstReset = windows.map((window) => epochOf(window.resetsAt)).find((epoch) => epoch !== undefined);
  if (firstReset !== undefined && firstReset > options.now) {
    parts.push(`↻ ${compactDuration(firstReset - options.now)}`);
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
  if (account.alias !== undefined) {
    rows.push({ label: t('Alias'), value: account.alias });
  }
  if (account.disabled === true) {
    rows.push({ label: t('Rotation'), value: t('disabled (held out of auto-rotation)') });
  }
  if (account.email !== undefined) {
    rows.push({ label: t('Email'), value: account.email });
  }
  if (account.isOrganization === true && account.organizationName !== undefined) {
    rows.push({ label: t('Organization'), value: account.organizationName });
  }
  const plan = planText(account, t);
  if (plan !== undefined) {
    rows.push({ label: t('Plan'), value: account.plan?.tier ? `${plan} (${account.plan.tier})` : plan });
  }
  if (account.usageStatus !== undefined) {
    rows.push({ label: t('Usage status'), value: account.usageStatus });
  }
  for (const window of account.usage?.windows ?? []) {
    rows.push({ label: windowLabel(window.key), value: metricsDescription(window, options) });
  }
  for (const scope of account.usage?.scoped ?? []) {
    rows.push({ label: scope.name, value: metricsDescription(scope, options) });
  }
  const login = loginText(account, options);
  if (login !== undefined) {
    rows.push({ label: t('Login expires'), value: login });
  }
  const age = usageAgeMs(account, snapshot.capturedAt, options.now);
  if (age !== undefined) {
    rows.push({ label: t('Usage updated'), value: relativeAge(age, t) });
  }
  const notes: string[] = [];
  if (isActive) {
    notes.push(snapshot.active.consistency === 'consistent' ? t('Active account.') : t('Active account (sources disagreed; taken from cswap status).'));
  }
  return { title: accountName(account, t), rows, ...(notes.length > 0 ? { notes } : {}) };
}

export function buildAccountNode(account: Account, snapshot: AccountsSnapshot, options: PresentationOptions): NodeModel {
  const isActive = snapshot.active.slot === account.slot;
  const level = accountLevel(account, options.thresholds);
  const description = accountDescription(account, isActive, options);
  const name = accountName(account, options.t);
  return {
    id: `account:${account.slot}`,
    kind: 'account',
    slot: account.slot,
    label: `${account.slot} · ${name}`,
    description,
    tooltip: accountTooltip(account, isActive, snapshot, options),
    icon: accountIcon(account, isActive, level),
    contextValue: accountContextValue(account, isActive),
    collapsible: isActive ? 'expanded' : 'collapsed',
    accessibilityLabel: options.t('Slot {0}, {1}. {2}', account.slot, name, description),
    children: accountChildren(account, snapshot, options),
  };
}

export function visibleAccounts(snapshot: AccountsSnapshot, sortOrder: SortOrder, filter: string | undefined): Account[] {
  const filtered = filter ? snapshot.accounts.filter((account) => matchesFilter(account, filter)) : snapshot.accounts;
  return sortAccounts(filtered, sortOrder);
}

export function buildAccountNodes(snapshot: AccountsSnapshot, options: TreeBuildOptions): NodeModel[] {
  return visibleAccounts(snapshot, options.sortOrder, options.filter).map((account) => buildAccountNode(account, snapshot, options));
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
  const description = [stale ? t('Stale') : undefined, activeText, updated === undefined ? undefined : t('updated {0}', updated)]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  const messages: string[] = [];
  if (options.freshness.reason === 'refresh-failed' && state.lastError !== undefined) {
    messages.push(t('Last refresh failed: {0} Showing data from {1}.', options.describeError(state.lastError), updated ?? t('earlier')));
  } else if (options.freshness.reason === 'too-old') {
    messages.push(t('Data is out of date (updated {0}). Refresh to update it.', updated ?? t('earlier')));
  }
  if (snapshot.active.activeUnmanaged === true) {
    messages.push(t('The current Claude login is not managed by cswap.'));
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
