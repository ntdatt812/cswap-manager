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
