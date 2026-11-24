import * as vscode from 'vscode';
import type { CliError } from '../core/cli/cliErrors';

/** Localizable user-facing text for CLI errors. */
export function describeCliError(error: CliError): string {
  switch (error.kind) {
    case 'executable-not-found':
      return vscode.l10n.t('cswap was not found. Install cswap or set "cswapManager.cliPath" in your user settings.');
    case 'invalid-executable-setting':
      return vscode.l10n.t('The configured "cswapManager.cliPath" is not an absolute path to an existing executable.');
    case 'unsupported-executable':
      return vscode.l10n.t('The cswap path points to a .cmd/.bat/.ps1 shim, which cannot be run safely without a shell. Point "cswapManager.cliPath" at cswap.exe.');
    case 'permission-denied':
      return vscode.l10n.t('Permission denied when starting cswap.');
    case 'spawn-failed':
      return vscode.l10n.t('cswap could not be started.');
    case 'timeout':
      return vscode.l10n.t('cswap did not respond within the configured timeout.');
    case 'cancelled':
      return vscode.l10n.t('The cswap command was cancelled.');
    case 'output-limit':
      return vscode.l10n.t('cswap produced more output than the configured limit.');
    case 'non-zero-exit':
      return vscode.l10n.t('cswap exited with an error (code {0}).', String(error.exitCode ?? 'unknown'));
    case 'invalid-output':
      return vscode.l10n.t('cswap returned output that could not be read as JSON.');
    case 'unexpected-shape':
      return vscode.l10n.t('cswap returned data in an unexpected format. This cswap version may not be supported.');
    case 'unexpected-error':
      return vscode.l10n.t('An unexpected error occurred while reading cswap data.');
    case 'cli-reported-error':
      return error.cliErrorType
        ? vscode.l10n.t('cswap reported an error ({0}).', error.cliErrorType)
        : vscode.l10n.t('cswap reported an error.');
    case 'invalid-request':
      return vscode.l10n.t('The requested cswap operation is not valid.');
  }
}

/** Reasons cswap gives for `switched: false` (from the CLI source); unknown ones are shown as-is. */
export function describeNoSwitchReason(reason: string | undefined): string {
  switch (reason) {
    case 'already-active':
      return vscode.l10n.t('That account is already active.');
    case 'already-best':
      return vscode.l10n.t('cswap: the active account already has the most headroom.');
    case 'candidates-exhausted':
      return vscode.l10n.t('cswap: no other account has quota available.');
    case 'only-one-account':
      return vscode.l10n.t('cswap manages only one account.');
    case 'usage-unavailable':
      return vscode.l10n.t('cswap could not read usage to choose an account.');
    case 'unmanaged-account':
      return vscode.l10n.t('The current Claude login is not managed by cswap; add it with `cswap add` first.');
    case 'no-valid-target':
      return vscode.l10n.t('cswap found no account to switch to.');
    default:
      // Unknown reasons are shown only when they look like cswap's kebab-case reason codes.
      return vscode.l10n.t(
        'cswap did not switch ({0}).',
        reason !== undefined && /^[a-z0-9-]{1,64}$/.test(reason) ? reason : vscode.l10n.t('unknown reason'),
      );
  }
}
