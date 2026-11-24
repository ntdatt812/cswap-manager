import type { Account } from './types';

/**
 * Client-side mirror of cswap 1.1.0's own write validator (`models.normalize_account_threshold`).
 * The CLI stays the authority; this gives instant feedback and guarantees no value can be read as a
 * command-line flag.
 */
export const THRESHOLD_MIN = 50;
export const THRESHOLD_MAX = 99.9;

export type Validated<T, P> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: P };

export function parseThreshold(input: string): Validated<number, 'not-a-number' | 'out-of-range'> {
  const text = input.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { ok: false, problem: 'not-a-number' };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { ok: false, problem: 'not-a-number' };
  }
  return value >= THRESHOLD_MIN && value <= THRESHOLD_MAX ? { ok: true, value } : { ok: false, problem: 'out-of-range' };
}

export function isValidSlot(slot: number): boolean {
  return Number.isSafeInteger(slot) && slot >= 1;
}

/** Account identity used to follow an account across slot changes: email plus organization. */
export interface AccountIdentity {
  readonly email?: string;
  readonly organizationUuid?: string;
}

export function identityOf(account: Account): AccountIdentity {
  return {
    ...(account.email === undefined ? {} : { email: account.email.toLowerCase() }),
    ...(account.organizationUuid === undefined ? {} : { organizationUuid: account.organizationUuid }),
  };
}

export function hasIdentity(account: Account, identity: AccountIdentity): boolean {
  if (identity.email === undefined) {
    return false;
  }
  return account.email?.toLowerCase() === identity.email && account.organizationUuid === identity.organizationUuid;
}
