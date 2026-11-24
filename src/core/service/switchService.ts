import type { CliError } from '../cli/cliErrors';
import type { CliOutcome, SwitchTarget } from '../cli/cswapCli';
import type { AccountsSnapshot, SwitchResult } from '../model/types';
import { Emitter, type Disposable } from './emitter';
import { sameAccountsAt } from './managementService';
import { OperationGate } from './operationGate';
import type { RefreshRequest, RefreshResult } from './refreshService';

export interface SwitchCli {
  switch(target: SwitchTarget): Promise<CliOutcome<SwitchResult>>;
}

export interface SwitchRefresher {
  refresh(request: RefreshRequest): Promise<RefreshResult>;
}

/**
 * - `confirmed`: a fresh list + status refresh shows the expected slot as active, consistently.
 * - `mismatch`: the refreshed state shows a different active slot.
 * - `unverified`: the refresh failed, or the active account could not be determined.
 */
export type VerificationStatus = 'confirmed' | 'mismatch' | 'unverified';

export interface SwitchVerification {
  readonly status: VerificationStatus;
  /** Active slot according to the post-switch refresh, when known. */
  readonly activeSlot?: number;
  readonly refreshError?: CliError;
}

export type SwitchOutcome =
  | { readonly kind: 'busy' }
  | { readonly kind: 'rejected'; readonly reason: 'account-changed' }
  | { readonly kind: 'switched'; readonly result: SwitchResult; readonly verification: SwitchVerification }
  | { readonly kind: 'not-switched'; readonly result: SwitchResult; readonly verification: SwitchVerification }
  | { readonly kind: 'failed'; readonly error: CliError; readonly verification: SwitchVerification };

export function verifyActive(refresh: RefreshResult, expectedSlot: number | undefined): SwitchVerification {
  if (!refresh.ok) {
    return { status: 'unverified', refreshError: refresh.error };
  }
  const active = refresh.snapshot.active;
  const base = active.slot === undefined ? {} : { activeSlot: active.slot };
  if (active.slot === undefined || expectedSlot === undefined) {
    return { status: 'unverified', ...base };
  }
  if (active.slot !== expectedSlot) {
    return { status: 'mismatch', ...base };
  }
  const reliable = active.verifiedWithStatus && active.consistency === 'consistent';
  return { status: reliable ? 'confirmed' : 'unverified', ...base };
}

/**
 * Runs one switch at a time and always follows it with a fresh, status-verified refresh, so the
 * UI reports what the CLI state actually is rather than what the switch command claimed.
 */
export class SwitchService implements Disposable {
  private readonly changed = new Emitter<boolean>();
  /** Fires `true` when a switch starts and `false` when it (and its verification) finishes. */
  readonly onDidChangeSwitching = this.changed.event;
  private running = false;

  constructor(
    private readonly cli: SwitchCli,
    private readonly refresher: SwitchRefresher,
    /** Shared with account-management operations so no two cswap mutations overlap. */
    private readonly gate: OperationGate = new OperationGate(),
  ) {}

  isSwitching(): boolean {
    return this.running;
  }

  /**
   * @param confirmedWith the snapshot the user saw when confirming a slot switch. When given, state is
   * re-read first and the switch is refused if that slot now holds a different account.
   */
  async switch(target: SwitchTarget, confirmedWith?: AccountsSnapshot): Promise<SwitchOutcome> {
    const outcome = await this.gate.run(async (): Promise<SwitchOutcome> => {
      this.running = true;
      this.changed.fire(true);
      try {
        if (confirmedWith !== undefined && target.kind === 'slot') {
          const fresh = await this.refresher.refresh({ trigger: 'manual', requireFresh: true });
          if (fresh.ok && !sameAccountsAt(confirmedWith, fresh.snapshot, [target.slot])) {
            return { kind: 'rejected', reason: 'account-changed' };
          }
        }
        const result = await this.cli.switch(target);
        // Verify even after a failure: a timed-out or errored switch may still have changed state.
        const refresh = await this.refresher.refresh({ trigger: 'post-switch', verifyActive: true, requireFresh: true });
        if (!result.ok) {
          return { kind: 'failed', error: result.error, verification: verifyActive(refresh, undefined) };
        }
        const expected = result.value.to?.slot ?? (target.kind === 'slot' ? target.slot : undefined);
        const verification = verifyActive(refresh, expected);
        return result.value.switched
          ? { kind: 'switched', result: result.value, verification }
          : { kind: 'not-switched', result: result.value, verification };
      } finally {
        this.running = false;
        this.changed.fire(false);
      }
    });
    return outcome ?? { kind: 'busy' };
  }

  dispose(): void {
    this.changed.dispose();
  }
}
