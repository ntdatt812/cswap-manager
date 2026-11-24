import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CliOutcome } from '../../src/core/cli/cswapCli';
import { cliError, type CliCommandId, type CliErrorKind } from '../../src/core/cli/cliErrors';

/** Compiled tests live in out/test/**, fixtures stay in test/fixtures. */
const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures');

export function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

export function ok<T>(command: CliCommandId, value: T): CliOutcome<T> {
  return { ok: true, value, meta: { command, exitCode: 0, durationMs: 1 } };
}

export function fail<T>(command: CliCommandId, kind: CliErrorKind): CliOutcome<T> {
  return { ok: false, error: cliError(kind, { command }), meta: { command } };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
