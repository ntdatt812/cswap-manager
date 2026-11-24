import type { CliError } from '../cli/cliErrors';
import type { CliOutcome, ManageOperation } from '../cli/cswapCli';
import { hasIdentity, identityOf, normalizeAlias } from '../model/accountPolicy';
import type { AccountsSnapshot } from '../model/types';
import type { OperationGate } from './operationGate';
import type { RefreshRequest, RefreshResult } from './refreshService';

export interface ManageCli {
  manage(operation: ManageOperation): Promise<CliOutcome<void>>;
}

export interface ManageRefresher {
  getState(): { readonly snapshot?: AccountsSnapshot };
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
  constructor(
    private readonly cli: ManageCli,
    private readonly refresher: ManageRefresher,
    private readonly gate: OperationGate,
  ) {}

  /**
   * @param confirmedWith the snapshot the user saw when confirming. When given, state is re-read
   * first and the operation is refused if any slot it touches now holds a different account.
   */
  async apply(operation: ManageOperation, confirmedWith?: AccountsSnapshot): Promise<ManageOutcome> {
    const outcome = await this.gate.run(async (): Promise<ManageOutcome> => {
      let before = this.refresher.getState().snapshot;
      if (confirmedWith !== undefined) {
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
      if (!refresh.ok) {
        return { kind: 'applied', verification: 'unverified', refreshError: refresh.error };
      }
      return { kind: 'applied', verification: expectation(refresh.snapshot) ? 'confirmed' : 'mismatch' };
    });
    return outcome ?? { kind: 'busy' };
  }
}
