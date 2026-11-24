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
    if (holder !== undefined && holder.owner !== this.ownerId && now - holder.heartbeat < this.staleAfterMs()) {
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
  | { readonly kind: 'switched'; readonly fromSlot?: number; readonly toSlot?: number; readonly trigger?: string; readonly verification: VerificationStatus }
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
 * itself, so stopping never kills cswap in the middle of a credential switch. Ticks share the
 * operation gate with manual switching and account changes.
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

  intervalMs(): number {
    const seconds = this.state.rules?.intervalSeconds ?? DEFAULT_TICK_INTERVAL_SECONDS;
    return Math.max(MIN_TICK_INTERVAL_SECONDS, seconds) * 1000;
  }

  async setMode(mode: AutoSwitchMode): Promise<void> {
    if (mode === this.state.mode || this.disposed) {
      return;
    }
    this.clearTimer();
    this.lastNoticeKey = undefined;
    if (mode === 'off') {
      this.update({ ...this.state, mode, role: 'idle' });
      await this.options.lease.release();
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
    const mode = this.state.mode;
    if (mode === 'off' || this.disposed || this.state.ticking) {
      return false;
    }
    if (!(await this.options.lease.tryAcquire(this.now()))) {
      this.update({ ...this.state, role: 'standby' });
      return false;
    }
    const ran = await this.options.gate.run(async () => {
      this.update({ ...this.state, role: 'leader', ticking: true });
      try {
        await this.runTick(mode === 'notify');
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
    void this.options.lease.release();
    this.changed.dispose();
  }

  private async runTick(dryRun: boolean): Promise<void> {
    const outcome = await this.options.cli.autoTick({ dryRun });
    const at = this.now();
    if (!outcome.ok) {
      this.recordError(at, outcome.error, undefined);
      return;
    }
    const result = outcome.value;
    const switchEvent = findEvent(result, 'switch');
    const noSwitch = findEvent(result, 'no-switch');
    const exhausted = findEvent(result, 'all-exhausted');
    const errorEvent = findEvent(result, 'error');

    if (result.outcome === 'error') {
      this.recordError(at, undefined, errorEvent?.message);
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
      const refresh = await this.options.refresher.refresh({ trigger: 'post-switch', verifyActive: true, requireFresh: true });
      this.options.onNotice({ kind: 'switched', ...slots, verification: verifyActive(refresh, switchEvent.toSlot).status });
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
      void this.tick().finally(() => this.schedule(this.intervalMs()));
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
