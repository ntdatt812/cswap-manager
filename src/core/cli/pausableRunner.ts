import type { ProcessResult, ProcessRunOptions, ProcessRunner } from './processRunner';

/** Resolves true once `released` settles, or false as soon as `signal` aborts. */
function waitUnlessAborted(released: Promise<void>, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal === undefined) {
    return released.then(() => true);
  }
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void released.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    });
  });
}

/**
 * The runner every cswap command goes through, with a pause for the cswap update: on Windows a
 * running cswap.exe (and the Python environment behind it) cannot be replaced. While paused, new
 * commands wait (their time limit starts when they do; a cancelled one stops waiting), and the
 * pause itself first lets the commands already running finish.
 */
export class PausableRunner implements ProcessRunner {
  private running = 0;
  private pauses = 0;
  private hold: { readonly released: Promise<void>; readonly release: () => void } | undefined;
  private readonly idleListeners = new Set<() => void>();

  constructor(private readonly inner: ProcessRunner) {}

  async run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    while (this.hold !== undefined) {
      if (!(await waitUnlessAborted(this.hold.released, options.signal))) {
        return { kind: 'failed', failure: 'cancelled', stderr: '', durationMs: 0 };
      }
    }
    this.running += 1;
    try {
      return await this.inner.run(file, args, options);
    } finally {
      this.running -= 1;
      if (this.running === 0) {
        for (const listener of [...this.idleListeners]) {
          listener();
        }
      }
    }
  }

  isPaused(): boolean {
    return this.hold !== undefined;
  }

  /**
   * Runs `work` while no new command starts. Commands already running get up to `drainMs` to end
   * first; `work` receives whether they all did.
   */
  async pauseWhile<T>(work: (drained: boolean) => Promise<T>, drainMs: number): Promise<T> {
    this.pauses += 1;
    if (this.hold === undefined) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.hold = { released, release };
    }
    try {
      return await work(await this.whenIdle(drainMs));
    } finally {
      this.pauses -= 1;
      if (this.pauses === 0) {
        const hold = this.hold;
        this.hold = undefined;
        hold?.release();
      }
    }
  }

  private whenIdle(timeoutMs: number): Promise<boolean> {
    if (this.running === 0) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const finish = (idle: boolean): void => {
        clearTimeout(timer);
        this.idleListeners.delete(onIdle);
        resolve(idle);
      };
      const onIdle = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.idleListeners.add(onIdle);
    });
  }
}
