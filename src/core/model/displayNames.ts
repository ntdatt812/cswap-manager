import { createHash } from 'node:crypto';
import { identityOf } from './accountPolicy';
import type { Account, AccountsSnapshot } from './types';

/**
 * Display names: free-form names (capitals, spaces, accents) the user gives accounts in VS Code.
 * cswap's own alias stays lower-case ASCII because commands use it; display names never reach cswap.
 */
export const DISPLAY_NAME_MAX = 40;

/**
 * Settings key for an account: a short hash of its identity (email + organization), so the name
 * follows the account across slot moves and settings.json never holds the email address.
 */
export function displayNameKey(account: Account): string | undefined {
  const identity = identityOf(account);
  if (identity.email === undefined) {
    return undefined;
  }
  return createHash('sha256').update(`${identity.email}|${identity.organizationUuid ?? ''}`).digest('hex').slice(0, 16);
}

/** Collapses whitespace, drops control characters and caps the length. */
export function cleanDisplayName(input: string): string {
  return input
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DISPLAY_NAME_MAX)
    .trim();
}

/** Sets (or clears) each account's `displayName` from the saved names; idempotent. */
export function applyDisplayNames(snapshot: AccountsSnapshot, names: Readonly<Record<string, string>>): AccountsSnapshot {
  let changed = false;
  const accounts = snapshot.accounts.map((account) => {
    const key = displayNameKey(account);
    const name = key === undefined ? '' : cleanDisplayName(names[key] ?? '');
    if (name === (account.displayName ?? '')) {
      return account;
    }
    changed = true;
    if (name === '') {
      const { displayName: _removed, ...rest } = account;
      return rest;
    }
    return { ...account, displayName: name };
  });
  return changed ? { ...snapshot, accounts } : snapshot;
}
