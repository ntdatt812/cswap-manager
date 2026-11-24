import type { CliError } from '../cli/cliErrors';
import type { CliOutcome } from '../cli/cswapCli';
import { findEvent, type AutoOutcome, type AutoSwitchRules, type AutoTickResult } from '../model/autoSwitch';
import { Emitter, type Disposable } from './emitter';
import type { OperationGate } from './operationGate';
import type { TimerApi } from './refreshScheduler';
import type { RefreshRequest, RefreshResult } from './refreshService';
import { verifyActive, type VerificationStatus } from './switchService';

/** `off`: nothing runs. `notify`: dry runs only, tell the user when cswap would switch. `switch`: cswap switches. */
export type AutoSwitchMode = 'off' | 'notify' | 'switch';
export const AUTO_SWITCH_MODES: readonly AutoSwitchMode[] = ['off', 'notify', 'switch'];

export function isAutoSwitchMode(value: unknown): value is AutoSwitchMode {
  return typeof value === 'string' && (AUTO_SWITCH_MODES as readonly string[]).includes(value);
}

export interface AutoSwitchCli {
  autoTick(options: { readonly dryRun: boolean }): Promise<CliOutcome<AutoTickResult>>;
  readAutoSwitchRules(): Promise<CliOutcome<AutoSwitchRules>>;
}

export interface AutoSwitchRefresher {
  refresh(request: RefreshRequest): Promise<RefreshResult>;
}

/** Cross-window ownership: only the lease holder runs ticks. */
export interface LeaderLease {
  tryAcquire(now: number): Promise<boolean>;
  release(): Promise<void>;
}

export interface LeaseStore {
  read(): Promise<string | undefined>;
  write(content: string): Promise<void>;
  remove(): Promise<void>;
}

/**
 * A lease in a shared file: the holder refreshes a heartbeat every tick; another window may take
 * over once the heartbeat is older than `staleAfterMs`. Write-then-verify settles simple races.
 */
export class FileLease implements LeaderLease {
  constructor(
    private readonly store: LeaseStore,
    private readonly ownerId: string,
    private readonly staleAfterMs: () => number,
  ) {}

  private async current(): Promise<{ owner: string; heartbeat: number } | undefined> {
    try {
      const raw = await this.store.read();
      const parsed = raw === undefined ? undefined : (JSON.parse(raw) as { owner?: unknown; heartbeat?: unknown });
      return typeof parsed?.owner === 'string' && typeof parsed.heartbeat === 'number'
        ? { owner: parsed.owner, heartbeat: parsed.heartbeat }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async tryAcquire(now: number): Promise<boolean> {
    const holder = await this.current();
    const staleAfter = this.staleAfterMs();
    // A heartbeat too far in the future (clock change, corrupted file) counts as stale, so a lost
    // holder can always be replaced.
    const fresh = holder !== undefined && now - holder.heartbeat < staleAfter && holder.heartbeat - now < staleAfter;
    if (holder !== undefined && holder.owner !== this.ownerId && fresh) {
      return false;
    }
    await this.store.write(JSON.stringify({ owner: this.ownerId, heartbeat: now }));
    return (await this.current())?.owner === this.ownerId;
  }

  async release(): Promise<void> {
    if ((await this.current())?.owner === this.ownerId) {
      await this.store.remove();
    }
  }
}

export type AutoSwitchNotice =
  | {
      readonly kind: 'switched';
      readonly fromSlot?: number;
      readonly toSlot?: number;
      readonly trigger?: string;
      readonly verification: VerificationStatus;
      /** Active slot according to the post-switch refresh, when known. */
      readonly activeSlot?: number;
    }
  | { readonly kind: 'would-switch'; readonly fromSlot?: number; readonly toSlot?: number; readonly trigger?: string }
  | { readonly kind: 'blocked'; readonly earliestResetAt?: string }
  | { readonly kind: 'failing'; readonly error?: CliError; readonly message?: string };

export type AutoSwitchRole = 'idle' | 'leader' | 'standby';

export interface AutoSwitchState {
  readonly mode: AutoSwitchMode;
  readonly role: AutoSwitchRole;
  readonly ticking: boolean;
  readonly rules?: AutoSwitchRules;
  readonly lastTickAt?: number;
  readonly lastOutcome?: AutoOutcome;
  readonly lastReason?: string;
  readonly lastSwitch?: { readonly at: number; readonly fromSlot?: number; readonly toSlot?: number; readonly dryRun: boolean };
  readonly consecutiveErrors: number;
}

export const DEFAULT_TICK_INTERVAL_SECONDS = 60;
export const MIN_TICK_INTERVAL_SECONDS = 15;
export const MAX_TICK_INTERVAL_SECONDS = 3_600;
/** Message for a tick that could not run because the shared lease file could not be written. */
export const LEASE_UNAVAILABLE = 'lease-unavailable';
/** Delay before the first tick after enabling, so startup is not slowed down. */
export const FIRST_TICK_DELAY_MS = 5_000;
/** Consecutive failed ticks before the user is told. */
export const ERROR_NOTICE_AFTER = 3;

export interface AutoSwitchServiceOptions {
  readonly cli: AutoSwitchCli;
  readonly refresher: AutoSwitchRefresher;
  readonly gate: OperationGate;
  readonly lease: LeaderLease;
  readonly onNotice: (notice: AutoSwitchNotice) => void;
  readonly now?: () => number;
  readonly timers?: TimerApi;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Runs `cswap auto --once` on a schedule while enabled. Each tick is a short process that exits by
 * itself, so turning auto-switch off never kills cswap in the middle of a credential switch (a real
 * tick is only stopped by a long safety timeout). The mode is re-read inside the operation gate
 * right before cswap starts, and only `switch` mode runs without `--dry-run`. Ticks share the gate
 * with manual switching and account changes.
 */
export class AutoSwitchService implements Disposable {
  private readonly changed = new Emitter<AutoSwitchState>();
  readonly onDidChange = this.changed.event;
  private state: AutoSwitchState = { mode: 'off', role: 'idle', ticking: false, consecutiveErrors: 0 };
  private handle: unknown;
  private disposed = false;
  private lastNoticeKey: string | undefined;
  private readonly now: () => number;
  private readonly timers: TimerApi;

  constructor(private readonly options: AutoSwitchServiceOptions) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
  }

  getState(): AutoSwitchState {
    return this.state;
  }

  /** Always a finite interval within [15 s, 1 h], whatever cswap's config contains. */
  intervalMs(): number {
    const seconds = this.state.rules?.intervalSeconds;
    const valid = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : DEFAULT_TICK_INTERVAL_SECONDS;
    return Math.min(MAX_TICK_INTERVAL_SECONDS, Math.max(MIN_TICK_INTERVAL_SECONDS, valid)) * 1000;
  }

  async setMode(mode: AutoSwitchMode): Promise<void> {
    if (mode === this.state.mode || this.disposed) {
      return;
    }
    this.clearTimer();
    this.lastNoticeKey = undefined;
    if (mode === 'off') {
      this.update({ ...this.state, mode, role: 'idle' });
      await this.options.lease.release().catch(() => undefined);
      return;
    }
    this.update({ ...this.state, mode, consecutiveErrors: 0 });
    await this.reloadRules();
    this.schedule(FIRST_TICK_DELAY_MS);
  }

  /** Re-reads cswap's auto-switch rules (interval, threshold, …) and reschedules. */
  async reloadRules(): Promise<AutoSwitchRules | undefined> {
    const outcome = await this.options.cli.readAutoSwitchRules();
    if (outcome.ok) {
      this.update({ ...this.state, rules: outcome.value });
      return outcome.value;
    }
    return undefined;
  }

  /** A dry-run evaluation for "what would happen now", independent of the mode. */
  preview(): Promise<CliOutcome<AutoTickResult>> {
    return this.options.cli.autoTick({ dryRun: true });
  }

  /** Runs one scheduled tick now (also used by tests). Returns false when skipped. */
  async tick(): Promise<boolean> {
    if (this.state.mode === 'off' || this.disposed || this.state.ticking) {
      return false;
    }
    let leader: boolean;
    try {
      leader = await this.options.lease.tryAcquire(this.now());
    } catch {
      // The shared lease file cannot be written (antivirus lock, disk full, permissions).
      this.recordError(this.now(), undefined, LEASE_UNAVAILABLE);
      return false;
    }
    if (!leader) {
      this.update({ ...this.state, role: 'standby' });
      return false;
    }
    const ran = await this.options.gate.run(async () => {
      // Re-read the mode right before starting cswap: it may have changed while the lease was being
      // acquired. Only `switch` runs without --dry-run; anything else is a dry run or nothing.
      const mode = this.state.mode;
      if (mode === 'off' || this.disposed) {
        return false;
      }
      this.update({ ...this.state, role: 'leader', ticking: true });
      try {
        await this.runTick(mode !== 'switch');
      } finally {
        this.update({ ...this.state, ticking: false });
      }
      return true;
    });
    return ran === true;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    void this.options.lease.release().catch(() => undefined);
    this.changed.dispose();
  }

  /** After a real tick that did not end cleanly, re-read state so no view keeps showing a stale account. */
  private async refreshAfterRealTick(): Promise<RefreshResult> {
    return this.options.refresher.refresh({ trigger: 'post-switch', verifyActive: true, requireFresh: true });
  }

  private async runTick(dryRun: boolean): Promise<void> {
    const outcome = await this.options.cli.autoTick({ dryRun });
    const at = this.now();
    if (!outcome.ok) {
      this.recordError(at, outcome.error, undefined);
      if (!dryRun) {
        await this.refreshAfterRealTick();
      }
      return;
    }
    const result = outcome.value;
    const switchEvent = findEvent(result, 'switch');
    const noSwitch = findEvent(result, 'no-switch');
    const exhausted = findEvent(result, 'all-exhausted');
    const errorEvent = findEvent(result, 'error');

    if (result.outcome === 'error') {
      this.recordError(at, undefined, errorEvent?.message);
      if (!dryRun) {
        await this.refreshAfterRealTick();
      }
      return;
    }
    if (!dryRun && result.outcome === 'switched' && switchEvent === undefined) {
      // cswap says it switched but no switch event could be read (format change, broken line).
      // Still verify and tell the user: every real switch must produce a notification.
      this.lastNoticeKey = undefined;
      const verification = verifyActive(await this.refreshAfterRealTick(), undefined);
      const active = verification.activeSlot === undefined ? {} : { toSlot: verification.activeSlot, activeSlot: verification.activeSlot };
      this.update({ ...this.state, lastTickAt: at, lastOutcome: 'switched', consecutiveErrors: 0, lastSwitch: { at, dryRun: false, ...active } });
      this.options.onNotice({ kind: 'switched', verification: verification.status, ...active });
      return;
    }
    const base: AutoSwitchState = {
      ...this.state,
      lastTickAt: at,
      lastOutcome: result.outcome,
      consecutiveErrors: 0,
      ...(noSwitch?.reason === undefined ? {} : { lastReason: noSwitch.reason }),
    };

    if (switchEvent !== undefined && result.outcome === 'switched') {
      const moved = {
        at,
        dryRun: dryRun || switchEvent.dryRun,
        ...(switchEvent.fromSlot === undefined ? {} : { fromSlot: switchEvent.fromSlot }),
        ...(switchEvent.toSlot === undefined ? {} : { toSlot: switchEvent.toSlot }),
      };
      const { lastReason: _ignored, ...withoutReason } = base;
      this.update({ ...withoutReason, lastSwitch: moved });
      const slots = {
        ...(switchEvent.fromSlot === undefined ? {} : { fromSlot: switchEvent.fromSlot }),
        ...(switchEvent.toSlot === undefined ? {} : { toSlot: switchEvent.toSlot }),
        ...(switchEvent.trigger === undefined ? {} : { trigger: switchEvent.trigger }),
      };
      if (moved.dryRun) {
        this.noticeOnce(`would:${switchEvent.fromSlot ?? '?'}->${switchEvent.toSlot ?? '?'}`, { kind: 'would-switch', ...slots });
        return;
      }
      this.lastNoticeKey = undefined;
      const verification = verifyActive(await this.refreshAfterRealTick(), switchEvent.toSlot);
      this.options.onNotice({
        kind: 'switched',
        ...slots,
        verification: verification.status,
        ...(verification.activeSlot === undefined ? {} : { activeSlot: verification.activeSlot }),
      });
      return;
    }

    this.update(base);
    if (result.outcome === 'blocked' || exhausted !== undefined) {
      this.noticeOnce('blocked', { kind: 'blocked', ...(exhausted?.earliestResetAt === undefined ? {} : { earliestResetAt: exhausted.earliestResetAt }) });
      return;
    }
    // Back to normal: allow the same notice again next time the situation recurs.
    this.lastNoticeKey = undefined;
  }

  private recordError(at: number, error: CliError | undefined, message: string | undefined): void {
    const consecutiveErrors = this.state.consecutiveErrors + 1;
    this.update({ ...this.state, lastTickAt: at, lastOutcome: 'error', consecutiveErrors });
    if (consecutiveErrors === ERROR_NOTICE_AFTER) {
      this.options.onNotice({ kind: 'failing', ...(error === undefined ? {} : { error }), ...(message === undefined ? {} : { message }) });
    }
  }

  private noticeOnce(key: string, notice: AutoSwitchNotice): void {
    if (this.lastNoticeKey !== key) {
      this.lastNoticeKey = key;
      this.options.onNotice(notice);
    }
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (this.disposed || this.state.mode === 'off') {
      return;
    }
    this.handle = this.timers.setTimeout(() => {
      this.handle = undefined;
      void this.tick()
        .catch(() => false)
        .finally(() => this.schedule(this.intervalMs()));
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.handle !== undefined) {
      this.timers.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }

  private update(next: AutoSwitchState): void {
    this.state = next;
    if (!this.disposed) {
      this.changed.fire(next);
    }
  }
}
