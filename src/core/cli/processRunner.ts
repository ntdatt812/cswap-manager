import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** Hard cap for captured stderr; stderr is only used for short, redacted error notices. */
const STDERR_CAPTURE_LIMIT_BYTES = 64 * 1024;

export interface ProcessRunOptions {
  readonly timeoutMs: number;
  /** Maximum stdout size. Exceeding it terminates the process and fails the run. */
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Text written to stdin, which is then closed (answers a CLI prompt such as `[y/N]`). Without it,
   * stdin is not connected, so any prompt sees end-of-input and cancels.
   */
  readonly input?: string;
}

export type ProcessFailureKind =
  | 'not-found'
  | 'permission-denied'
  | 'unsupported-executable'
  | 'spawn-failed'
  | 'timeout'
  | 'cancelled'
  | 'output-limit';

export interface ProcessExited {
  readonly kind: 'exited';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface ProcessFailed {
  readonly kind: 'failed';
  readonly failure: ProcessFailureKind;
  /** Node/OS error code such as `ENOENT`, when one is available. */
  readonly errorCode?: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export type ProcessResult = ProcessExited | ProcessFailed;

/** Abstraction over process execution so the CLI adapter can be tested without spawning. */
export interface ProcessRunner {
  run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult>;
}

type SpawnFunction = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private overflowed = false;

  constructor(private readonly limit: number) {}

  /** Returns false once the limit has been exceeded; further data is discarded. */
  push(chunk: Buffer): boolean {
    if (this.overflowed) {
      return false;
    }
    if (this.size + chunk.length > this.limit) {
      const remaining = this.limit - this.size;
      if (remaining > 0) {
        this.chunks.push(chunk.subarray(0, remaining));
        this.size += remaining;
      }
      this.overflowed = true;
      return false;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    return true;
  }

  text(): string {
    const decoded = Buffer.concat(this.chunks).toString('utf8');
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function classifySpawnError(code: string | undefined): ProcessFailureKind {
  switch (code) {
    case 'ENOENT':
      return 'not-found';
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    case 'EINVAL':
      // Node refuses to spawn .cmd/.bat without a shell on Windows (CVE-2024-27980 hardening).
      return 'unsupported-executable';
    default:
      return 'spawn-failed';
  }
}

/**
 * Runs an executable directly (never through a shell) with an argument array, a timeout,
 * a stdout size bound and optional cancellation. The promise always resolves; it never rejects.
 */
export class NodeProcessRunner implements ProcessRunner {
  constructor(
    private readonly spawnFn: SpawnFunction = spawn,
    private readonly now: () => number = Date.now,
  ) {}

  run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    const startedAt = this.now();
    const elapsed = (): number => Math.max(0, this.now() - startedAt);

    return new Promise<ProcessResult>((resolve) => {
      if (options.signal?.aborted) {
        resolve({ kind: 'failed', failure: 'cancelled', stderr: '', durationMs: 0 });
        return;
      }

      let child: ChildProcess;
      try {
        child = this.spawnFn(file, [...args], {
          shell: false,
          windowsHide: true,
          stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          cwd: options.cwd,
          env: options.env,
        });
      } catch (error) {
        const errorCode = errorCodeOf(error);
        resolve({
          kind: 'failed',
          failure: classifySpawnError(errorCode),
          ...(errorCode === undefined ? {} : { errorCode }),
          stderr: '',
          durationMs: elapsed(),
        });
        return;
      }

      if (options.input !== undefined) {
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(options.input);
      }

      const stdout = new BoundedBuffer(options.maxOutputBytes);
      const stderr = new BoundedBuffer(Math.min(options.maxOutputBytes, STDERR_CAPTURE_LIMIT_BYTES));
      let settled = false;

      const finish = (result: ProcessResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      // Settle immediately on termination instead of waiting for 'close': a grandchild process that
      // inherited the pipes could otherwise keep the promise pending indefinitely.
      const terminate = (failure: ProcessFailureKind): void => {
        if (settled) {
          return;
        }
        finish({ kind: 'failed', failure, stderr: stderr.text(), durationMs: elapsed() });
        try {
          child.kill();
        } catch {
          // The process may already have exited.
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
      };

      const onAbort = (): void => terminate('cancelled');
      const timer = setTimeout(() => terminate('timeout'), options.timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        if (!stdout.push(chunk)) {
          terminate('output-limit');
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
      });
      child.on('error', (error) => {
        const errorCode = errorCodeOf(error);
        finish({
          kind: 'failed',
          failure: classifySpawnError(errorCode),
          ...(errorCode === undefined ? {} : { errorCode }),
          stderr: stderr.text(),
          durationMs: elapsed(),
        });
      });
      child.on('close', (exitCode, signal) => {
        finish({
          kind: 'exited',
          exitCode,
          signal,
          stdout: stdout.text(),
          stderr: stderr.text(),
          durationMs: elapsed(),
        });
      });
    });
  }
}
