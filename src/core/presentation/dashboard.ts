import type {
  AccountDetail,
  Badge,
  DashboardModel,
  DashboardRow,
  DashboardStrings,
  DetailSection,
  Fact,
  Meter,
  SummaryCard,
  Tone,
} from '../../shared/dashboardProtocol';
import type { CliError } from '../cli/cliErrors';
import type { Account, AccountUsage, AccountsSnapshot, UsageMetrics } from '../model/types';
import type { AccountsState, FreshnessAssessment } from '../service/refreshService';
import {
  accountLevel,
  accountName,
  describeView,
  hasUnavailableUsage,
  relativeAge,
  type PresentationOptions,
  type Translate,
} from './accountTree';
import { compactDuration, epochOf, formatPercent, maxUsagePct, usageAgeMs, usageLevel, windowLabel, worstLevel, type UsageLevel } from './format';
import { accountActions } from './accountActions';
import { usageStatusText, usageStatusTone } from './usageStatus';

export interface DashboardOptions extends PresentationOptions {
  readonly freshness: FreshnessAssessment;
  readonly switching: boolean;
  readonly describeError: (error: CliError) => string;
}

const TONE_RANK: Record<Tone, number> = { ok: 0, neutral: 1, active: 2, warning: 3, error: 4 };

function worstTone(tones: readonly Tone[], fallback: Tone): Tone {
  return tones.reduce<Tone>((worst, tone) => (TONE_RANK[tone] > TONE_RANK[worst] ? tone : worst), fallback);
}

function levelTone(level: UsageLevel): Tone {
  return level === 'critical' ? 'error' : level === 'warning' ? 'warning' : level === 'normal' ? 'ok' : 'neutral';
}

export function dashboardStrings(t: Translate): DashboardStrings {
  return {
    title: t('Cswap Dashboard'),
    refresh: t('Refresh'),
    switchBest: t('Switch to most headroom'),
    switchNext: t('Switch to next available'),
    settings: t('Settings'),
    diagnostics: t('Diagnostics'),
    searchLabel: t('Search accounts'),
    searchPlaceholder: t('Slot, email, alias, plan or status'),
    accountsHeading: t('Accounts'),
    detailHeading: t('Account details'),
    columnSlot: t('Slot'),
    columnName: t('Account'),
    columnPlan: t('Plan'),
    columnUsage: t('Usage'),
    columnReset: t('Next reset'),
    columnStatus: t('Status'),
    sortBy: t('Sort by {0}', '{0}'),
    noSelection: t('Select an account to see its details.'),
    noMatches: t('No accounts match the search.'),
    switchToAccount: t('Switch to this account'),
    busy: t('Working…'),
    matchCount: t('{0} of {1} accounts', '{0}', '{1}'),
  };
}

function dateWithAge(epoch: number, options: PresentationOptions): string {
  const delta = options.now - epoch;
  const relative = delta >= 0 ? relativeAge(delta, options.t) : options.t('in {0}', compactDuration(-delta));
  return `${options.formatDateTime(epoch)} (${relative})`;
}

function resetCaption(resetsAt: string | undefined, options: PresentationOptions): string | undefined {
  const epoch = epochOf(resetsAt);
  if (epoch === undefined) {
    return undefined;
  }
  return epoch <= options.now
    ? options.t('reset time passed — refresh to update')
    : options.t('resets in {0}', compactDuration(epoch - options.now));
}

function moneyText(metrics: UsageMetrics): string | undefined {
  if (metrics.used === undefined && metrics.limit === undefined) {
    return undefined;
  }
  const amount = `${metrics.used ?? '?'} / ${metrics.limit ?? '?'}`;
  return metrics.currency ? `${amount} ${metrics.currency}` : amount;
}

function meter(id: string, label: string, metrics: UsageMetrics, options: PresentationOptions): Meter {
  const { t } = options;
  const facts: Fact[] = [];
  const money = moneyText(metrics);
  if (money !== undefined) {
    facts.push({ label: t('Spent / limit'), value: money });
  }
  if (metrics.expectedPct !== undefined) {
    facts.push({ label: t('Expected by now'), value: formatPercent(metrics.expectedPct) });
  }
  if (metrics.aheadOfPace !== undefined) {
    facts.push({ label: t('Ahead of pace'), value: metrics.aheadOfPace ? t('yes') : t('no') });
  }
  const projected = epochOf(metrics.projectedExhaustionAt);
  if (projected !== undefined) {
    facts.push({ label: t('Projected exhaustion'), value: options.formatDateTime(projected) });
  }
  if (metrics.willLastToReset !== undefined) {
    facts.push({ label: t('Lasts until reset'), value: metrics.willLastToReset ? t('yes') : t('no') });
  }
  const reset = epochOf(metrics.resetsAt);
  if (reset !== undefined) {
    facts.push({ label: t('Resets'), value: options.formatDateTime(reset) });
  }
  const caption = resetCaption(metrics.resetsAt, options);
  return {
    id,
    label,
    ...(metrics.pct === undefined ? {} : { pct: metrics.pct }),
    pctText: metrics.pct === undefined ? t('unknown') : formatPercent(metrics.pct),
    level: usageLevel(metrics.pct, options.thresholds),
    ...(caption === undefined ? {} : { caption }),
    facts,
  };
}

function usageMeters(prefix: string, usage: AccountUsage, options: PresentationOptions): Meter[] {
  return [
    ...usage.windows.map((window) => meter(`${prefix}window:${window.key}`, windowLabel(window.key), window, options)),
    ...usage.scoped.map((scope, index) => meter(`${prefix}scope:${index}`, scope.name, scope, options)),
  ];
}

function statusOf(account: Account, active: boolean, t: Translate): { text: string; tone: Tone } {
  const parts: string[] = [];
  const tones: Tone[] = [];
  if (active) {
    parts.push(t('Active'));
    tones.push('active');
  }
  if (account.disabled === true) {
    parts.push(t('Disabled'));
    tones.push('neutral');
  }
  if (account.usageStatus !== undefined && hasUnavailableUsage(account)) {
    parts.push(usageStatusText(account.usageStatus, t));
    tones.push(usageStatusTone(account.usageStatus));
  } else if (account.usage === undefined) {
    parts.push(t('usage unknown'));
    tones.push('warning');
  }
  if (account.plan?.expired === true) {
    parts.push(t('plan expired'));
    tones.push('warning');
  }
  return parts.length === 0 ? { text: t('OK'), tone: 'ok' } : { text: parts.join(' · '), tone: worstTone(tones, 'ok') };
}

function usageSection(account: Account, options: PresentationOptions): DetailSection[] {
  const { t } = options;
  const sections: DetailSection[] = [];
  const notes: string[] = [];
  if (account.usageStatus !== undefined && hasUnavailableUsage(account)) {
    notes.push(t('Usage status: {0}.', usageStatusText(account.usageStatus, t)));
  }
  if (account.usageError !== undefined) {
    notes.push(t('Last fetch error: {0}.', account.usageError));
  }
  const retry = epochOf(account.usageRetryAt);
  if (retry !== undefined) {
    notes.push(t('Next fetch attempt: {0}.', options.formatDateTime(retry)));
  }
  const rejected = account.usage?.rejected;
  if (rejected !== undefined) {
    const until = epochOf(rejected.resetsAt);
    notes.push(until === undefined ? t('The server refused this account for quota.') : t('The server refused this account for quota until {0}.', options.formatDateTime(until)));
  }
  if (account.usage === undefined && notes.length === 0) {
    notes.push(t('cswap did not report usage for this account.'));
  }
  sections.push({
    title: t('Usage'),
    ...(notes.length > 0 ? { note: notes.join(' '), noteTone: account.usage === undefined ? 'warning' : 'neutral' } : {}),
    meters: account.usage === undefined ? [] : usageMeters('', account.usage, options),
    facts: [],
  });

  if (account.usage === undefined && account.lastGoodUsage !== undefined) {
    const fetched = epochOf(account.lastGoodFetchedAt);
    const age =
      account.lastGoodAgeSeconds !== undefined
        ? relativeAge(account.lastGoodAgeSeconds * 1000, t)
        : fetched !== undefined
          ? relativeAge(options.now - fetched, t)
          : t('an unknown time ago');
    sections.push({
      title: t('Last known usage'),
      note: t('Measured {0}; this is not current data.', age),
      noteTone: 'warning',
      meters: usageMeters('lastGood:', account.lastGoodUsage, options),
      facts: [],
    });
  }
  return sections;
}

function planSection(account: Account, options: PresentationOptions): DetailSection | undefined {
  const plan = account.plan;
  if (plan === undefined) {
    return undefined;
  }
  const { t } = options;
  const facts: Fact[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined) {
      facts.push({ label, value });
    }
  };
  add(t('Plan'), plan.displayName ?? plan.label);
  add(t('Tier'), plan.tier);
  add(t('Organization type'), plan.organizationType);
  add(t('Billing'), plan.billingType);
  add(t('Subscription'), plan.subscriptionStatus);
  add(t('Expired'), plan.expired === undefined ? undefined : plan.expired ? t('yes') : t('no'));
  const fetched = epochOf(plan.fetchedAt);
  add(t('Plan info fetched'), fetched === undefined ? undefined : dateWithAge(fetched, options));
  return { title: t('Plan'), meters: [], facts };
}

function accountSection(account: Account, options: PresentationOptions): DetailSection {
  const { t } = options;
  const facts: Fact[] = [{ label: t('Slot'), value: String(account.slot) }];
  if (account.email !== undefined) {
    facts.push({ label: t('Email'), value: account.email });
  }
  if (account.alias !== undefined) {
    facts.push({ label: t('Alias'), value: account.alias });
  }
  if (account.organizationName !== undefined) {
    facts.push({ label: t('Organization'), value: account.organizationName });
  }
  if (account.disabled !== undefined) {
    facts.push({ label: t('Auto-rotation'), value: account.disabled ? t('disabled') : t('included') });
  }
  if (account.threshold !== undefined) {
    facts.push({ label: t('Switch threshold'), value: t('{0} (account override)', formatPercent(account.threshold)) });
  }
  return { title: t('Account'), meters: [], facts };
}

function freshnessSection(account: Account, snapshot: AccountsSnapshot, options: PresentationOptions): DetailSection {
  const { t } = options;
  const facts: Fact[] = [];
  const fetched = epochOf(account.usageFetchedAt);
  const age = usageAgeMs(account, snapshot.capturedAt, options.now);
  if (fetched !== undefined) {
    facts.push({ label: t('Usage fetched'), value: `${options.formatDateTime(fetched)} (${relativeAge(age ?? options.now - fetched, t)})` });
  } else if (age !== undefined) {
    facts.push({ label: t('Usage fetched'), value: relativeAge(age, t) });
  }
  const login = epochOf(account.loginExpiresAt);
  if (login !== undefined) {
    facts.push({
      label: t('Login expires'),
      value: login <= options.now ? t('expired ({0})', options.formatDateTime(login)) : dateWithAge(login, options),
    });
  }
  facts.push({ label: t('Read from cswap'), value: relativeAge(options.now - snapshot.capturedAt, t) });
  return { title: t('Freshness'), meters: [], facts };
}

export function buildAccountDetail(account: Account, snapshot: AccountsSnapshot, options: DashboardOptions): AccountDetail {
  const { t } = options;
  const active = snapshot.active.slot === account.slot;
  const badges: Badge[] = [];
  if (active) {
    badges.push({ text: t('Active'), tone: 'active' });
  }
  if (account.disabled === true) {
    badges.push({ text: t('Disabled'), tone: 'neutral' });
  }
  const planLabel = account.plan?.displayName ?? account.plan?.label;
  if (planLabel !== undefined) {
    badges.push({ text: planLabel, tone: account.plan?.expired === true ? 'warning' : 'neutral' });
  }
  if (account.usageStatus !== undefined && hasUnavailableUsage(account)) {
    badges.push({ text: usageStatusText(account.usageStatus, t), tone: usageStatusTone(account.usageStatus) });
  }
  const subtitle = [t('Slot {0}', account.slot), account.alias !== undefined ? account.email : undefined, account.organizationName]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
  const plan = planSection(account, options);
  return {
    slot: account.slot,
    title: accountName(account, t),
    subtitle,
    badges,
    sections: [
      ...usageSection(account, options),
      ...(plan === undefined ? [] : [plan]),
      accountSection(account, options),
      freshnessSection(account, snapshot, options),
    ],
    canSwitch: !active && !options.switching,
    actions: accountActions(account, t),
  };
}

function buildRow(account: Account, snapshot: AccountsSnapshot, options: DashboardOptions): DashboardRow {
  const { t, now } = options;
  const active = snapshot.active.slot === account.slot;
  const status = statusOf(account, active, t);
  const metrics: UsageMetrics[] = [...(account.usage?.windows ?? []), ...(account.usage?.scoped ?? [])];
  const futureResets = metrics.map((entry) => epochOf(entry.resetsAt)).filter((epoch): epoch is number => epoch !== undefined && epoch > now);
  const resetEpoch = futureResets.length === 0 ? undefined : Math.min(...futureResets);
  const maxPct = maxUsagePct(account);
  const plan = account.plan?.displayName ?? account.plan?.label;
  const name = accountName(account, t);
  const secondary = account.alias !== undefined ? account.email : undefined;
  const searchText = [String(account.slot), `#${account.slot}`, name, account.email, account.alias, account.organizationName, plan, account.plan?.tier, status.text]
    .filter((part): part is string => part !== undefined)
    .join(' ')
    .toLowerCase();
  return {
    slot: account.slot,
    name,
    ...(secondary === undefined ? {} : { secondary }),
    active,
    ...(plan === undefined ? {} : { plan }),
    usage: (account.usage?.windows ?? []).map((window) => ({
      label: windowLabel(window.key),
      ...(window.pct === undefined ? {} : { pct: window.pct }),
      pctText: window.pct === undefined ? t('unknown') : formatPercent(window.pct),
      level: usageLevel(window.pct, options.thresholds),
    })),
    ...(maxPct === undefined ? {} : { maxPct }),
    ...(resetEpoch === undefined ? {} : { resetEpoch, resetText: t('in {0}', compactDuration(resetEpoch - now)) }),
    statusText: status.text,
    statusTone: status.tone,
    searchText,
    detail: buildAccountDetail(account, snapshot, options),
  };
}

function summaryCards(state: AccountsState, options: DashboardOptions): SummaryCard[] {
  const { t } = options;
  const snapshot = state.snapshot;
  const dataCard = ((): SummaryCard => {
    if (snapshot === undefined) {
      return state.lastError
        ? { label: t('Data'), value: t('Error'), detail: options.describeError(state.lastError), tone: 'error' }
        : { label: t('Data'), value: t('Loading…'), tone: 'neutral' };
    }
    const updated = state.lastSuccessAt === undefined ? undefined : t('updated {0}', relativeAge(options.now - state.lastSuccessAt, t));
    if (options.freshness.freshness === 'stale') {
      const detail = state.lastError ? `${t('Last refresh failed.')} ${updated ?? ''}`.trim() : updated;
      return { label: t('Data'), value: t('Stale'), ...(detail ? { detail } : {}), tone: 'warning' };
    }
    return { label: t('Data'), value: t('Fresh'), ...(updated ? { detail: updated } : {}), tone: 'ok' };
  })();
  if (snapshot === undefined) {
    return [dataCard];
  }

  const disabled = snapshot.accounts.filter((account) => account.disabled === true).length;
  const levels = snapshot.accounts.map((account) => accountLevel(account, options.thresholds));
  const count = (level: UsageLevel): number => levels.filter((candidate) => candidate === level).length;
  const unavailable = snapshot.accounts.filter((account) => hasUnavailableUsage(account) || account.usage === undefined).length;
  const usageParts = [
    count('critical') > 0 ? t('{0} critical', count('critical')) : undefined,
    count('warning') > 0 ? t('{0} warning', count('warning')) : undefined,
    count('normal') > 0 ? t('{0} OK', count('normal')) : undefined,
  ].filter((part): part is string => part !== undefined);
  const worst = worstLevel(levels);

  const active = snapshot.accounts.find((account) => account.slot === snapshot.active.slot);
  const activeCard: SummaryCard =
    active === undefined
      ? {
          label: t('Active account'),
          value: t('Unknown'),
          detail: snapshot.active.activeUnmanaged ? t('The current Claude login is not managed by cswap.') : t('list and status did not agree.'),
          tone: 'warning',
        }
      : { label: t('Active account'), value: `#${active.slot}`, detail: accountName(active, t), tone: 'active' };

  return [
    {
      label: t('Accounts'),
      value: String(snapshot.accounts.length),
      ...(disabled > 0 ? { detail: t('{0} disabled', disabled) } : {}),
      tone: 'neutral',
    },
    activeCard,
    {
      label: t('Usage'),
      value: usageParts.length > 0 ? usageParts.join(' · ') : t('No data'),
      ...(unavailable > 0 ? { detail: t('{0} without current usage', unavailable) } : {}),
      tone: usageParts.length > 0 ? levelTone(worst) : 'neutral',
    },
    dataCard,
  ];
}

export function buildDashboardModel(state: AccountsState, options: DashboardOptions): DashboardModel {
  const { t } = options;
  const snapshot = state.snapshot;
  const busy = state.refreshing || options.switching;
  const strings = dashboardStrings(t);
  const summary = summaryCards(state, options);

  if (snapshot === undefined) {
    return state.lastError
      ? { state: 'error', message: options.describeError(state.lastError), messageTone: 'error', summary, rows: [], busy, canSwitch: false, strings }
      : { state: 'loading', summary, rows: [], busy, canSwitch: false, strings };
  }
  const rows = [...snapshot.accounts].sort((a, b) => a.slot - b.slot).map((account) => buildRow(account, snapshot, options));
  if (rows.length === 0) {
    return {
      state: 'empty',
      message: t('cswap is not managing any accounts yet. Add one with `cswap add` in a terminal, then refresh.'),
      messageTone: 'neutral',
      summary,
      rows,
      busy,
      canSwitch: false,
      strings,
    };
  }
  const view = describeView(state, { now: options.now, t, freshness: options.freshness, visibleCount: rows.length, describeError: options.describeError });
  const stale = options.freshness.freshness === 'stale';
  return {
    state: 'ready',
    ...(view.message === undefined ? {} : { message: view.message, messageTone: stale ? 'warning' : 'neutral' }),
    summary,
    rows,
    busy,
    canSwitch: !options.switching,
    strings,
  };
}
