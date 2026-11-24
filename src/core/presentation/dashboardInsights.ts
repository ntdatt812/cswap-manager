import type { CapacityOverview, Insight, TimelineItem } from '../../shared/dashboardProtocol';
import type { Account, AccountsSnapshot } from '../model/types';
import { accountLevel, accountName, hasUnavailableUsage, loginDue, type PresentationOptions } from './accountTree';
import { compactDuration, epochOf, formatPercent, usageLevel } from './format';

/** How far ahead the reset timeline looks. */
export const TIMELINE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
/** "Use it before it resets" only for quota worth spending, resetting soon. */
export const USE_BEFORE_RESET_MIN_LEFT = 25;
export const USE_BEFORE_RESET_WITHIN_MS = 3 * 24 * 60 * 60 * 1000;

export interface InsightOptions extends PresentationOptions {
  /** Locale-aware number with one decimal ("3.1", "3,1"). */
  readonly formatDecimal?: (value: number) => string;
}

/** Usage of the window that limits the account (its fullest rate window). */
export function limitingPct(account: Account): number | undefined {
  const values = (account.usage?.windows ?? []).map((window) => window.pct).filter((pct): pct is number => pct !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
}

/** Quota left on the limiting window, 0–100; undefined when unknown. */
export function remainingPct(account: Account): number | undefined {
  const used = limitingPct(account);
  return used === undefined ? undefined : Math.min(100, Math.max(0, 100 - used));
}

/** Soonest reset still ahead, across every window and scope. */
export function nextReset(account: Account, now: number): number | undefined {
  const resets = [...(account.usage?.windows ?? []), ...(account.usage?.scoped ?? [])]
    .map((metrics) => epochOf(metrics.resetsAt))
    .filter((epoch): epoch is number => epoch !== undefined && epoch > now);
  return resets.length === 0 ? undefined : Math.min(...resets);
}

/** An account worth switching to: in rotation, usage known, not at its limit. */
function usable(account: Account, options: PresentationOptions): boolean {
  return (
    account.disabled !== true &&
    !hasUnavailableUsage(account) &&
    remainingPct(account) !== undefined &&
    accountLevel(account, options.thresholds) !== 'critical'
  );
}

const label = (account: Account, options: PresentationOptions) => `#${account.slot} ${accountName(account, options.t)}`;

function reloginInsight(snapshot: AccountsSnapshot, options: PresentationOptions): Insight | undefined {
  const { t, now } = options;
  const due = snapshot.accounts
    .map((account) => ({ account, due: loginDue(account, now), required: account.usageStatus === 'relogin_required' }))
    .filter((entry) => entry.due !== undefined || entry.required)
    .sort((a, b) => (a.due?.expiresAt ?? 0) - (b.due?.expiresAt ?? 0));
  if (due.length === 0) {
    return undefined;
  }
  const lapsed = due.some((entry) => entry.required || entry.due?.expired === true);
  const slots = due.map((entry) => `#${entry.account.slot}`).join(', ');
  const soonest = due.find((entry) => entry.due !== undefined && !entry.due.expired)?.due;
  return {
    id: 'relogin',
    tone: lapsed ? 'error' : 'warning',
    title: lapsed ? t('Re-login needed') : t('Re-login due soon'),
    text:
      soonest === undefined
        ? t('{0}: log in again with /login in Claude Code, then run cswap add.', slots)
        : t('{0}: the stored login expires in {1}. Log in again with /login in Claude Code, then run cswap add.', slots, compactDuration(soonest.expiresAt - now)),
  };
}

/**
 * Suggestions from cswap's own numbers: switch before the active account runs out, spend quota that
 * is about to reset unused, renew logins. Never a forecast: only usage, limits and reset times.
 */
export function buildInsights(snapshot: AccountsSnapshot, options: PresentationOptions): Insight[] {
  const { t, now } = options;
  const insights: Insight[] = [];
  const active = snapshot.accounts.find((account) => account.slot === snapshot.active.slot);
  const others = snapshot.accounts.filter((account) => account !== active && usable(account, options));
  const byHeadroom = [...others].sort((a, b) => (remainingPct(b) ?? 0) - (remainingPct(a) ?? 0) || a.slot - b.slot);

  let suggested: number | undefined;
  if (active !== undefined) {
    const level = accountLevel(active, options.thresholds);
    const activeLeft = remainingPct(active);
    const best = byHeadroom[0];
    if (level === 'critical' || level === 'warning' || hasUnavailableUsage(active)) {
      if (best !== undefined) {
        suggested = best.slot;
        // Say when the active account resets: if that is soon, waiting can beat switching.
        const activeReset = nextReset(active, now);
        const activeText = activeLeft === undefined ? t('unknown') : formatPercent(activeLeft);
        insights.push({
          id: 'switch-now',
          tone: level === 'critical' ? 'error' : 'warning',
          title: level === 'critical' ? t('The active account is almost used up') : t('The active account is running low'),
          text:
            activeReset === undefined
              ? t('{0} has {1} left; {2} has {3} left.', label(active, options), activeText, label(best, options), formatPercent(remainingPct(best) ?? 0))
              : t('{0} has {1} left and resets in {2}; {3} has {4} left.', label(active, options), activeText, compactDuration(activeReset - now), label(best, options), formatPercent(remainingPct(best) ?? 0)),
          switchSlot: best.slot,
          actionLabel: t('Switch to #{0}', best.slot),
        });
      } else {
        const resets = snapshot.accounts
          .map((account) => ({ account, at: nextReset(account, now) }))
          .filter((entry): entry is { account: Account; at: number } => entry.at !== undefined)
          .sort((a, b) => a.at - b.at);
        const first = resets[0];
        insights.push({
          id: 'all-limited',
          tone: 'warning',
          title: t('No other account has quota to spare'),
          text: first === undefined ? t('No reset time is known yet.') : t('The first reset is {0} in {1}.', label(first.account, options), compactDuration(first.at - now)),
        });
      }
    }

    // Quota that resets soon is lost if nobody uses it: suggest spending it first.
    const activeReset = nextReset(active, now);
    const perishable = others
      .map((account) => ({ account, left: remainingPct(account) ?? 0, at: nextReset(account, now) }))
      .filter(
        (entry): entry is { account: Account; left: number; at: number } =>
          entry.at !== undefined &&
          entry.account.slot !== suggested &&
          entry.left >= USE_BEFORE_RESET_MIN_LEFT &&
          entry.at - now <= USE_BEFORE_RESET_WITHIN_MS &&
          (activeReset === undefined || entry.at < activeReset),
      )
      .sort((a, b) => a.at - b.at)[0];
    if (perishable !== undefined) {
      insights.push({
        id: 'use-before-reset',
        tone: 'active',
        title: t('Use quota before it resets'),
        text: t('{0} still has {1} left and resets in {2}; what is not used by then is lost.', label(perishable.account, options), formatPercent(perishable.left), compactDuration(perishable.at - now)),
        switchSlot: perishable.account.slot,
        actionLabel: t('Switch to #{0}', perishable.account.slot),
      });
    }

    if (insights.length === 0 && activeLeft !== undefined) {
      insights.push({
        id: 'all-good',
        tone: 'ok',
        title: t('All good'),
        text: t('{0} has {1} left. Nothing to do right now.', label(active, options), formatPercent(activeLeft)),
      });
    }
  }

  const relogin = reloginInsight(snapshot, options);
  if (relogin !== undefined) {
    insights.push(relogin);
  }
  return insights;
}

/** Quota left across accounts in rotation with known usage, counted in full accounts. */
export function buildCapacity(snapshot: AccountsSnapshot, options: InsightOptions): CapacityOverview | undefined {
  const { t } = options;
  const counted = snapshot.accounts.filter((account) => account.disabled !== true && !hasUnavailableUsage(account) && remainingPct(account) !== undefined);
  if (counted.length === 0) {
    return undefined;
  }
  const left = counted.reduce((sum, account) => sum + (remainingPct(account) ?? 0), 0);
  const share = left / counted.length;
  const decimal = options.formatDecimal ?? ((value: number) => value.toFixed(1));
  const excluded = snapshot.accounts.length - counted.length;
  return {
    value: `${decimal(left / 100)} / ${counted.length}`,
    caption: t('full accounts of quota left'),
    ...(excluded > 0 ? { detail: t('{0} not counted (disabled or usage unknown)', excluded) } : {}),
    pct: share,
    level: usageLevel(100 - share, options.thresholds),
  };
}

/** Next reset per account within the horizon, soonest first. */
export function buildTimeline(snapshot: AccountsSnapshot, options: PresentationOptions): TimelineItem[] {
  const { t, now } = options;
  return snapshot.accounts
    .map((account) => ({ account, at: nextReset(account, now) }))
    .filter((entry): entry is { account: Account; at: number } => entry.at !== undefined && entry.at - now <= TIMELINE_HORIZON_MS)
    .sort((a, b) => a.at - b.at || a.account.slot - b.account.slot)
    .map(({ account, at }) => {
      const left = remainingPct(account);
      return {
        slot: account.slot,
        name: accountName(account, t),
        active: account.slot === snapshot.active.slot,
        whenText: t('in {0}', compactDuration(at - now)),
        position: Math.min(100, Math.max(0, ((at - now) / TIMELINE_HORIZON_MS) * 100)),
        remainingText: left === undefined ? t('usage unknown') : t('{0} left', formatPercent(left)),
        level: accountLevel(account, options.thresholds),
      };
    });
}
