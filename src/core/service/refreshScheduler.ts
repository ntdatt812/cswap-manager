import type { Disposable } from './emitter';

export interface TimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const MIN_REFRESH_INTERVAL_MS = 30_000;

/** `0` disables automatic refresh; other values are raised to the minimum interval. */
export function normalizeIntervalMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.max(MIN_REFRESH_INTERVAL_MS, Math.round(seconds * 1000));
}

export interface RefreshSchedulerOptions {
  readonly tick: () => Promise<unknown>;
  /** When the last refresh attempt started (manual or automatic); drives the next due time. */
  readonly lastRefreshAt: () => number | undefined;
  readonly now?: () => number;
  readonly timers?: TimerApi;
}

/**
 * Periodic refresh that runs only while active (view visible and window focused). The next run is
 * due one interval after the last attempt of any kind, so manual refreshes postpone it and a long
 * hidden period triggers an immediate refresh on return. Ticks never overlap.
 */
export class RefreshScheduler implements Disposable {
  private handle: unknown;
  private active = false;
  private intervalMs = 0;
  private running = false;
  private disposed = false;
  private readonly now: () => number;
  private readonly timers: TimerApi;

  constructor(private readonly options: RefreshSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
  }

  configure(intervalMs: number): void {
    this.intervalMs = intervalMs;
    this.reschedule();
  }

  setActive(active: boolean): void {
    if (this.active !== active) {
      this.active = active;
      this.reschedule();
    }
  }

  isScheduled(): boolean {
    return this.handle !== undefined;
  }

  /** Recomputes the next due time, e.g. after a manual refresh finished. */
  reschedule(): void {
    this.clear();
    if (this.disposed || !this.active || this.intervalMs <= 0 || this.running) {
      return;
    }
    const last = this.options.lastRefreshAt();
    const due = last === undefined ? 0 : Math.max(0, last + this.intervalMs - this.now());
    this.handle = this.timers.setTimeout(() => void this.fire(), due);
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private clear(): void {
    if (this.handle !== undefined) {
      this.timers.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }

  private async fire(): Promise<void> {
    this.handle = undefined;
    this.running = true;
    try {
      await this.options.tick();
    } catch {
      // Errors are reflected in the refresh state; the schedule continues.
    } finally {
      this.running = false;
      this.reschedule();
    }
  }
}
