import type { CliError } from '../cli/cliErrors';
import type { AddResult, CliOutcome, ManageOperation } from '../cli/cswapCli';
import { hasIdentity, identityOf } from '../model/accountPolicy';
import { priorityOf, type PriorityEntry } from '../model/priorities';
import type { AccountsSnapshot } from '../model/types';
import { Emitter } from './emitter';
import type { OperationGate } from './operationGate';
import type { RefreshRequest, RefreshResult } from './refreshService';

/** A snapshot this recent is trusted as what the user confirmed, without re-reading it (switches and changes). */
export const CONFIRMED_FRESH_MS = 15_000;

/**
 * Whether what the user acted on can be used without re-reading it first (a full cswap list,
 * ~0.6 s): it is recent, still the latest read, and no later refresh failed. A failed refresh after
 * an account change leaves an old snapshot in place, so that always forces the re-read.
 */
export function canTrustConfirmed(
  state: { readonly snapshot?: AccountsSnapshot; readonly lastError?: unknown },
  confirmedWith: AccountsSnapshot,
  now: number,
): boolean {
  return now - confirmedWith.capturedAt <= CONFIRMED_FRESH_MS && state.snapshot === confirmedWith && state.lastError === undefined;
}

export interface ManageCli {
  manage(operation: ManageOperation): Promise<CliOutcome<void>>;
  /** Reads `cswap priority` back: `list --json` carries no priority, so this is how a change is verified. */
  priorities(): Promise<CliOutcome<PriorityEntry[]>>;
  addAccount(options: { readonly slot?: number }): Promise<CliOutcome<AddResult>>;
  addToken(token: string, options: { readonly slot?: number; readonly email?: string }): Promise<CliOutcome<AddResult>>;
}

/** What a change cswap accepted means for priorities, which `list --json` does not carry. */
export interface ManageApplied {
  /** The change can have changed priorities (a priority change, or accounts added, removed or moved). */
  readonly prioritiesChanged: boolean;
  /** `cswap priority` as read to verify a priority change, so it need not be read again. */
  readonly priorities?: readonly PriorityEntry[];
}

const PRIORITY_CHANGING: ReadonlySet<ManageOperation['kind']> = new Set(['setPriority', 'clearPriority', 'move', 'remove']);

export type AddOutcome =
  | { readonly kind: 'busy' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly error: CliError }
  | { readonly kind: 'added'; readonly result: Exclude<AddResult, { kind: 'cancelled' }>; readonly verification: ManageVerification; readonly refreshError?: CliError };

export interface ManageRefresher {
  getState(): { readonly snapshot?: AccountsSnapshot; readonly lastError?: unknown };
  refresh(request: RefreshRequest): Promise<RefreshResult>;
}

export type ManageVerification = 'confirmed' | 'mismatch' | 'unverified';

export type ManageOutcome =
  | { readonly kind: 'busy' }
  | { readonly kind: 'rejected'; readonly reason: 'unknown-account' | 'account-changed' }
  | { readonly kind: 'applied'; readonly verification: ManageVerification; readonly refreshError?: CliError }
  | { readonly kind: 'failed'; readonly error: CliError };

/**
 * Builds a predicate that is true when a refreshed snapshot shows the operation's effect on the
 * same account (followed by email + organization, so a concurrent slot change cannot fool it).
 */
export function expectationFor(operation: ManageOperation, before: AccountsSnapshot): ((after: AccountsSnapshot) => boolean) | undefined {
  const subject = before.accounts.find((account) => account.slot === operation.slot);
  if (subject === undefined) {
    return undefined;
  }
  const identity = identityOf(subject);
  const findSubject = (after: AccountsSnapshot) => after.accounts.find((account) => hasIdentity(account, identity));

  switch (operation.kind) {
    case 'setDisabled':
      return (after) => {
        const account = findSubject(after);
        return account !== undefined && (account.disabled === true) === operation.disabled;
      };
    case 'setThreshold':
      return (after) => {
        const threshold = findSubject(after)?.threshold;
        return threshold !== undefined && Math.abs(threshold - operation.threshold) < 1e-9;
      };
    case 'clearThreshold':
      return (after) => {
        const account = findSubject(after);
        return account !== undefined && account.threshold === undefined;
      };
    case 'setPriority':
    case 'clearPriority':
      // The account must still be there; the tier itself is checked against `cswap priority` in apply().
      return (after) => findSubject(after) !== undefined;
    case 'remove':
      return (after) => findSubject(after) === undefined;
    case 'move': {
      const occupant = before.accounts.find((account) => account.slot === operation.targetSlot);
      const occupantIdentity = occupant === undefined ? undefined : identityOf(occupant);
      return (after) => {
        if (findSubject(after)?.slot !== operation.targetSlot) {
          return false;
        }
        if (occupantIdentity === undefined || occupant?.slot === subject.slot) {
          return true;
        }
        return after.accounts.find((account) => hasIdentity(account, occupantIdentity))?.slot === operation.slot;
      };
    }
  }
}

/** True when each slot holds the same account (or is empty) in both snapshots. */
export function sameAccountsAt(confirmed: AccountsSnapshot, current: AccountsSnapshot, slots: readonly number[]): boolean {
  return slots.every((slot) => {
    const was = confirmed.accounts.find((account) => account.slot === slot);
    const now = current.accounts.find((account) => account.slot === slot);
    if (was === undefined || now === undefined) {
      return was === now;
    }
    return hasIdentity(now, identityOf(was));
  });
}

/** Runs one account-policy change at a time and verifies its effect with a fresh `list --json`. */
export class ManagementService {
  private readonly applied = new Emitter<ManageApplied>();
  /** Fires after cswap accepted a change (e.g. to re-read data that `list --json` lacks). */
  readonly onDidApply = this.applied.event;

  constructor(
    private readonly cli: ManageCli,
    private readonly refresher: ManageRefresher,
    private readonly gate: OperationGate,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * @param confirmedWith the snapshot the user saw when confirming. When given, state is re-read
   * first and the operation is refused if any slot it touches now holds a different account.
   */
  async apply(operation: ManageOperation, confirmedWith?: AccountsSnapshot): Promise<ManageOutcome> {
    const outcome = await this.gate.run(async (): Promise<ManageOutcome> => {
      let before = this.refresher.getState().snapshot;
      if (confirmedWith !== undefined && !canTrustConfirmed(this.refresher.getState(), confirmedWith, this.now())) {
        const fresh = await this.refresher.refresh({ trigger: 'manual', requireFresh: true });
        if (!fresh.ok) {
          return { kind: 'failed', error: fresh.error };
        }
        before = fresh.snapshot;
        const slots = operation.kind === 'move' ? [operation.slot, operation.targetSlot] : [operation.slot];
        if (!sameAccountsAt(confirmedWith, before, slots)) {
          return { kind: 'rejected', reason: 'account-changed' };
        }
      }
      const expectation = before === undefined ? undefined : expectationFor(operation, before);
      if (expectation === undefined) {
        return { kind: 'rejected', reason: 'unknown-account' };
      }
      const result = await this.cli.manage(operation);
      // Refresh even after a failure so every view shows the real state.
      const refresh = await this.refresher.refresh({
        trigger: 'manual',
        requireFresh: true,
        verifyActive: operation.kind === 'move',
      });
      if (!result.ok) {
        return { kind: 'failed', error: result.error };
      }
      let priorities: readonly PriorityEntry[] | undefined;
      let verified: ManageOutcome;
      if (!refresh.ok) {
        verified = { kind: 'applied', verification: 'unverified', refreshError: refresh.error };
      } else if (!expectation(refresh.snapshot)) {
        verified = { kind: 'applied', verification: 'mismatch' };
      } else if (operation.kind === 'setPriority' || operation.kind === 'clearPriority') {
        const read = await this.cli.priorities();
        priorities = read.ok ? read.value : undefined;
        verified = read.ok ? priorityVerification(operation, before, refresh.snapshot, read.value) : { kind: 'applied', verification: 'unverified', refreshError: read.error };
      } else {
        verified = { kind: 'applied', verification: 'confirmed' };
      }
      this.applied.fire({ prioritiesChanged: PRIORITY_CHANGING.has(operation.kind), ...(priorities === undefined ? {} : { priorities }) });
      return verified;
    });
    return outcome ?? { kind: 'busy' };
  }

  /**
   * Stores the current Claude Code login with `cswap add`, then verifies that the active account is
   * now managed (and in the requested slot).
   */
  addCurrent(options: { readonly slot?: number }): Promise<AddOutcome> {
    // `cswap add` makes the stored login the active account in that slot.
    return this.add(
      () => this.cli.addAccount(options),
      (snapshot, slot) => snapshot.active.slot === slot && snapshot.accounts.some((account) => account.slot === slot),
      true,
    );
  }

  /**
   * Registers a setup-token or API key with `cswap add-token`, then verifies the slot is listed. The
   * active account does not change. The token is passed straight through and not kept.
   */
  addToken(token: string, options: { readonly slot?: number; readonly email?: string }): Promise<AddOutcome> {
    return this.add(
      () => this.cli.addToken(token, options),
      (snapshot, slot) => snapshot.accounts.some((account) => account.slot === slot),
      false,
    );
  }

  /** @param verifyActive the run can change the active account, so the refresh after it checks it. */
  private async add(
    run: () => Promise<CliOutcome<AddResult>>,
    landed: (snapshot: AccountsSnapshot, slot: number) => boolean,
    verifyActive: boolean,
  ): Promise<AddOutcome> {
    const outcome = await this.gate.run(async (): Promise<AddOutcome> => {
      const result = await run();
      const refresh = await this.refresher.refresh({ trigger: 'manual', requireFresh: true, verifyActive });
      if (!result.ok) {
        return { kind: 'failed', error: result.error };
      }
      const added = result.value;
      if (added.kind === 'cancelled') {
        return { kind: 'cancelled' };
      }
      this.applied.fire({ prioritiesChanged: true });
      if (!refresh.ok) {
        return { kind: 'added', result: added, verification: 'unverified', refreshError: refresh.error };
      }
      return { kind: 'added', result: added, verification: landed(refresh.snapshot, added.slot) ? 'confirmed' : 'mismatch' };
    });
    return outcome ?? { kind: 'busy' };
  }

  dispose(): void {
    this.applied.dispose();
  }

}

/** Checks a priority change against `cswap priority` read back, following the account by identity. */
function priorityVerification(
  operation: Extract<ManageOperation, { kind: 'setPriority' | 'clearPriority' }>,
  before: AccountsSnapshot | undefined,
  after: AccountsSnapshot,
  entries: readonly PriorityEntry[],
): ManageOutcome {
  const subject = before?.accounts.find((account) => account.slot === operation.slot);
  const account = subject === undefined ? undefined : after.accounts.find((candidate) => hasIdentity(candidate, identityOf(subject)));
  // cswap lists every account, 0 included; a tier that cannot be told apart is unverified, never assumed.
  const tier = account === undefined ? undefined : priorityOf(account, entries);
  if (tier === undefined) {
    return { kind: 'applied', verification: 'unverified' };
  }
  const expected = operation.kind === 'setPriority' ? operation.priority : 0;
  return { kind: 'applied', verification: tier === expected ? 'confirmed' : 'mismatch' };
}
