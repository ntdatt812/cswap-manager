import type { ExecutableResolutionFailure } from './executableResolver';
import type { ProcessFailureKind } from './processRunner';

export type ReadOnlyCommandId = 'version' | 'list' | 'status';
export type CliCommandId = ReadOnlyCommandId | 'switch' | 'manage' | 'auto' | 'config' | 'priority' | 'map' | 'transfer';

export type CliErrorKind =
  | 'executable-not-found'
  | 'invalid-executable-setting'
  | 'unsupported-executable'
  | 'permission-denied'
  | 'spawn-failed'
  | 'timeout'
  | 'cancelled'
  | 'output-limit'
  | 'non-zero-exit'
  | 'invalid-output'
  | 'unexpected-shape'
  | 'unexpected-error'
  | 'cli-reported-error'
  | 'invalid-request';

/**
 * A CLI failure that is safe to show and log. `detail` is already redacted and truncated; raw
 * stdout/stderr is never carried in an error.
 */
export interface CliError {
  readonly kind: CliErrorKind;
  readonly command?: CliCommandId;
  readonly message: string;
  readonly exitCode?: number | null;
  readonly detail?: string;
  /** Error class name from the CLI's JSON error envelope (e.g. AccountNotFoundError). */
  readonly cliErrorType?: string;
}

const MESSAGES: Record<CliErrorKind, string> = {
  'executable-not-found': 'The cswap executable was not found. Install cswap or set "cswapManager.cliPath".',
  'invalid-executable-setting': 'The configured cswap path is not a usable executable.',
  'unsupported-executable':
    'The cswap path points to a script shim (.cmd/.bat/.ps1) that cannot be run without a shell. Point the setting at cswap.exe.',
  'permission-denied': 'Permission was denied when starting cswap.',
  'spawn-failed': 'cswap could not be started.',
  timeout: 'cswap did not finish within the configured timeout.',
  cancelled: 'The cswap command was cancelled.',
  'output-limit': 'cswap produced more output than the configured limit.',
  'non-zero-exit': 'cswap exited with an error.',
  'invalid-output': 'cswap returned output that is not valid JSON.',
  'unexpected-shape': 'cswap returned JSON in an unexpected shape; this CLI version may be unsupported.',
  'unexpected-error': 'An unexpected error occurred while reading cswap data.',
  'cli-reported-error': 'cswap reported an error.',
  'invalid-request': 'The requested cswap operation is not valid.',
};

export function cliError(kind: CliErrorKind, extra: Omit<CliError, 'kind' | 'message'> = {}): CliError {
  return { kind, message: MESSAGES[kind], ...extra };
}

export function errorKindForProcessFailure(failure: ProcessFailureKind): CliErrorKind {
  switch (failure) {
    case 'not-found':
      return 'executable-not-found';
    case 'permission-denied':
      return 'permission-denied';
    case 'unsupported-executable':
      return 'unsupported-executable';
    case 'spawn-failed':
      return 'spawn-failed';
    case 'timeout':
      return 'timeout';
    case 'cancelled':
      return 'cancelled';
    case 'output-limit':
      return 'output-limit';
  }
}

export function errorKindForResolution(reason: ExecutableResolutionFailure): CliErrorKind {
  switch (reason) {
    case 'not-found':
      return 'executable-not-found';
    case 'unsupported-shim':
      return 'unsupported-executable';
    case 'setting-not-absolute':
    case 'setting-not-found':
    case 'setting-not-a-file':
      return 'invalid-executable-setting';
  }
}
