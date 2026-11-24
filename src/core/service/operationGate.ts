import { Emitter } from './emitter';

/**
 * Serializes every state-changing cswap command (switch, alias, disable, threshold, move) so two
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

  dispose(): void {
    this.changed.dispose();
  }
}
