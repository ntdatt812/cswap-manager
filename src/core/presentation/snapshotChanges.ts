import { hasIdentity, identityOf } from '../model/accountPolicy';
import type { Account, AccountsSnapshot, UsageWindow } from '../model/types';
import { loginDue } from './accountTree';
import { epochOf, WEEKLY_WINDOW } from './format';

/** A weekly window whose reset time moved on by at least this much started a new period. */
const NEW_PERIOD_MS = 24 * 3_600_000;

/** cswap's 7-day window (`sevenDay` in `list --json`). */
export function weeklyWindow(account: Account | undefined): UsageWindow | undefined {
  return account?.usage?.windows.find((window) => window.key === WEEKLY_WINDOW);
}

/**
 * Accounts whose weekly limit reset since `previous` (its quota is full again): the 7-day window's
 * reset time moved on by a day or more, and some of it had been used. Followed by slot and identity,
 * so an account moved to another slot is not taken for a reset.
 */
export function weeklyResets(previous: AccountsSnapshot | undefined, current: AccountsSnapshot): Account[] {
  if (previous === undefined) {
    return [];
  }
  return current.accounts.filter((account) => {
    const identity = identityOf(account);
    const before = weeklyWindow(previous.accounts.find((candidate) => candidate.slot === account.slot && hasIdentity(candidate, identity)));
    const previousReset = epochOf(before?.resetsAt);
    const currentReset = epochOf(weeklyWindow(account)?.resetsAt);
    return previousReset !== undefined && currentReset !== undefined && currentReset - previousReset >= NEW_PERIOD_MS && (before?.pct ?? 0) > 0;
  });
}

/**
 * The slot Claude Code was just logged in to again: its login needed renewing (due within cswap's
 * 7 days, expired, or refused by the server) and it is now the active account with a login that is
 * no longer due. cswap reads the active account's login from Claude Code itself, so this is what a
 * `/login` to an account cswap already has looks like. The account is followed by identity.
 */
export function renewedLoginSlot(previous: AccountsSnapshot | undefined, current: AccountsSnapshot, now: number): number | undefined {
  const active = current.accounts.find((account) => account.slot === current.active.slot);
  if (previous === undefined || active?.email === undefined || current.active.activeUnmanaged === true) {
    return undefined;
  }
  const identity = identityOf(active);
  const before = previous.accounts.find((account) => hasIdentity(account, identity));
  if (before === undefined) {
    return undefined;
  }
  const neededRenewal = loginDue(before, now) !== undefined || before.usageStatus === 'relogin_required';
  const renewed = active.loginExpiresAt !== undefined && active.loginExpiresAt !== before.loginExpiresAt && loginDue(active, now) === undefined;
  return neededRenewal && renewed ? active.slot : undefined;
}
