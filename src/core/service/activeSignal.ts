import { defaultTimers, type TimerApi } from './refreshScheduler';

/**
 * Cross-window "the active account changed" signal. Auto-switch runs in one VS Code window only,
 * and a window refreshes on its own only while focused, so other windows would keep showing the old
 * account. Each window writes this tiny signal when it sees the active slot change; the others
 * refresh when it changes. It carries no account data: a slot number, a time and a window id.
 */
export interface ActiveSignal {
  readonly slot: number | null;
  readonly at: number;
  /** `vscode.env.sessionId` of the window that wrote it. */
  readonly origin: string;
}

export const ACTIVE_SIGNAL_FILE = 'active-account.signal.json';

/** Lets a burst of file events (write + rename) settle before the signal is read. */
export const SIGNAL_SETTLE_MS = 300;
/**
 * Background windows read the signal at a random moment within this time: each re-read starts
 * cswap, and a switch seen by every window at once would start it everywhere at the moment Claude
 * Code is busiest.
 */
export const BACKGROUND_READ_WITHIN_MS = 5_000;

/** When to read a new signal: soon in the focused window, at a random moment within 5 s elsewhere (`random` in [0, 1)). */
export function signalReadDelay(focused: boolean, random: number): number {
  return SIGNAL_SETTLE_MS + (focused ? 0 : random * (BACKGROUND_READ_WITHIN_MS - SIGNAL_SETTLE_MS));
}

/**
 * Schedules the one pending read of the signal: a new signal event in the focused window reads it
 * after `SIGNAL_SETTLE_MS`; in a background window it keeps a read already waiting (which picks up
 * the newest signal anyway) instead of starting the wait over; gaining focus brings a waiting read
 * forward.
 */
export class SignalReadTimer {
  private handle: unknown;
  private pending = false;

  constructor(
    private readonly read: () => void,
    private readonly timers: TimerApi = defaultTimers,
    private readonly random: () => number = Math.random,
  ) {}

  signalChanged(focused: boolean): void {
    if (!this.pending || focused) {
      this.schedule(focused);
    }
  }

  focusChanged(focused: boolean): void {
    if (this.pending && focused) {
      this.schedule(true);
    }
  }

  dispose(): void {
    this.cancel();
  }

  private schedule(focused: boolean): void {
    this.cancel();
    this.pending = true;
    this.handle = this.timers.setTimeout(() => {
      this.pending = false;
      this.read();
    }, signalReadDelay(focused, this.random()));
  }

  private cancel(): void {
    if (this.pending) {
      this.timers.clearTimeout(this.handle);
      this.pending = false;
    }
  }
}

/** Reads a signal; anything malformed is ignored rather than trusted. */
export function parseActiveSignal(text: string): ActiveSignal | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { slot, at, origin } = value as Record<string, unknown>;
  const validSlot = slot === null || (typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < 10_000);
  if (!validSlot || typeof at !== 'number' || !Number.isFinite(at) || typeof origin !== 'string' || origin.length === 0 || origin.length > 200) {
    return undefined;
  }
  return { slot, at, origin };
}

export function serializeActiveSignal(signal: ActiveSignal): string {
  return JSON.stringify({ slot: signal.slot, at: signal.at, origin: signal.origin });
}

/**
 * Tracks the active slot this window last saw and decides when to write or follow a signal.
 * Writing happens only on a real change after the first load, and following only for another
 * window's signal that disagrees with what this window shows, so windows never ping-pong.
 */
export class ActiveSlotTracker {
  private known = false;
  private slot: number | null = null;

  constructor(private readonly origin: string) {}

  /** Records a fresh snapshot; returns the signal to write when the active slot changed. */
  observe(slot: number | undefined, now: number): ActiveSignal | undefined {
    const next = slot ?? null;
    const changed = this.known && next !== this.slot;
    this.known = true;
    this.slot = next;
    return changed ? { slot: next, at: now, origin: this.origin } : undefined;
  }

  /** True when another window reports an active slot this window does not show yet. */
  shouldRefresh(signal: ActiveSignal): boolean {
    return signal.origin !== this.origin && (!this.known || signal.slot !== this.slot);
  }
}
