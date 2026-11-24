import { compact } from './compact';
import type {
  Account,
  AccountFields,
  AccountsSnapshot,
  ActiveResolution,
  ListPayload,
  ParseWarning,
  StatusActiveAccount,
  StatusPayload,
} from './types';

function flaggedSlots(list: ListPayload): number[] {
  return list.accounts.filter((account) => account.activeFlag === true).map((account) => account.slot);
}

/**
 * `list --json` alone is sufficient when its `activeAccountNumber` and per-account `active` flags
 * agree on exactly one slot (or when there are no accounts at all). Otherwise `status --json` is
 * needed to resolve which account is active.
 */
export function needsStatusCheck(list: ListPayload): boolean {
  if (list.accounts.length === 0) {
    return false;
  }
  const flagged = flaggedSlots(list);
  if (list.activeAccountNumber === undefined) {
    return true;
  }
  return flagged.length !== 1 || flagged[0] !== list.activeAccountNumber;
}

function sameEmail(a: string | undefined, b: string | undefined): boolean | undefined {
  if (a === undefined || b === undefined) {
    return undefined;
  }
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Status describes the same account as a list entry only when the slots match and the emails do
 * not contradict each other. A slot match with differing emails is treated as a different account.
 */
export function statusMatchesAccount(active: StatusActiveAccount, account: Account): boolean {
  if (active.slot === undefined || active.slot !== account.slot) {
    return false;
  }
  return sameEmail(active.email, account.email) !== false;
}

function uniqueDefined(values: ReadonlyArray<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined))];
}

export function resolveActive(list: ListPayload, status?: StatusPayload): ActiveResolution {
  const flagged = flaggedSlots(list);
  const listCandidates = uniqueDefined([list.activeAccountNumber, ...flagged]);
  const listSlot = listCandidates.length === 1 ? listCandidates[0] : undefined;
  const listConsistent =
    listSlot !== undefined && flagged.length <= 1 && list.accounts.some((account) => account.slot === listSlot);

  if (status === undefined) {
    if (listCandidates.length === 0) {
      return { consistency: 'unknown', verifiedWithStatus: false };
    }
    return listConsistent
      ? { slot: listSlot, consistency: 'consistent', verifiedWithStatus: false }
      : { consistency: 'conflict', verifiedWithStatus: false };
  }

  const active = status.active;
  const activeUnmanaged = active !== undefined && (active.managed === false || active.slot === undefined);
  if (active === undefined || activeUnmanaged) {
    // Status reports no managed active account; any list claim contradicts it.
    return listCandidates.length === 0
      ? { consistency: 'consistent', verifiedWithStatus: true, ...(activeUnmanaged ? { activeUnmanaged } : {}) }
      : { consistency: 'conflict', verifiedWithStatus: true, ...(activeUnmanaged ? { activeUnmanaged } : {}) };
  }

  const statusSlot = active.slot;
  const listAccount = list.accounts.find((account) => account.slot === statusSlot);
  const identityConfirmed = listAccount !== undefined && statusMatchesAccount(active, listAccount);

  if (listConsistent && listSlot === statusSlot && identityConfirmed) {
    return { slot: statusSlot, consistency: 'consistent', verifiedWithStatus: true };
  }
  // Sources disagree. Status is the dedicated "who is active" command, so trust it only when its
  // identity is confirmed against the list entry at that slot; otherwise the active slot is unknown.
  return identityConfirmed
    ? { slot: statusSlot, consistency: 'conflict', verifiedWithStatus: true }
    : { consistency: 'conflict', verifiedWithStatus: true };
}

function isNewer(candidate: string | undefined, baseline: string | undefined): boolean {
  if (candidate === undefined) {
    return false;
  }
  return baseline === undefined || Date.parse(candidate) > Date.parse(baseline);
}

/** Replaces an account's usage with the status copy when status is the same account and fresher. */
function mergeStatusUsage(account: Account, active: StatusActiveAccount | undefined): Account {
  if (active === undefined || !statusMatchesAccount(active, account)) {
    return account;
  }
  if (!isNewer(active.usageFetchedAt, account.usageFetchedAt)) {
    return account;
  }
  // Usage fields travel together: never mix a list usage object with a status timestamp.
  const { usageStatus, usage, usageFetchedAt, usageAgeSeconds, ...identity } = account;
  return {
    ...identity,
    ...compact<Pick<AccountFields, 'usageStatus' | 'usage' | 'usageFetchedAt' | 'usageAgeSeconds'>>({
      usageStatus: active.usageStatus,
      usage: active.usage,
      usageFetchedAt: active.usageFetchedAt,
      usageAgeSeconds: active.usageAgeSeconds,
    }),
  };
}

export function buildSnapshot(list: ListPayload, status: StatusPayload | undefined, capturedAt: number): AccountsSnapshot {
  const active = resolveActive(list, status);
  const accounts = status === undefined ? list.accounts : list.accounts.map((account) => mergeStatusUsage(account, status.active));
  const warnings: ParseWarning[] = [...list.warnings, ...(status?.warnings ?? []).map((warning) => ({ ...warning, path: `status:${warning.path}` }))];
  const snapshot: AccountsSnapshot = {
    accounts,
    active,
    capturedAt,
    warnings,
    ...(list.schemaVersion === undefined ? {} : { schemaVersion: list.schemaVersion }),
    ...(status?.totalManagedAccounts === undefined ? {} : { totalManagedAccounts: status.totalManagedAccounts }),
  };
  return snapshot;
}

export function activeAccount(snapshot: AccountsSnapshot): Account | undefined {
  const slot = snapshot.active.slot;
  return slot === undefined ? undefined : snapshot.accounts.find((account) => account.slot === slot);
}
