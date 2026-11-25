import type { Account } from '../model/types';
import type { Translate } from './accountTree';
import { windowLabel } from './format';

/** cswap's account-wide window keys in `list --json`. */
export const FIVE_HOUR_WINDOW = 'fiveHour';
export const WEEKLY_WINDOW = 'sevenDay';

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
}

/** Before any account has reported usage. */
export const NO_LIMITS_KNOWN: LimitProfile = { keys: [], plansByKey: new Map() };

export function planName(account: Account): string | undefined {
  return account.plan?.displayName ?? account.plan?.label;
}

export function limitProfile(accounts: readonly Account[]): LimitProfile {
  const keys: string[] = [];
  const reporting = new Map<string, Set<string>>();
  const plans = new Set<string>();
  for (const account of accounts) {
    const windows = (account.usage ?? account.lastGoodUsage)?.windows ?? [];
    if (windows.length === 0) {
      continue;
    }
    const plan = planName(account);
    if (plan !== undefined) {
      plans.add(plan);
    }
    for (const { key } of windows) {
      if (!keys.includes(key)) {
        keys.push(key);
      }
      if (plan !== undefined) {
        reporting.set(key, (reporting.get(key) ?? new Set<string>()).add(plan));
      }
    }
  }
  const plansByKey = new Map<string, readonly string[]>();
  for (const [key, names] of reporting) {
    if (names.size < plans.size) {
      plansByKey.set(key, [...names].sort((a, b) => a.localeCompare(b)));
    }
  }
  return { keys, plansByKey };
}

/** Whether any account may have this window: true while nothing is known, so nothing is hidden early. */
export function mayReport(profile: LimitProfile, key: string): boolean {
  return profile.keys.length === 0 || profile.keys.includes(key);
}

function windowName(key: string, t: Translate): string {
  switch (key) {
    case FIVE_HOUR_WINDOW:
      return t('5-hour');
    case WEEKLY_WINDOW:
      return t('weekly');
    default:
      return windowLabel(key);
  }
}

/** `a`, `a and b`, `a, b and c`. */
export function joinWords(words: readonly string[], t: Translate): string {
  const last = words[words.length - 1];
  return last === undefined ? '' : words.length === 1 ? last : t('{0} and {1}', words.slice(0, -1).join(', '), last);
}

/**
 * The accounts' limits in words: `5-hour and weekly`, `weekly`, or `5-hour (Max) and weekly` when
 * only some plans have one; `overall` while nothing is known. `extra` names (e.g. a model) go last.
 */
export function limitNames(profile: LimitProfile, t: Translate, extra: readonly string[] = []): string {
  const names = profile.keys.map((key) => {
    const plans = profile.plansByKey.get(key);
    const name = windowName(key, t);
    return plans === undefined ? name : `${name} (${plans.join(', ')})`;
  });
  return joinWords([...(names.length === 0 ? [t('overall')] : names), ...extra], t);
}

export function capitalized(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/**
 * Help for cswap's `autoswitch.threshold`, which is the 5-hour window's line and, while no weekly
 * line is set, every window's (claude_swap/lines.py `window_line`).
 */
export function switchThresholdHelp(profile: LimitProfile, weeklyThresholdSet: boolean, t: Translate): string {
  if (!mayReport(profile, FIVE_HOUR_WINDOW)) {
    return weeklyThresholdSet
      ? t('These accounts have no 5-hour limit, so the weekly threshold decides when to switch.')
      : t('Switch when the {0} limit reaches this usage.', limitNames(profile, t));
  }
  const plans = profile.plansByKey.get(FIVE_HOUR_WINDOW);
  return plans === undefined
    ? t('Switch when the 5-hour limit reaches this usage; while no weekly threshold is set, the other limits too.')
    : t('Switch when the 5-hour limit ({0}) reaches this usage; while no weekly threshold is set, the other limits too.', plans.join(', '));
}

/**
 * `autoswitch.weeklyThreshold` only differs from the switch threshold where a 5-hour window exists;
 * without one it is shown only once set, so it can be cleared.
 */
export function showWeeklyThreshold(profile: LimitProfile, weeklyThresholdSet: boolean): boolean {
  return weeklyThresholdSet || mayReport(profile, FIVE_HOUR_WINDOW);
}

export function weeklyThresholdHelp(profile: LimitProfile, t: Translate): string {
  return mayReport(profile, FIVE_HOUR_WINDOW)
    ? t('Separate line for the 7-day and per-model windows; not set means the switch threshold.')
    : t('Used instead of the switch threshold, since these accounts have no 5-hour limit. Clear it to keep one threshold.');
}
