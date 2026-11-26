import type { Account, AccountsSnapshot } from '../model/types';
import type { Translate } from './accountTree';
import { FIVE_HOUR_WINDOW, windowInWords } from './format';

/**
 * The account-wide usage windows the accounts report, read from cswap's data instead of assumed
 * from a plan name: some plans have a 5-hour and a weekly limit, others (Ultra, for one) only
 * weekly ones, and a plan may change what it has.
 */
export interface LimitProfile {
  /** Window keys in first-seen order (slot order); empty while no account has reported usage. */
  readonly keys: readonly string[];
  /**
   * The plans that report a window, for windows that only some of the plans report (e.g.
   * `fiveHour` → `['Max']` next to Ultra accounts). Absent when every plan has it or no plan is known.
   */
  readonly plansByKey: ReadonlyMap<string, readonly string[]>;
  /**
   * Every account's windows are known: read for it, or seen on another account of the same plan.
   * False while an account of an unseen plan (e.g. a setup-token account without usage) is unread.
   */
  readonly complete: boolean;
}

/** Before any account has reported usage. */
export const NO_LIMITS_KNOWN: LimitProfile = { keys: [], plansByKey: new Map(), complete: false };

export function planName(account: Account): string | undefined {
  return account.plan?.displayName ?? account.plan?.label;
}

function windowsOf(account: Account, current: boolean): readonly { readonly key: string }[] {
  return (current ? account.usage : (account.usage ?? account.lastGoodUsage))?.windows ?? [];
}

/**
 * Window keys the accounts report, in first-seen (slot) order: `current` reads only the usage on
 * show now (the columns), otherwise the last known usage too (what the accounts have).
 */
export function reportedWindowKeys(accounts: readonly Account[], current: boolean): string[] {
  return [...new Set(accounts.flatMap((account) => windowsOf(account, current).map((window) => window.key)))];
}

export function limitProfile(accounts: readonly Account[]): LimitProfile {
  const reporting = new Map<string, Set<string>>();
  const plans = new Set<string>();
  const unread: Account[] = [];
  for (const account of accounts) {
    const windows = windowsOf(account, false);
    if (windows.length === 0) {
      unread.push(account);
      continue;
    }
    const plan = planName(account);
    if (plan !== undefined) {
      plans.add(plan);
    }
    for (const { key } of windows) {
      const names = reporting.get(key) ?? new Set<string>();
      reporting.set(key, plan === undefined ? names : names.add(plan));
    }
  }
  const keys = reportedWindowKeys(accounts, false);
  const plansByKey = new Map<string, readonly string[]>();
  for (const [key, names] of reporting) {
    if (names.size > 0 && names.size < plans.size) {
      plansByKey.set(key, [...names].sort((a, b) => a.localeCompare(b)));
    }
  }
  const complete =
    keys.length > 0 &&
    unread.every((account) => {
      const plan = planName(account);
      return plan !== undefined && plans.has(plan);
    });
  return { keys, plansByKey, complete };
}

/** The profile of a snapshot's accounts; nothing known without one. */
export function limitProfileOf(snapshot: Pick<AccountsSnapshot, 'accounts'> | undefined): LimitProfile {
  return snapshot === undefined ? NO_LIMITS_KNOWN : limitProfile(snapshot.accounts);
}

/** Whether the accounts have a 5-hour limit: `unknown` until every account's windows are known. */
export function fiveHourLimit(profile: LimitProfile): 'yes' | 'no' | 'unknown' {
  if (profile.keys.includes(FIVE_HOUR_WINDOW)) {
    return 'yes';
  }
  return profile.complete ? 'no' : 'unknown';
}

/** `a`, `a and b`, `a, b and c`, with each language's own list punctuation. */
export function joinWords(words: readonly string[], t: Translate): string {
  const last = words[words.length - 1];
  if (last === undefined || words.length === 1) {
    return last ?? '';
  }
  const head = words.slice(0, -1).reduce((list, word) => t('{0}, {1}', list, word));
  return t('{0} and {1}', head, last);
}

/**
 * The accounts' limits in words: `5-hour and weekly`, `weekly`, or `5-hour (Max) and weekly` when
 * only some plans have one; `overall` while nothing is known. `extra` names (e.g. a model) go last.
 */
export function limitNames(profile: LimitProfile, t: Translate, extra: readonly string[] = []): string {
  const names = profile.keys.map((key) => {
    const plans = profile.plansByKey.get(key);
    const name = windowInWords(key, t);
    return plans === undefined ? name : t('{0} ({1})', name, joinWords(plans, t));
  });
  return joinWords([...(names.length === 0 ? [t('overall')] : names), ...extra], t);
}

/**
 * Help for cswap's `autoswitch.threshold`, which is the 5-hour window's line and, while no weekly
 * line is set, every window's (claude_swap/lines.py `window_line`). Weekly-only accounts never
 * read about a 5-hour limit.
 */
export function switchThresholdHelp(profile: LimitProfile, weeklyThresholdSet: boolean, t: Translate): string {
  switch (fiveHourLimit(profile)) {
    case 'no':
      return weeklyThresholdSet ? t('The weekly threshold decides when these accounts switch.') : t('Switch when the {0} limit reaches this usage.', limitNames(profile, t));
    case 'unknown':
      return t('Switch when a usage limit reaches this usage; a weekly threshold, when set, takes over for the weekly limits.');
    case 'yes': {
      const plans = profile.plansByKey.get(FIVE_HOUR_WINDOW);
      return plans === undefined
        ? t('Switch when the 5-hour limit reaches this usage; while no weekly threshold is set, the other limits too.')
        : t('Switch when the 5-hour limit ({0}) reaches this usage; while no weekly threshold is set, the other limits too.', joinWords(plans, t));
    }
  }
}

/**
 * `autoswitch.weeklyThreshold` only differs from the switch threshold where a 5-hour window exists;
 * for accounts known to have none it is listed only once set, so it can be cleared.
 */
export function weeklyThresholdVisible(profile: LimitProfile, weeklyThresholdSet: boolean): boolean {
  return weeklyThresholdSet || fiveHourLimit(profile) !== 'no';
}

export function weeklyThresholdHelp(profile: LimitProfile, t: Translate): string {
  return fiveHourLimit(profile) === 'no'
    ? t('Used instead of the switch threshold for these accounts. Clear it to keep one threshold.')
    : t('Separate line for the 7-day and per-model windows; not set means the switch threshold.');
}
