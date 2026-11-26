import { cliError, type CliError } from '../cli/cliErrors';
import type { CliOutcome } from '../cli/cswapCli';
import { buildSnapshot, needsStatusCheck } from '../model/reconcile';
import type { AccountsSnapshot, ListPayload, StatusPayload } from '../model/types';
import { Emitter, type Disposable } from './emitter';

export interface AccountsCli {
  list(signal?: AbortSignal): Promise<CliOutcome<ListPayload>>;
  status(signal?: AbortSignal): Promise<CliOutcome<StatusPayload>>;
}

export type RefreshTrigger = 'manual' | 'activation' | 'interval' | 'view-visible' | 'post-switch' | 'configuration' | 'external';

export interface RefreshRequest {
  readonly trigger: RefreshTrigger;
  /** Also run `status --json` to confirm the active account (e.g. after switching). */
  readonly verifyActive?: boolean;
  /**
   * Require data gathered after this call. When a refresh is already running, a follow-up run is
   * queued instead of sharing the in-flight result (which may predate a just-completed switch).
   */
  readonly requireFresh?: boolean;
}

export interface AccountsState {
  /** Last successfully refreshed data; kept when later refreshes fail. */
  readonly snapshot?: AccountsSnapshot;
  readonly lastSuccessAt?: number;
  readonly lastAttemptAt?: number;
  /** Error of the most recent attempt; cleared by the next success. */
  readonly lastError?: CliError;
  /** Non-fatal problem of the most recent successful refresh (e.g. status verification failed). */
  readonly lastWarning?: CliError;
  readonly refreshing: boolean;
}

export type RefreshResult =
  | { readonly ok: true; readonly snapshot: AccountsSnapshot }
  | { readonly ok: false; readonly error: CliError; readonly snapshot?: AccountsSnapshot };

/**
 * - `none`: no data has ever been loaded (show empty/error guidance, not an empty list).
 * - `fresh`: the last attempt succeeded recently.
 * - `stale`: data exists but the last attempt failed or it is older than the stale threshold.
 */
export type Freshness = 'none' | 'fresh' | 'stale';
export type StaleReason = 'refresh-failed' | 'too-old';

export interface FreshnessAssessment {
  readonly freshness: Freshness;
  readonly reason?: StaleReason;
}

export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export function assessFreshness(state: AccountsState, now: number, staleAfterMs = DEFAULT_STALE_AFTER_MS): FreshnessAssessment {
  if (state.snapshot === undefined || state.lastSuccessAt === undefined) {
    return { freshness: 'none' };
  }
  if (state.lastError !== undefined) {
    return { freshness: 'stale', reason: 'refresh-failed' };
  }
  if (now - state.lastSuccessAt > staleAfterMs) {
    return { freshness: 'stale', reason: 'too-old' };
  }
  return { freshness: 'fresh' };
}

export interface RefreshServiceOptions {
  readonly cli: AccountsCli;
  readonly now?: () => number;
  /** Adds extension-side data (display names) to every snapshot. */
  readonly decorate?: (snapshot: AccountsSnapshot) => AccountsSnapshot;
}

interface FollowUp {
  verifyActive: boolean;
  readonly promise: Promise<RefreshResult>;
}

/**
 * Owns the accounts cache. Concurrent refresh calls share one run (refreshes never overlap); a
 * verifying run starts `list` and `status` together, which cswap supports: both go through its shared
 * usage collector, which claims each fetch and shares one cache. Failures keep the last good
 * snapshot and mark it stale instead of discarding it.
 */
export class RefreshService implements Disposable {
  private readonly changed = new Emitter<AccountsState>();
  readonly onDidChange = this.changed.event;

  private state: AccountsState = { refreshing: false };
  private current: Promise<RefreshResult> | undefined;
  private followUp: FollowUp | undefined;
  private controller: AbortController | undefined;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly options: RefreshServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  getState(): AccountsState {
    return this.state;
  }

  /** Re-applies `decorate` to the current snapshot (e.g. a display name changed); no CLI call. */
  redecorate(): void {
    const snapshot = this.state.snapshot;
    if (snapshot === undefined) {
      return;
    }
    const next = this.decorate(snapshot);
    if (next !== snapshot) {
      this.update({ ...this.state, snapshot: next });
    }
  }

  private decorate(snapshot: AccountsSnapshot): AccountsSnapshot {
    return this.options.decorate === undefined ? snapshot : this.options.decorate(snapshot);
  }

  refresh(request: RefreshRequest): Promise<RefreshResult> {
    if (this.disposed) {
      return Promise.resolve(this.cancelledResult());
    }
    // A queued follow-up is fresh enough for a requireFresh request, and for any request just after
    // its run ended (it is about to start): join it rather than start a second cswap run.
    if (this.followUp !== undefined && (this.current === undefined || request.requireFresh === true)) {
      this.followUp.verifyActive ||= request.verifyActive === true;
      return this.followUp.promise;
    }
    if (this.current === undefined) {
      return this.start(request.verifyActive === true);
    }
    if (request.requireFresh !== true) {
      return this.current;
    }
    const running = this.current;
    const followUp: FollowUp = {
      verifyActive: request.verifyActive === true,
      promise: running.then(() => {
        this.followUp = undefined;
        return this.disposed ? this.cancelledResult() : this.start(followUp.verifyActive);
      }),
    };
    this.followUp = followUp;
    return followUp.promise;
  }

  /** Resolves once no refresh is running or queued (at once when idle or disposed); starts none. */
  async whenIdle(): Promise<void> {
    for (let pending = this.followUp?.promise ?? this.current; pending !== undefined && !this.disposed; pending = this.followUp?.promise ?? this.current) {
      await pending;
    }
  }

  dispose(): void {
    this.disposed = true;
    // A cancelled run never reports back, so nothing counts as running from here on.
    this.state = { ...this.state, refreshing: false };
    this.controller?.abort();
    this.changed.dispose();
  }

  private start(verifyActive: boolean): Promise<RefreshResult> {
    const controller = new AbortController();
    this.controller = controller;
    this.update({ ...this.state, refreshing: true, lastAttemptAt: this.now() });
    const run = this.execute(verifyActive, controller.signal)
      .catch(() => this.recordFailure(cliError('unexpected-error')))
      .finally(() => {
      if (this.current === run) {
        this.current = undefined;
      }
      if (this.controller === controller) {
        this.controller = undefined;
      }
    });
    this.current = run;
    return run;
  }

  private async execute(verifyActive: boolean, signal: AbortSignal): Promise<RefreshResult> {
    // When the active account must be verified (after a switch), status is needed anyway: run it
    // alongside list instead of after it. Each cswap call costs ~0.4–0.7 s of start-up.
    const [list, earlyStatus] = verifyActive
      ? await Promise.all([this.options.cli.list(signal), this.options.cli.status(signal)])
      : [await this.options.cli.list(signal), undefined];
    if (this.disposed) {
      return this.cancelledResult();
    }
    if (!list.ok) {
      return this.recordFailure(list.error);
    }

    let status: StatusPayload | undefined;
    let warning: CliError | undefined;
    const statusOutcome = earlyStatus ?? (needsStatusCheck(list.value) ? await this.options.cli.status(signal) : undefined);
    if (statusOutcome !== undefined) {
      if (this.disposed) {
        return this.cancelledResult();
      }
      if (statusOutcome.ok) {
        status = statusOutcome.value;
      } else {
        // The list data is still valid; the active account simply remains unverified.
        warning = statusOutcome.error;
      }
    }

    const completedAt = this.now();
    const snapshot = this.decorate(buildSnapshot(list.value, status, completedAt));
    this.update({
      snapshot,
      lastSuccessAt: completedAt,
      ...(this.state.lastAttemptAt === undefined ? {} : { lastAttemptAt: this.state.lastAttemptAt }),
      ...(warning === undefined ? {} : { lastWarning: warning }),
      refreshing: false,
    });
    return { ok: true, snapshot };
  }

  private recordFailure(error: CliError): RefreshResult {
    const { lastWarning: _previousWarning, ...rest } = this.state;
    this.update({ ...rest, lastError: error, refreshing: false });
    return this.state.snapshot === undefined ? { ok: false, error } : { ok: false, error, snapshot: this.state.snapshot };
  }

  private cancelledResult(): RefreshResult {
    const error = cliError('cancelled');
    return this.state.snapshot === undefined ? { ok: false, error } : { ok: false, error, snapshot: this.state.snapshot };
  }

  private update(next: AccountsState): void {
    this.state = next;
    if (!this.disposed) {
      this.changed.fire(next);
    }
  }
}
