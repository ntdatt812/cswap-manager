import type { CliError } from '../cli/cliErrors';
import type { AddResult, CliOutcome, ManageOperation } from '../cli/cswapCli';
import { hasIdentity, identityOf, normalizeAlias } from '../model/accountPolicy';
import { priorityOf, type PriorityEntry } from '../model/priorities';
import type { AccountsSnapshot } from '../model/types';
import { Emitter } from './emitter';
import type { OperationGate } from './operationGate';
import type { RefreshRequest, RefreshResult } from './refreshService';

/** A snapshot this recent is trusted as what the user confirmed, without re-reading it (switches and changes). */
export const CONFIRMED_FRESH_MS = 15_000;

export interface ManageCli {
  manage(operation: ManageOperation): Promise<CliOutcome<void>>;
  /** Reads `cswap priority` back: `list --json` carries no priority, so this is how a change is verified. */
  priorities?(): Promise<CliOutcome<PriorityEntry[]>>;
  addAccount?(options: { readonly slot?: number; readonly alias?: string }): Promise<CliOutcome<AddResult>>;
}

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
    case 'setAlias': {
      const alias = normalizeAlias(operation.alias);
      return (after) => alias.ok && findSubject(after)?.alias === alias.value;
    }
    case 'removeAlias':
      return (after) => {
        const account = findSubject(after);
        return account !== undefined && account.alias === undefined;
      };
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
  private readonly applied = new Emitter<void>();
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
      if (confirmedWith !== undefined && !this.canTrust(confirmedWith)) {
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
      this.applied.fire();
      if (!refresh.ok) {
        return { kind: 'applied', verification: 'unverified', refreshError: refresh.error };
      }
      if (!expectation(refresh.snapshot)) {
        return { kind: 'applied', verification: 'mismatch' };
      }
      if (operation.kind === 'setPriority' || operation.kind === 'clearPriority') {
        return this.verifyPriority(operation, before, refresh.snapshot);
      }
      return { kind: 'applied', verification: 'confirmed' };
    });
    return outcome ?? { kind: 'busy' };
  }

  /**
   * Stores the current Claude Code login with `cswap add`, then verifies that the active account is
   * now managed (and in the requested slot).
   */
  async addCurrent(options: { readonly slot?: number; readonly alias?: string }): Promise<AddOutcome> {
    const outcome = await this.gate.run(async (): Promise<AddOutcome> => {
      if (this.cli.addAccount === undefined) {
        return { kind: 'cancelled' };
      }
      const result = await this.cli.addAccount(options);
      const refresh = await this.refresher.refresh({ trigger: 'manual', requireFresh: true, verifyActive: true });
      if (!result.ok) {
        return { kind: 'failed', error: result.error };
      }
      const added = result.value;
      if (added.kind === 'cancelled') {
        return { kind: 'cancelled' };
      }
      this.applied.fire();
      if (!refresh.ok) {
        return { kind: 'added', result: added, verification: 'unverified', refreshError: refresh.error };
      }
      // `cswap add` makes the stored login the active account in that slot.
      const confirmed = refresh.snapshot.active.slot === added.slot && refresh.snapshot.accounts.some((account) => account.slot === added.slot);
      return { kind: 'added', result: added, verification: confirmed ? 'confirmed' : 'mismatch' };
    });
    return outcome ?? { kind: 'busy' };
  }

  dispose(): void {
    this.applied.dispose();
  }

  /**
   * Like switching: the re-read before a change (a full cswap list, ~0.6 s) is skipped only when what
   * the user acted on is recent, is still the latest read, and no later refresh failed.
   */
  private canTrust(confirmedWith: AccountsSnapshot): boolean {
    const state = this.refresher.getState();
    return this.now() - confirmedWith.capturedAt <= CONFIRMED_FRESH_MS && state.snapshot === confirmedWith && state.lastError === undefined;
  }

  private async verifyPriority(
    operation: Extract<ManageOperation, { kind: 'setPriority' | 'clearPriority' }>,
    before: AccountsSnapshot | undefined,
    after: AccountsSnapshot,
  ): Promise<ManageOutcome> {
    const read = await this.cli.priorities?.();
    if (read === undefined || !read.ok) {
      return { kind: 'applied', verification: 'unverified', ...(read === undefined || read.ok ? {} : { refreshError: read.error }) };
    }
    const subject = before?.accounts.find((account) => account.slot === operation.slot);
    const account = subject === undefined ? undefined : after.accounts.find((candidate) => hasIdentity(candidate, identityOf(subject)));
    // cswap lists every account, 0 included; a tier that cannot be told apart is unverified, never assumed.
    const tier = account === undefined ? undefined : priorityOf(account, read.value);
    if (tier === undefined) {
      return { kind: 'applied', verification: 'unverified' };
    }
    const expected = operation.kind === 'setPriority' ? operation.priority : 0;
    return { kind: 'applied', verification: tier === expected ? 'confirmed' : 'mismatch' };
  }
}
