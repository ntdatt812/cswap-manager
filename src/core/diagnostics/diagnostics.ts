import type { CliCommandId, CliErrorKind } from '../cli/cliErrors';
import { COMMAND_ARGS, type CliOutcome } from '../cli/cswapCli';
import type { ExecutableResolution, ExecutableResolutionFailure, ExecutableSource } from '../cli/executableResolver';
import { assessCompatibility, type CliVersion, type CompatibilityLevel } from '../cli/version';
import { buildSnapshot } from '../model/reconcile';
import type { ActiveConsistency, ListPayload, ParseWarning, StatusPayload } from '../model/types';
import { redactText } from '../security/redact';
import { assessFreshness, type AccountsState, type Freshness } from '../service/refreshService';

export interface DiagnosticsEnvironmentInfo {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly platform: string;
  readonly osRelease: string;
  readonly arch: string;
  readonly nodeVersion: string;
}

export interface DiagnosticsSettings {
  readonly cliPathSetting: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface DiagnosticsCli {
  version(): Promise<CliOutcome<CliVersion>>;
  list(): Promise<CliOutcome<ListPayload>>;
  status(): Promise<CliOutcome<StatusPayload>>;
}

export interface DiagnosticsDependencies {
  readonly environment: DiagnosticsEnvironmentInfo;
  readonly settings: DiagnosticsSettings;
  readonly homeDir: string;
  readonly resolveExecutable: () => Promise<ExecutableResolution>;
  readonly cli: DiagnosticsCli;
  readonly refreshState?: () => AccountsState;
  readonly now: () => number;
}

export interface CommandCheck {
  readonly command: CliCommandId;
  readonly args: string;
  readonly ok: boolean;
  readonly errorKind?: CliErrorKind;
  readonly errorDetail?: string;
  readonly exitCode?: number | null;
  readonly durationMs?: number;
  readonly stderrNotice?: string;
}

export interface DiagnosticsReport {
  readonly generatedAt: number;
  readonly environment: DiagnosticsEnvironmentInfo;
  readonly settings: {
    readonly cliPathConfigured: boolean;
    readonly cliPath?: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly executable: {
    readonly resolved: boolean;
    readonly path?: string;
    readonly source?: ExecutableSource;
    readonly failure?: ExecutableResolutionFailure;
  };
  readonly version: { readonly check: CommandCheck; readonly text?: string; readonly compatibility: CompatibilityLevel };
  readonly list: {
    readonly check: CommandCheck;
    readonly schemaVersion?: number;
    readonly accountCount?: number;
    readonly windowKeys: readonly string[];
    readonly scopedEntryCount: number;
    readonly warnings: readonly ParseWarning[];
  };
  readonly status: {
    readonly check: CommandCheck;
    readonly schemaVersion?: number;
    readonly reportsActive?: boolean;
    readonly activeManaged?: boolean;
    readonly totalManagedAccounts?: number;
    readonly warnings: readonly ParseWarning[];
  };
  readonly active?: {
    readonly consistency: ActiveConsistency;
    readonly slot?: number;
    readonly activeUnmanaged?: boolean;
  };
  readonly refresh?: {
    readonly freshness: Freshness;
    readonly lastSuccessAt?: number;
    readonly lastAttemptAt?: number;
    readonly lastErrorKind?: CliErrorKind;
  };
}

function toCheck<T>(outcome: CliOutcome<T>): CommandCheck {
  const { meta } = outcome;
  return {
    command: meta.command,
    args: meta.command === 'version' || meta.command === 'list' || meta.command === 'status' ? COMMAND_ARGS[meta.command].join(' ') : meta.command,
    ok: outcome.ok,
    ...(outcome.ok ? {} : { errorKind: outcome.error.kind }),
    ...(!outcome.ok && outcome.error.detail ? { errorDetail: outcome.error.detail } : {}),
    ...(meta.exitCode === undefined ? {} : { exitCode: meta.exitCode }),
    ...(meta.durationMs === undefined ? {} : { durationMs: meta.durationMs }),
    ...(meta.stderrNotice === undefined ? {} : { stderrNotice: meta.stderrNotice }),
  };
}

function summarizeList(payload: ListPayload): { windowKeys: string[]; scopedEntryCount: number } {
  const windowKeys = new Set<string>();
  let scopedEntryCount = 0;
  for (const account of payload.accounts) {
    account.usage?.windows.forEach((window) => windowKeys.add(window.key));
    scopedEntryCount += account.usage?.scoped.length ?? 0;
  }
  return { windowKeys: [...windowKeys], scopedEntryCount };
}

/**
 * Runs only the read-only probes (`--version`, `list --json`, `status --json`) sequentially and
 * keeps structural facts: counts, keys, codes, timings. Emails, UUIDs and raw output are dropped.
 */
export async function collectDiagnostics(deps: DiagnosticsDependencies): Promise<DiagnosticsReport> {
  const redaction = { homeDir: deps.homeDir };
  const resolution = await deps.resolveExecutable();
  const versionOutcome = await deps.cli.version();
  const listOutcome = await deps.cli.list();
  const statusOutcome = await deps.cli.status();

  const listSummary = listOutcome.ok ? summarizeList(listOutcome.value) : { windowKeys: [], scopedEntryCount: 0 };
  const snapshot = listOutcome.ok ? buildSnapshot(listOutcome.value, statusOutcome.ok ? statusOutcome.value : undefined, deps.now()) : undefined;
  const state = deps.refreshState?.();
  const freshness = state === undefined ? undefined : assessFreshness(state, deps.now());
  const cliPathSetting = deps.settings.cliPathSetting.trim();

  return {
    generatedAt: deps.now(),
    environment: deps.environment,
    settings: {
      cliPathConfigured: cliPathSetting.length > 0,
      ...(cliPathSetting.length > 0 ? { cliPath: redactText(cliPathSetting, redaction) } : {}),
      timeoutMs: deps.settings.timeoutMs,
      maxOutputBytes: deps.settings.maxOutputBytes,
    },
    executable: resolution.ok
      ? { resolved: true, path: redactText(resolution.path, redaction), source: resolution.source }
      : { resolved: false, failure: resolution.reason, ...(resolution.path ? { path: redactText(resolution.path, redaction) } : {}) },
    version: {
      check: toCheck(versionOutcome),
      ...(versionOutcome.ok ? { text: versionOutcome.value.text } : {}),
      compatibility: assessCompatibility(versionOutcome.ok ? versionOutcome.value : undefined).level,
    },
    list: {
      check: toCheck(listOutcome),
      ...(listOutcome.ok && listOutcome.value.schemaVersion !== undefined ? { schemaVersion: listOutcome.value.schemaVersion } : {}),
      ...(listOutcome.ok ? { accountCount: listOutcome.value.accounts.length } : {}),
      ...listSummary,
      warnings: listOutcome.ok ? listOutcome.value.warnings : [],
    },
    status: {
      check: toCheck(statusOutcome),
      ...(statusOutcome.ok && statusOutcome.value.schemaVersion !== undefined ? { schemaVersion: statusOutcome.value.schemaVersion } : {}),
      ...(statusOutcome.ok ? { reportsActive: statusOutcome.value.active !== undefined } : {}),
      ...(statusOutcome.ok && statusOutcome.value.active?.managed !== undefined ? { activeManaged: statusOutcome.value.active.managed } : {}),
      ...(statusOutcome.ok && statusOutcome.value.totalManagedAccounts !== undefined
        ? { totalManagedAccounts: statusOutcome.value.totalManagedAccounts }
        : {}),
      warnings: statusOutcome.ok ? statusOutcome.value.warnings : [],
    },
    ...(snapshot === undefined
      ? {}
      : {
          active: {
            consistency: snapshot.active.consistency,
            ...(snapshot.active.slot === undefined ? {} : { slot: snapshot.active.slot }),
            ...(snapshot.active.activeUnmanaged === undefined ? {} : { activeUnmanaged: snapshot.active.activeUnmanaged }),
          },
        }),
    ...(state === undefined || freshness === undefined
      ? {}
      : {
          refresh: {
            freshness: freshness.freshness,
            ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
            ...(state.lastAttemptAt === undefined ? {} : { lastAttemptAt: state.lastAttemptAt }),
            ...(state.lastError === undefined ? {} : { lastErrorKind: state.lastError.kind }),
          },
        }),
  };
}

function iso(epoch: number | undefined): string {
  return epoch === undefined ? 'never' : new Date(epoch).toISOString();
}

function formatCheck(check: CommandCheck): string[] {
  const lines = [
    `- \`cswap ${check.args}\`: ${check.ok ? 'OK' : `FAILED (${check.errorKind ?? 'unknown'})`}`,
    `  - exit code: ${check.exitCode === undefined ? 'n/a' : String(check.exitCode)}; duration: ${check.durationMs === undefined ? 'n/a' : `${check.durationMs} ms`}`,
  ];
  if (check.errorDetail) {
    lines.push(`  - error detail (redacted): ${check.errorDetail}`);
  }
  if (check.stderrNotice) {
    lines.push(`  - CLI notice (redacted): ${check.stderrNotice}`);
  }
  return lines;
}

function formatWarnings(warnings: readonly ParseWarning[]): string {
  if (warnings.length === 0) {
    return 'none';
  }
  const shown = warnings.slice(0, 20).map((warning) => `${warning.code} at ${warning.path}`);
  const more = warnings.length > shown.length ? ` (+${warnings.length - shown.length} more)` : '';
  return `${shown.join('; ')}${more}`;
}

/** Renders a copy-safe Markdown report. The whole text is redacted again as defence in depth. */
export function formatDiagnosticsReport(report: DiagnosticsReport, homeDir: string): string {
  const { environment: env, settings, executable, version, list, status } = report;
  const lines: string[] = [
    '# Cswap Manager diagnostics',
    '',
    `Generated: ${iso(report.generatedAt)}`,
    '',
    '## Environment',
    `- Extension: ${env.extensionVersion}`,
    `- VS Code: ${env.vscodeVersion}`,
    `- OS: ${env.platform} ${env.osRelease} (${env.arch})`,
    `- Extension host Node.js: ${env.nodeVersion}`,
    '',
    '## Settings',
    `- cliPath: ${settings.cliPathConfigured ? (settings.cliPath ?? '') : '(not set — auto-detect)'}`,
    `- command timeout: ${settings.timeoutMs} ms`,
    `- max output: ${settings.maxOutputBytes} bytes`,
    '',
    '## CLI executable',
    executable.resolved
      ? `- Resolved: ${executable.path ?? ''} (via ${executable.source ?? 'unknown'})`
      : `- Not resolved: ${executable.failure ?? 'unknown'}${executable.path ? ` (${executable.path})` : ''}`,
    `- Version: ${version.text ?? 'unknown'}; compatibility: ${version.compatibility}`,
    '',
    '## Commands (read-only probes)',
    ...formatCheck(version.check),
    ...formatCheck(list.check),
    ...formatCheck(status.check),
    '',
    '## Parsed data (no personal data included)',
    `- list: schemaVersion ${list.schemaVersion ?? 'unknown'}; accounts: ${list.accountCount ?? 'n/a'}; usage windows: ${list.windowKeys.length > 0 ? list.windowKeys.join(', ') : 'none'}; scoped entries: ${list.scopedEntryCount}`,
    `- list warnings: ${formatWarnings(list.warnings)}`,
    `- status: schemaVersion ${status.schemaVersion ?? 'unknown'}; reports active: ${status.reportsActive === undefined ? 'n/a' : String(status.reportsActive)}; active managed: ${status.activeManaged === undefined ? 'unknown' : String(status.activeManaged)}; total managed: ${status.totalManagedAccounts ?? 'unknown'}`,
    `- status warnings: ${formatWarnings(status.warnings)}`,
  ];
  if (report.active) {
    lines.push(
      `- active account: slot ${report.active.slot ?? 'unknown'}; consistency between list and status: ${report.active.consistency}${report.active.activeUnmanaged ? '; active login is not managed by cswap' : ''}`,
    );
  }
  if (report.refresh) {
    lines.push(
      '',
      '## Extension refresh state',
      `- freshness: ${report.refresh.freshness}`,
      `- last success: ${iso(report.refresh.lastSuccessAt)}; last attempt: ${iso(report.refresh.lastAttemptAt)}`,
      `- last error: ${report.refresh.lastErrorKind ?? 'none'}`,
    );
  }
  lines.push('');
  return redactText(lines.join('\n'), { homeDir });
}
