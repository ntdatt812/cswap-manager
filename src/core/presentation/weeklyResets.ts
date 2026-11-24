import type { Account, AccountsSnapshot, UsageWindow } from '../model/types';
import { epochOf } from './format';

/** A weekly window whose reset time moved on by at least this much started a new period. */
const NEW_PERIOD_MS = 24 * 3_600_000;

/** cswap's 7-day window (`sevenDay` in `list --json`). */
export function weeklyWindow(account: Account | undefined): UsageWindow | undefined {
  return account?.usage?.windows.find((window) => window.key === 'sevenDay');
}

/**
 * Accounts whose weekly limit reset since `previous` (its quota is full again): the 7-day window's
 * reset time moved on by a day or more, and some of it had been used. Followed by slot and email,
 * so an account moved to another slot is not taken for a reset.
 */
export function weeklyResets(previous: AccountsSnapshot | undefined, current: AccountsSnapshot): Account[] {
  if (previous === undefined) {
    return [];
  }
  return current.accounts.filter((account) => {
    const before = weeklyWindow(
      previous.accounts.find((candidate) => candidate.slot === account.slot && candidate.email?.toLowerCase() === account.email?.toLowerCase()),
    );
    const previousReset = epochOf(before?.resetsAt);
    const currentReset = epochOf(weeklyWindow(account)?.resetsAt);
    return previousReset !== undefined && currentReset !== undefined && currentReset - previousReset >= NEW_PERIOD_MS && (before?.pct ?? 0) > 0;
  });
}
