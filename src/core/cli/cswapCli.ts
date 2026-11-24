import { isValidSlot, parseThreshold } from '../model/accountPolicy';
import { parsePriority, parsePriorityList, type PriorityEntry } from '../model/priorities';
import { parseMappingList, type MappingEntry } from '../model/mappings';
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
import {
  exportArgs,
  importArgs,
  importUsageArgs,
  isSafePathArgument,
  parseExportOutput,
  parseImportOutput,
  parseImportUsageOutput,
  type ExportResult,
  type ImportResult,
  type UsageImportResult,
} from './transfer';
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
  | { readonly kind: 'setDisabled'; readonly slot: number; readonly disabled: boolean }
  | { readonly kind: 'setThreshold'; readonly slot: number; readonly threshold: number }
  | { readonly kind: 'clearThreshold'; readonly slot: number }
  | { readonly kind: 'setPriority'; readonly slot: number; readonly priority: number }
  | { readonly kind: 'clearPriority'; readonly slot: number }
  | { readonly kind: 'remove'; readonly slot: number }
  | { readonly kind: 'move'; readonly slot: number; readonly targetSlot: number };

/** What `cswap add` reported (cswap 1.2.0 has no JSON for it; texts verified in switcher.py). */
export type AddResult =
  | { readonly kind: 'added' | 'updated' | 'moved'; readonly slot: number }
  | { readonly kind: 'cancelled' };

export function parseAddOutput(stdout: string): ParseResult<AddResult> {
  // A move prints "Moved from slot X → N" and then "Added Account N", so it is checked first.
  const moved = /Moved from slot \d+ \S+ (\d+)/.exec(stdout);
  if (moved !== null) {
    return { ok: true, value: { kind: 'moved', slot: Number(moved[1]) } };
  }
  // `add` refreshes "credentials"; `add-token` refreshes a "token" or an "API key".
  const updated = /Updated (?:credentials|token|API key) for Account (\d+)/.exec(stdout);
  if (updated !== null) {
    return { ok: true, value: { kind: 'updated', slot: Number(updated[1]) } };
  }
  const added = /Added Account (\d+)/.exec(stdout);
  if (added !== null) {
    return { ok: true, value: { kind: 'added', slot: Number(added[1]) } };
  }
  // The overwrite prompt has no trailing newline, so "Cancelled" can follow it on the same line.
  if (/\bCancelled\b/.test(stdout)) {
    return { ok: true, value: { kind: 'cancelled' } };
  }
  return { ok: false, reason: 'unexpected-shape', message: 'cswap add did not report a result.' };
}

/** `cswap remove` prints this on success; a prompt that was not confirmed prints "Cancelled". */
export function parseRemoveOutput(stdout: string): ParseResult<void> {
  return /Removed Account-\d+/.test(stdout)
    ? { ok: true, value: undefined }
    : { ok: false, reason: 'unexpected-shape', message: 'cswap did not confirm the removal.' };
}

/**
 * `cswap add` arguments from validated values only. A slot is passed only when the caller checked it
 * is free: an occupied slot would make cswap prompt to overwrite another account.
 */
export function addArgs(options: { readonly slot?: number }): readonly string[] | undefined {
  if (options.slot === undefined) {
    return ['add'];
  }
  return isValidSlot(options.slot) ? ['add', '--slot', String(options.slot)] : undefined;
}

export type TokenKind = 'setup-token' | 'api-key';

/** OAuth prefixes from cswap's `credentials._OAUTH_TOKEN_PREFIXES`; any other `sk-ant-` value is an API key. */
const OAUTH_TOKEN_PREFIXES = ['sk-ant-oat', 'sk-ant-ort'];
const TOKEN_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
/** cswap's own `_validate_email`, minus a leading `-` (it would read as a flag). */
const TOKEN_EMAIL_PATTERN = /^[a-zA-Z0-9._%+][a-zA-Z0-9._%+-]*@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * What a pasted value is, split the way cswap splits it (`credentials.looks_like_api_key`), or
 * undefined when it is not one token on one line. Only the shape is checked, never the value.
 */
export function tokenKind(token: string): TokenKind | undefined {
  const text = token.trim();
  if (!TOKEN_PATTERN.test(text)) {
    return undefined;
  }
  return OAUTH_TOKEN_PREFIXES.some((prefix) => text.startsWith(prefix)) ? 'setup-token' : 'api-key';
}

export function isValidTokenEmail(email: string): boolean {
  return TOKEN_EMAIL_PATTERN.test(email);
}

/**
 * `cswap add-token -` arguments. The token itself is never an argument (process lists show those):
 * `-` makes cswap read it from stdin. A slot is passed only when the caller checked it is free.
 */
export function addTokenArgs(options: { readonly slot?: number; readonly email?: string }): readonly string[] | undefined {
  const args = ['add-token', '-'];
  if (options.slot !== undefined) {
    if (!isValidSlot(options.slot)) {
      return undefined;
    }
    args.push('--slot', String(options.slot));
  }
  if (options.email !== undefined) {
    if (!isValidTokenEmail(options.email)) {
      return undefined;
    }
    args.push('--email', options.email);
  }
  return args;
}

/**
 * Builds arguments only from validated values (positive integer slots, a threshold inside 50–99.9, a
 * priority inside 0–1000), so no argument can ever be read as a flag.
 */
export function manageArgs(operation: ManageOperation): readonly string[] | undefined {
  if (!isValidSlot(operation.slot)) {
    return undefined;
  }
  const slot = String(operation.slot);
  switch (operation.kind) {
    case 'setDisabled':
      return [operation.disabled ? 'disable' : 'enable', slot];
    case 'setThreshold': {
      const threshold = parseThreshold(String(operation.threshold));
      return threshold.ok ? ['threshold', slot, String(threshold.value)] : undefined;
    }
    case 'clearThreshold':
      return ['threshold', slot, '--unset'];
    case 'setPriority': {
      const priority = parsePriority(String(operation.priority));
      return priority === undefined ? undefined : ['priority', slot, String(priority)];
    }
    case 'clearPriority':
      return ['priority', slot, '--unset'];
    case 'remove':
      return ['remove', slot];
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

/** `stderr` is for commands that report only there (export/import); it is never logged raw. */
type OutputParser<T> = (stdout: string, exitCode: number | null, stderr: string) => ParseResult<T>;

/** For commands whose success is the exit code: their human text is not read. */
const IGNORE_OUTPUT: OutputParser<void> = () => ({ ok: true, value: undefined });

/** For commands that report on stderr only (export/import). */
function fromStderr<T>(parse: (stderr: string) => ParseResult<T>): OutputParser<T> {
  return (_stdout, _exitCode, stderr) => parse(stderr);
}

/** A text parser's result, or `unexpected-shape` when the output was not recognised. */
function recognised<T>(value: T | undefined, command: string): ParseResult<T> {
  return value === undefined ? { ok: false, reason: 'unexpected-shape', message: `${command} output was not recognised.` } : { ok: true, value };
}

interface ExecuteOptions {
  readonly signal?: AbortSignal;
  readonly mutating?: boolean;
  /** Non-zero exit codes that are normal outcomes (e.g. `auto --once`: 1 error, 2 no action, 3 blocked). */
  readonly acceptExitCodes?: readonly number[];
  /** Lower bound for the timeout (a real auto-switch tick may legitimately take long). */
  readonly minTimeoutMs?: number;
  /** Answer for a CLI prompt, written to stdin (see ProcessRunOptions.input). */
  readonly input?: string;
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
    return this.mutate('switch', switchArgs(target), parseSwitchOutput);
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
    return this.mutate('config', autoSwitchRuleArgs(rule), IGNORE_OUTPUT);
  }

  /** `cswap config unset <key>`: back to cswap's default for an allow-listed rule. */
  resetAutoSwitchRule(key: AutoSwitchRuleKey): Promise<CliOutcome<void>> {
    return this.mutate('config', (AUTO_SWITCH_RULE_KEYS as readonly string[]).includes(key) ? ['config', 'unset', key] : undefined, IGNORE_OUTPUT);
  }

  /** `cswap priority` (text only; no JSON exists in cswap 1.2.0). */
  priorities(): Promise<CliOutcome<PriorityEntry[]>> {
    return this.execute('priority', ['priority'], (stdout) => recognised(parsePriorityList(stdout), 'cswap priority'), {});
  }

  /**
   * Runs an account-policy command. These commands print human text only, so success is the exit
   * code; callers verify the effect with a fresh `list --json`.
   */
  manage(operation: ManageOperation): Promise<CliOutcome<void>> {
    const args = manageArgs(operation);
    // cswap always asks "[y/N]" before removing and has no flag to skip it; the user already confirmed in VS Code.
    return operation.kind === 'remove' ? this.mutate('manage', args, parseRemoveOutput, 'y\n') : this.mutate('manage', args, IGNORE_OUTPUT);
  }

  /** `cswap map` (list; text only). */
  mappings(): Promise<CliOutcome<MappingEntry[]>> {
    return this.execute('map', ['map'], (stdout) => recognised(parseMappingList(stdout), 'cswap map'), {});
  }

  /** `cswap map <slot> <folder>` / `cswap unmap <folder>`: which account a bare `cswap run` uses there. */
  setMapping(folder: string, slot: number | undefined): Promise<CliOutcome<void>> {
    const valid = isSafePathArgument(folder) && (slot === undefined || isValidSlot(slot));
    return this.mutate('map', !valid ? undefined : slot === undefined ? ['unmap', folder] : ['map', String(slot), folder], IGNORE_OUTPUT);
  }

  /** `cswap add`: stores the current Claude Code login (or refreshes it when already managed). */
  addAccount(options: { readonly slot?: number }): Promise<CliOutcome<AddResult>> {
    return this.mutate('manage', addArgs(options), parseAddOutput);
  }

  /**
   * `cswap add-token -`: registers a setup-token or API key. The token goes to cswap on stdin only;
   * it is never an argument, never logged, and cswap's output is redacted like every other command.
   */
  addToken(token: string, options: { readonly slot?: number; readonly email?: string }): Promise<CliOutcome<AddResult>> {
    const args = tokenKind(token) === undefined ? undefined : addTokenArgs(options);
    return this.mutate('manage', args, parseAddOutput, `${token.trim()}\n`);
  }

  /** `cswap export <file> [--account N]`: cswap writes the file (owner-only); the extension never reads it. */
  exportAccounts(path: string, slot?: number): Promise<CliOutcome<ExportResult>> {
    return this.mutate('transfer', exportArgs(path, slot), fromStderr(parseExportOutput));
  }

  /** `cswap import <file> [--force]`. */
  importAccounts(path: string, replaceExisting: boolean): Promise<CliOutcome<ImportResult>> {
    return this.mutate('transfer', importArgs(path, replaceExisting), fromStderr(parseImportOutput));
  }

  /** `cswap import-usage <file> [--hold S]`: adopts another machine's `list --json` readings. */
  importUsage(path: string, holdSeconds?: number): Promise<CliOutcome<UsageImportResult>> {
    return this.mutate('transfer', importUsageArgs(path, holdSeconds), fromStderr(parseImportUsageOutput));
  }

  /**
   * This machine's `list --json` exactly as cswap printed it, for `import-usage` on another machine
   * (usage, emails and slots; no logins). Checked to be a list document before it is handed out.
   */
  usageDocument(): Promise<CliOutcome<string>> {
    return this.execute('list', COMMAND_ARGS.list, (stdout) => {
      const parsed = parseListOutput(stdout);
      return parsed.ok ? { ok: true, value: stdout } : parsed;
    }, {});
  }

  /**
   * A state-changing command built from validated values only: `args` is undefined when a value was
   * refused, and then nothing reaches cswap. Not cancellable once started.
   */
  private mutate<T>(command: CliCommandId, args: readonly string[] | undefined, parse: OutputParser<T>, input?: string): Promise<CliOutcome<T>> {
    if (args === undefined) {
      return Promise.resolve(this.fail({ command }, cliError('invalid-request', { command })));
    }
    return this.execute(command, args, parse, { mutating: true, ...(input === undefined ? {} : { input }) });
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
      ...(options.input === undefined ? {} : { input: options.input }),
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
    const parsed = parse(result.stdout, result.exitCode, result.stderr);
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
