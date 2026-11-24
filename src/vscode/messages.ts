import { localize } from './l10n';
import type { CliError } from '../core/cli/cliErrors';

/** Localizable user-facing text for CLI errors. */
export function describeCliError(error: CliError): string {
  switch (error.kind) {
    case 'executable-not-found':
      return localize('cswap was not found. Install cswap or set "cswapManager.cliPath" in your user settings.');
    case 'invalid-executable-setting':
      return localize('The configured "cswapManager.cliPath" is not an absolute path to an existing executable.');
    case 'unsupported-executable':
      return localize('The cswap path points to a .cmd/.bat/.ps1 shim, which cannot be run safely without a shell. Point "cswapManager.cliPath" at cswap.exe.');
    case 'permission-denied':
      return localize('Permission denied when starting cswap.');
    case 'spawn-failed':
      return localize('cswap could not be started.');
    case 'timeout':
      return localize('cswap did not respond within the configured timeout.');
    case 'cancelled':
      return localize('The cswap command was cancelled.');
    case 'output-limit':
      return localize('cswap produced more output than the configured limit.');
    case 'non-zero-exit':
      return localize('cswap exited with an error (code {0}).', String(error.exitCode ?? 'unknown'));
    case 'invalid-output':
      return localize('cswap returned output that could not be read as JSON.');
    case 'unexpected-shape':
      return localize('cswap returned data in an unexpected format. This cswap version may not be supported.');
    case 'unexpected-error':
      return localize('An unexpected error occurred while reading cswap data.');
    case 'cli-reported-error':
      return error.cliErrorType
        ? localize('cswap reported an error ({0}).', error.cliErrorType)
        : localize('cswap reported an error.');
    case 'invalid-request':
      return localize('The requested cswap operation is not valid.');
  }
}

/** Reasons cswap gives for `switched: false` (from the CLI source); unknown ones are shown as-is. */
export function describeNoSwitchReason(reason: string | undefined): string {
  switch (reason) {
    case 'already-active':
      return localize('That account is already active.');
    case 'already-best':
      return localize('cswap: the active account already has the most headroom.');
    case 'candidates-exhausted':
      return localize('cswap: no other account has quota available.');
    case 'only-one-account':
      return localize('cswap manages only one account.');
    case 'usage-unavailable':
      return localize('cswap could not read usage to choose an account.');
    case 'unmanaged-account':
      return localize('The current Claude login is not managed by cswap; add it with `cswap add` first.');
    case 'no-valid-target':
      return localize('cswap found no account to switch to.');
    default:
      // Unknown reasons are shown only when they look like cswap's kebab-case reason codes.
      return localize(
        'cswap did not switch ({0}).',
        reason !== undefined && /^[a-z0-9-]{1,64}$/.test(reason) ? reason : localize('unknown reason'),
      );
  }
}
