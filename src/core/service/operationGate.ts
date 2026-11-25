import { Emitter } from './emitter';

/**
 * Serializes every state-changing cswap command (switch, disable, threshold, priority, move) so two
 * mutations never run at once, even when started from different UI surfaces.
 */
export class OperationGate {
  private readonly changed = new Emitter<boolean>();
  readonly onDidChange = this.changed.event;
  private busy = false;

  isBusy(): boolean {
    return this.busy;
  }

  /** Runs `work` exclusively; resolves to `undefined` without running it when the gate is busy. */
  async run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.busy) {
      return undefined;
    }
    this.busy = true;
    this.changed.fire(true);
    try {
      return await work();
    } finally {
      this.busy = false;
      this.changed.fire(false);
    }
  }

  /**
   * Like `run`, but when the gate is busy it waits for it to be free, up to `waitMs` in all;
   * resolves to `undefined` without running `work` when it never is.
   */
  async runWhenFree<T>(work: () => Promise<T>, waitMs: number): Promise<T | undefined> {
    const deadline = Date.now() + waitMs;
    while (this.busy) {
      const left = deadline - Date.now();
      if (left <= 0) {
        return undefined;
      }
      await this.whenFree(left);
    }
    return this.run(work);
  }

  dispose(): void {
    this.changed.dispose();
  }

  private whenFree(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        listener.dispose();
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const listener = this.changed.event((busy) => {
        if (!busy) {
          finish();
        }
      });
    });
  }
}
