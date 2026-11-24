import { isValidSlot, normalizeAlias, parseThreshold } from '../model/accountPolicy';
import { buildTickResult, parseAutoSwitchRules, type AutoSwitchRules, type AutoTickResult } from '../model/autoSwitch';
import { AUTO_SWITCH_RULE_KEYS, autoSwitchRuleArgs, type AutoSwitchRuleKey, type AutoSwitchRuleUpdate } from './autoSwitchRules';
import { parseErrorEnvelope, parseListOutput, parseStatusOutput, parseSwitchOutput, type ParseResult } from '../model/parsers';
import type { ListPayload, StatusPayload, SwitchResult } from '../model/types';
import { redactLine, redactText } from '../security/redact';
import {
  cliError,
  errorKindForProcessFailure,
  errorKindForResolution,
  type CliCommandId,
  type CliError,
  type ReadOnlyCommandId,
} from './cliErrors';
import type { ExecutableResolution, ExecutableSource } from './executableResolver';
import type { ProcessRunner } from './processRunner';
import { parseCliVersion, type CliVersion } from './version';

/**
 * Argument vectors for read-only commands. They are constants: no user- or CLI-supplied value is
 * ever interpolated into a command line.
 */
export const COMMAND_ARGS: Readonly<Record<ReadOnlyCommandId, readonly string[]>> = {
  version: ['--version'],
  list: ['list', '--json'],
  status: ['status', '--json'],
};

export const SWITCH_STRATEGIES = ['best', 'next-available'] as const;
export type SwitchStrategy = (typeof SWITCH_STRATEGIES)[number];

export type SwitchTarget =
  | { readonly kind: 'slot'; readonly slot: number }
  | { readonly kind: 'strategy'; readonly strategy: SwitchStrategy };

/**
 * Builds `switch` arguments only from a validated slot number or a known strategy name. Emails and
 * aliases are never passed, and `--force` is never added.
 */
export function switchArgs(target: SwitchTarget): readonly string[] | undefined {
  if (target.kind === 'slot') {
    return Number.isSafeInteger(target.slot) && target.slot >= 0 ? ['switch', String(target.slot), '--json'] : undefined;
  }
  return (SWITCH_STRATEGIES as readonly string[]).includes(target.strategy)
    ? ['switch', '--strategy', target.strategy, '--json']
    : undefined;
}

/** Account-policy operations verified against cswap 1.1.0 (see docs/CLI-CONTRACT.md, Phase 5). */
export type ManageOperation =
  | { readonly kind: 'setAlias'; readonly slot: number; readonly alias: string }
  | { readonly kind: 'removeAlias'; readonly slot: number }
  | { readonly kind: 'setDisabled'; readonly slot: number; readonly disabled: boolean }
  | { readonly kind: 'setThreshold'; readonly slot: number; readonly threshold: number }
  | { readonly kind: 'clearThreshold'; readonly slot: number }
  | { readonly kind: 'move'; readonly slot: number; readonly targetSlot: number };

/**
 * Builds arguments only from validated values: positive integer slots, an alias that passed the
 * CLI's own rules (so it can never start with `-`), and a threshold inside 50–99.9.
 */
export function manageArgs(operation: ManageOperation): readonly string[] | undefined {
  if (!isValidSlot(operation.slot)) {
    return undefined;
  }
  const slot = String(operation.slot);
  switch (operation.kind) {
    case 'setAlias': {
      const alias = normalizeAlias(operation.alias);
      return alias.ok ? ['alias', slot, alias.value] : undefined;
    }
    case 'removeAlias':
      return ['alias', slot, '--unset'];
    case 'setDisabled':
      return [operation.disabled ? 'disable' : 'enable', slot];
    case 'setThreshold': {
      const threshold = parseThreshold(String(operation.threshold));
      return threshold.ok ? ['threshold', slot, String(threshold.value)] : undefined;
    }
    case 'clearThreshold':
      return ['threshold', slot, '--unset'];
    case 'move':
      return isValidSlot(operation.targetSlot) ? ['move', slot, String(operation.targetSlot)] : undefined;
  }
}

/**
 * A switch rewrites Claude Code credentials. Killing it half-way could leave them inconsistent, so
 * it gets a generous minimum timeout and is never cancelled from the UI.
 */
export const MUTATION_MIN_TIMEOUT_MS = 120_000;

/** Safety timeout for an unattended real auto-switch tick. */
export const AUTO_TICK_MIN_TIMEOUT_MS = 600_000;

export interface CliRunSettings {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface CommandMeta {
  readonly command: CliCommandId;
  readonly executablePath?: string;
  readonly executableSource?: ExecutableSource;
  readonly durationMs?: number;
  readonly exitCode?: number | null;
  /** First stderr line of a successful run, redacted (e.g. the CLI's "newer version" notice). */
  readonly stderrNotice?: string;
}

export type CliOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly meta: CommandMeta }
  | { readonly ok: false; readonly error: CliError; readonly meta: CommandMeta };

export interface CswapCliDependencies {
  readonly runner: ProcessRunner;
  readonly resolveExecutable: () => Promise<ExecutableResolution>;
  /** Called when the resolved executable disappeared, so a cached resolution can be dropped. */
  readonly onExecutableMissing?: () => void;
  readonly settings: () => CliRunSettings;
  /** A fixed, non-workspace directory so the CLI never runs inside an untrusted folder. */
  readonly workingDirectory: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  /** Used only to redact paths in error details. */
  readonly homeDir: string;
  readonly onCommandFinished?: (meta: CommandMeta, error?: CliError) => void;
}

/**
 * Environment hints for clean machine output: `NO_COLOR` disables ANSI colours by convention and
 * `PYTHONIOENCODING` makes the Python-based CLI write UTF-8 to pipes on Windows. Both are inert
 * for programs that ignore them.
 */
export function cliEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The extension host runs with ELECTRON_RUN_AS_NODE set; it is meaningless to cswap, so drop it.
  const { ELECTRON_RUN_AS_NODE, ...rest } = base;
  return { ...rest, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' };
}

/** Only a plausible exception class name from the CLI's error envelope is kept for display. */
const ERROR_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

type OutputParser<T> = (stdout: string, exitCode: number | null) => ParseResult<T>;

interface ExecuteOptions {
  readonly signal?: AbortSignal;
  readonly mutating?: boolean;
  /** Non-zero exit codes that are normal outcomes (e.g. `auto --once`: 1 error, 2 no action, 3 blocked). */
  readonly acceptExitCodes?: readonly number[];
  /** Lower bound for the timeout (a real auto-switch tick may legitimately take long). */
  readonly minTimeoutMs?: number;
}

function parseVersionOutput(stdout: string): ParseResult<CliVersion> {
  const version = parseCliVersion(stdout);
  return version === undefined
    ? { ok: false, reason: 'invalid-json', message: 'Unrecognized version output.' }
    : { ok: true, value: version };
}

/** Adapter over the `cswap` CLI. Every method resolves; none throws. */
export class CswapCli {
  constructor(private readonly deps: CswapCliDependencies) {}

  version(signal?: AbortSignal): Promise<CliOutcome<CliVersion>> {
    return this.execute('version', COMMAND_ARGS.version, parseVersionOutput, { ...(signal ? { signal } : {}) });
  }

  list(signal?: AbortSignal): Promise<CliOutcome<ListPayload>> {
    return this.execute('list', COMMAND_ARGS.list, parseListOutput, { ...(signal ? { signal } : {}) });
  }

  status(signal?: AbortSignal): Promise<CliOutcome<StatusPayload>> {
    return this.execute('status', COMMAND_ARGS.status, parseStatusOutput, { ...(signal ? { signal } : {}) });
  }

  /** Switches the active Claude Code account. Not cancellable once started. */
  switch(target: SwitchTarget): Promise<CliOutcome<SwitchResult>> {
    const args = switchArgs(target);
    if (args === undefined) {
      return Promise.resolve(this.fail({ command: 'switch' }, cliError('invalid-request', { command: 'switch' })));
    }
    return this.execute('switch', args, parseSwitchOutput, { mutating: true });
  }

  /**
   * One auto-switch evaluation (`cswap auto --once --json`). A dry run never switches or writes
   * state and is treated as read-only; a real tick may switch, so it is not cancellable.
   */
  autoTick(options: { readonly dryRun: boolean }): Promise<CliOutcome<AutoTickResult>> {
    const args = options.dryRun ? ['auto', '--once', '--json', '--dry-run'] : ['auto', '--once', '--json'];
    return this.execute('auto', args, (stdout, exitCode) => ({ ok: true, value: buildTickResult(stdout, exitCode, options.dryRun) }), {
      mutating: !options.dryRun,
      // A real tick may switch credentials: only a long safety timeout may stop it.
      ...(options.dryRun ? {} : { minTimeoutMs: AUTO_TICK_MIN_TIMEOUT_MS }),
      acceptExitCodes: [1, 2, 3],
    });
  }

  /** Reads the `autoswitch.*` settings (`cswap config --json list`). */
  readAutoSwitchRules(signal?: AbortSignal): Promise<CliOutcome<AutoSwitchRules>> {
    return this.execute(
      'config',
      ['config', '--json', 'list'],
      (stdout) => {
        const rules = parseAutoSwitchRules(stdout);
        return rules === undefined ? { ok: false, reason: 'unexpected-shape', message: 'Unrecognized config output.' } : { ok: true, value: rules };
      },
      { ...(signal ? { signal } : {}) },
    );
  }

  /** `cswap config set <key> <value>` for an allow-listed auto-switch rule with a validated value. */
  setAutoSwitchRule(rule: AutoSwitchRuleUpdate): Promise<CliOutcome<void>> {
    const args = autoSwitchRuleArgs(rule);
    if (args === undefined) {
      return Promise.resolve(this.fail({ command: 'config' }, cliError('invalid-request', { command: 'config' })));
    }
    return this.execute('config', args, () => ({ ok: true, value: undefined }), { mutating: true });
  }

  /** `cswap config unset <key>`: back to cswap's default for an allow-listed rule. */
  resetAutoSwitchRule(key: AutoSwitchRuleKey): Promise<CliOutcome<void>> {
    if (!(AUTO_SWITCH_RULE_KEYS as readonly string[]).includes(key)) {
      return Promise.resolve(this.fail({ command: 'config' }, cliError('invalid-request', { command: 'config' })));
    }
    return this.execute('config', ['config', 'unset', key], () => ({ ok: true, value: undefined }), { mutating: true });
  }

  /**
   * Runs an account-policy command. These commands print human text only, so success is the exit
   * code; callers verify the effect with a fresh `list --json`.
   */
  manage(operation: ManageOperation): Promise<CliOutcome<void>> {
    const args = manageArgs(operation);
    if (args === undefined) {
      return Promise.resolve(this.fail({ command: 'manage' }, cliError('invalid-request', { command: 'manage' })));
    }
    return this.execute('manage', args, () => ({ ok: true, value: undefined }), { mutating: true });
  }

  private async execute<T>(
    command: CliCommandId,
    args: readonly string[],
    parse: OutputParser<T>,
    options: ExecuteOptions,
  ): Promise<CliOutcome<T>> {
    const resolution = await this.deps.resolveExecutable();
    if (!resolution.ok) {
      return this.fail({ command }, cliError(errorKindForResolution(resolution.reason), { command }));
    }

    const settings = this.deps.settings();
    const result = await this.deps.runner.run(resolution.path, args, {
      timeoutMs: Math.max(settings.timeoutMs, options.minTimeoutMs ?? (options.mutating ? MUTATION_MIN_TIMEOUT_MS : 0)),
      maxOutputBytes: settings.maxOutputBytes,
      cwd: this.deps.workingDirectory,
      env: cliEnvironment(this.deps.baseEnv),
      ...(options.signal === undefined || options.mutating ? {} : { signal: options.signal }),
    });

    const baseMeta: CommandMeta = {
      command,
      executablePath: resolution.path,
      executableSource: resolution.source,
      durationMs: result.durationMs,
    };
    const redaction = { homeDir: this.deps.homeDir };

    if (result.kind === 'failed') {
      if (result.failure === 'not-found') {
        this.deps.onExecutableMissing?.();
      }
      const detail = redactLine(result.stderr, 'last', redaction);
      return this.fail(baseMeta, cliError(errorKindForProcessFailure(result.failure), { command, ...(detail ? { detail } : {}) }));
    }

    const meta: CommandMeta = { ...baseMeta, exitCode: result.exitCode };
    const accepted = result.exitCode !== null && (options.acceptExitCodes ?? []).includes(result.exitCode);
    if (result.exitCode !== 0 && !accepted) {
      const envelope = parseErrorEnvelope(result.stdout);
      if (envelope !== undefined) {
        const text = [envelope.type, envelope.message].filter((part): part is string => part !== undefined).join(': ');
        return this.fail(
          meta,
          cliError('cli-reported-error', {
            command,
            exitCode: result.exitCode,
            ...(envelope.type && ERROR_TYPE_PATTERN.test(envelope.type) ? { cliErrorType: envelope.type } : {}),
            ...(text ? { detail: redactText(text, { ...redaction, maxLength: 200 }) } : {}),
          }),
        );
      }
      const detail = redactLine(result.stderr, 'last', redaction);
      return this.fail(meta, cliError('non-zero-exit', { command, exitCode: result.exitCode, ...(detail ? { detail } : {}) }));
    }

    const stderrNotice = redactLine(result.stderr, 'first', redaction);
    const successMeta: CommandMeta = stderrNotice ? { ...meta, stderrNotice } : meta;
    const parsed = parse(result.stdout, result.exitCode);
    if (!parsed.ok) {
      const kind = parsed.reason === 'invalid-json' ? 'invalid-output' : 'unexpected-shape';
      return this.fail(successMeta, cliError(kind, { command, exitCode: result.exitCode }));
    }
    this.deps.onCommandFinished?.(successMeta);
    return { ok: true, value: parsed.value, meta: successMeta };
  }

  private fail<T>(meta: CommandMeta, error: CliError): CliOutcome<T> {
    this.deps.onCommandFinished?.(meta, error);
    return { ok: false, error, meta };
  }
}
