import type { Account, AccountsSnapshot } from './types';

/** `cswap priority <slot> <tier>`: whole numbers 0–1000 (cswap 1.2.0 `models.normalize_priority`). */
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 1000;

export interface PriorityEntry {
  readonly slot: number;
  readonly email?: string;
  readonly tier: number;
}

/** Digits only, 0–1000, like cswap's own validator. */
export function parsePriority(input: string): number | undefined {
  const text = input.trim();
  if (!/^\d{1,4}$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return value >= PRIORITY_MIN && value <= PRIORITY_MAX ? value : undefined;
}

/**
 * Reads `cswap priority` (no JSON exists). Verified format:
 * `Account priorities (higher first; default 0):`, rows `  Account-N  <email>  <tier>`, then a footer.
 * Returns undefined when the header is missing, so a changed format is never misread.
 */
export function parsePriorityList(stdout: string): PriorityEntry[] | undefined {
  const lines = stdout.replace(/\r/g, '').split('\n');
  if (!lines.some((line) => /^\s*Account priorities\b/i.test(line))) {
    return undefined;
  }
  const entries: PriorityEntry[] = [];
  for (const line of lines) {
    const match = /^\s*Account-(\d+)\s+(.*?)\s+(\d+)\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    const email = (match[2] ?? '').trim();
    entries.push({ slot: Number(match[1]), ...(email.includes('@') ? { email: email.toLowerCase() } : {}), tier: Number(match[3]) });
  }
  return entries;
}

/**
 * The tier of an account. cswap keeps tiers per slot and prints no organization, while one email can
 * own several accounts (one per organization); so the slot decides and the email only cross-checks
 * it. When the slot holds another email (the list was read before a move), an email that appears
 * exactly once still identifies the account; otherwise the tier is unknown.
 */
export function priorityOf(account: Account, entries: readonly PriorityEntry[]): number | undefined {
  const email = account.email?.toLowerCase();
  const bySlot = entries.find((candidate) => candidate.slot === account.slot);
  if (bySlot !== undefined && (email === undefined || bySlot.email === undefined || bySlot.email === email)) {
    return bySlot.tier;
  }
  const byEmail = email === undefined ? [] : entries.filter((candidate) => candidate.email === email);
  return byEmail.length === 1 ? byEmail[0]?.tier : undefined;
}

/** Sets (or clears) each account's `priority` from the last read of `cswap priority`; idempotent. */
export function applyPriorities(snapshot: AccountsSnapshot, entries: readonly PriorityEntry[] | undefined): AccountsSnapshot {
  let changed = false;
  const accounts = snapshot.accounts.map((account) => {
    const tier = entries === undefined ? undefined : priorityOf(account, entries);
    if (tier === account.priority) {
      return account;
    }
    changed = true;
    if (tier === undefined) {
      const { priority: _removed, ...rest } = account;
      return rest;
    }
    return { ...account, priority: tier };
  });
  return changed ? { ...snapshot, accounts } : snapshot;
}
