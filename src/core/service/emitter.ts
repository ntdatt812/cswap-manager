export interface Disposable {
  dispose(): void;
}

/** Minimal event emitter so the core layer does not depend on `vscode.EventEmitter`. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A faulty listener must not break the refresh pipeline or other listeners.
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
