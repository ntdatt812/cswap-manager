import * as path from 'node:path';
import { isRecord } from '../model/json';
import { neutralizeLinks, redactLine } from '../security/redact';
import { cliEnvironment } from './cswapCli';
import { locateTool } from './cswapInstall';
import { readEnv, type ResolverEnvironment } from './executableResolver';
import type { ProcessResult } from './processRunner';
import { parseCliVersion, type CliVersion } from './version';

/** PyPI JSON API for the package cswap is published as (the same source cswap's own check uses). */
export const PYPI_URL = 'https://pypi.org/pypi/claude-swap/json';

/** Longest an upgrade may run before it is stopped. */
export const UPGRADE_TIMEOUT_MS = 5 * 60_000;
/** stdout cap for the upgrade; installers print a few lines, so reaching it means something is wrong. */
export const UPGRADE_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Reads `info.version` from the PyPI JSON; pre-releases are ignored, like cswap does for final releases. */
export function latestFromPypi(body: string): CliVersion | undefined {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return undefined;
  }
  const info = isRecord(root) ? root['info'] : undefined;
  const version = isRecord(info) ? info['version'] : undefined;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version.trim())) {
    return undefined;
  }
  return parseCliVersion(version);
}

export function isNewer(candidate: CliVersion, current: CliVersion): boolean {
  if (candidate.major !== current.major) {
    return candidate.major > current.major;
  }
  if (candidate.minor !== current.minor) {
    return candidate.minor > current.minor;
  }
  return candidate.patch > current.patch;
}

/** Which installers hold a claude-swap environment on this machine (their tool folders exist). */
export interface InstalledWith {
  readonly uv: boolean;
  readonly pipx: boolean;
}

export type UpgradeTool = 'uv' | 'pipx';

/**
 * The only arguments the upgrade is started with. They are fixed, never built from settings, paths
 * or account data; the program is the absolute path the extension located, started without a shell.
 */
export const UPGRADE_ARGS: Readonly<Record<UpgradeTool, readonly string[]>> = {
  uv: ['tool', 'upgrade', 'claude-swap'],
  pipx: ['upgrade', 'claude-swap'],
};

export interface UpgradeStep {
  readonly tool: UpgradeTool;
  /** Absolute path of uv or pipx, as located without a shell. */
  readonly program: string;
  readonly args: readonly string[];
}

/**
 * The installer that put cswap here (`cswap upgrade` cannot replace its own running .exe on Windows,
 * so it only prints the installer's command). A path inside an installer's folder decides; uv and
 * pipx both put launchers in `~/.local/bin`, so there the installer whose environment exists
 * decides, and nothing is chosen when that is ambiguous.
 */
export function upgradeTool(executablePath: string, installed: InstalledWith): UpgradeTool | undefined {
  const normalized = executablePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/pipx/')) {
    return 'pipx';
  }
  if (normalized.includes('/uv/')) {
    return 'uv';
  }
  if (normalized.includes('/.local/bin/') && installed.uv !== installed.pipx) {
    return installed.uv ? 'uv' : 'pipx';
  }
  return undefined;
}

/** The upgrade command by program name, for a user who runs it in a terminal of their own. */
export function upgradeCommandByName(tool: UpgradeTool): string {
  return [tool, ...UPGRADE_ARGS[tool]].join(' ');
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Whether uv's or pipx's tool folder holds claude-swap (folder existence only; nothing is read).
 * The folders are the installers' defaults and their documented overrides (`UV_TOOL_DIR`,
 * `PIPX_HOME`, `XDG_DATA_HOME`); relative values are ignored.
 */
export async function installedWith(environment: Pick<ResolverEnvironment, 'platform' | 'env' | 'homeDir' | 'statKind'>): Promise<InstalledWith> {
  const { platform, env, homeDir } = environment;
  const api = pathApi(platform);
  const variable = (name: string): string | undefined => {
    const value = readEnv(env, name, platform)?.trim();
    return value !== undefined && value !== '' && api.isAbsolute(value) ? value : undefined;
  };
  const dataHome = variable('XDG_DATA_HOME') ?? api.join(homeDir, '.local', 'share');
  const appData = platform === 'win32' ? variable('APPDATA') : undefined;
  const uvDirs = [variable('UV_TOOL_DIR'), appData === undefined ? undefined : api.join(appData, 'uv', 'tools'), api.join(dataHome, 'uv', 'tools')];
  const pipxDirs = [variable('PIPX_HOME'), api.join(homeDir, 'pipx'), api.join(homeDir, '.local', 'pipx'), api.join(dataHome, 'pipx')].map((dir) =>
    dir === undefined ? undefined : api.join(dir, 'venvs'),
  );
  const holds = async (dirs: ReadonlyArray<string | undefined>): Promise<boolean> => {
    for (const dir of dirs) {
      if (dir !== undefined && (await environment.statKind(api.join(dir, 'claude-swap'))) === 'directory') {
        return true;
      }
    }
    return false;
  };
  const [uv, pipx] = await Promise.all([holds(uvDirs), holds(pipxDirs)]);
  return { uv, pipx };
}

/**
 * `run`: start `step` (absolute program, fixed arguments). `manual`: nothing can run; `tool` is the
 * installer when it is known but its program was not found.
 */
export type UpgradePlan = { readonly kind: 'run'; readonly step: UpgradeStep } | { readonly kind: 'manual'; readonly tool?: UpgradeTool };

/** How to upgrade the cswap at `executablePath` (undefined when cswap is not found). */
export async function planCswapUpgrade(
  executablePath: string | undefined,
  environment: ResolverEnvironment,
  locate: (tool: UpgradeTool, environment: ResolverEnvironment) => Promise<string | undefined> = locateTool,
): Promise<UpgradePlan> {
  if (executablePath === undefined) {
    return { kind: 'manual' };
  }
  const tool = upgradeTool(executablePath, await installedWith(environment));
  if (tool === undefined) {
    return { kind: 'manual' };
  }
  const program = await locate(tool, environment);
  return program !== undefined && pathApi(environment.platform).isAbsolute(program)
    ? { kind: 'run', step: { tool, program, args: UPGRADE_ARGS[tool] } }
    : { kind: 'manual', tool };
}

/**
 * After a check: `upgrade` right away when automatic updates are on, else `offer` (unless the user
 * skipped this version and did not ask for the check), else nothing.
 */
export type UpdateDecision = 'none' | 'upgrade' | 'offer';

export function decideUpdate(input: {
  readonly current: CliVersion | undefined;
  readonly latest: CliVersion | undefined;
  readonly automatic: boolean;
  /** The user asked for this check (Quick Settings, command). */
  readonly requested: boolean;
  /** The version the user chose to skip, if any. */
  readonly skipped: string | undefined;
}): UpdateDecision {
  const { current, latest } = input;
  if (current === undefined || latest === undefined || !isNewer(latest, current)) {
    return 'none';
  }
  if (input.automatic) {
    return 'upgrade';
  }
  return input.requested || input.skipped !== latest.text ? 'offer' : 'none';
}

/** The environment the upgrade runs with (Windows: the current folder is not searched for programs). */
export function upgradeEnvironment(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  return { ...cliEnvironment(base), ...(platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) };
}

/** Why an upgrade did not happen. `detail` is one redacted line of the installer's stderr. */
export type UpgradeFailure =
  | { readonly kind: 'exited'; readonly exitCode: number | null; readonly detail?: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'not-started'; readonly errorCode?: string }
  | { readonly kind: 'output-limit' }
  /** A switch or account change kept the operation gate busy. */
  | { readonly kind: 'busy' }
  /** The installer succeeded, but cswap still reports an older version. */
  | { readonly kind: 'unchanged'; readonly version: string }
  /** The installer succeeded, but `cswap --version` could not be read afterwards. */
  | { readonly kind: 'unverified' };

export type UpgradeProcessOutcome = { readonly ok: true } | { readonly ok: false; readonly failure: UpgradeFailure };

/** Reads the installer's result; only the exit code and one redacted, link-free stderr line are kept. */
export function upgradeProcessOutcome(result: ProcessResult, homeDir: string): UpgradeProcessOutcome {
  if (result.kind === 'exited') {
    if (result.exitCode === 0) {
      return { ok: true };
    }
    const line = redactLine(result.stderr, 'last', { homeDir });
    return { ok: false, failure: { kind: 'exited', exitCode: result.exitCode, ...(line === undefined ? {} : { detail: neutralizeLinks(line) }) } };
  }
  switch (result.failure) {
    case 'timeout':
      return { ok: false, failure: { kind: 'timeout' } };
    case 'output-limit':
      return { ok: false, failure: { kind: 'output-limit' } };
    default:
      return { ok: false, failure: { kind: 'not-started', ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }) } };
  }
}

/** Whether the cswap read after a successful upgrade is at least the release it was upgraded to. */
export function verifyUpgrade(after: CliVersion | undefined, target: CliVersion): UpgradeProcessOutcome {
  if (after === undefined) {
    return { ok: false, failure: { kind: 'unverified' } };
  }
  return isNewer(target, after) ? { ok: false, failure: { kind: 'unchanged', version: after.text } } : { ok: true };
}

/** For the log: the failure kind, exit code and redacted detail only. */
export function describeUpgradeFailure(failure: UpgradeFailure): string {
  switch (failure.kind) {
    case 'exited':
      return `exited (exit ${String(failure.exitCode)})${failure.detail === undefined ? '' : ` — ${failure.detail}`}`;
    case 'not-started':
      return `not started${failure.errorCode === undefined ? '' : ` (${failure.errorCode})`}`;
    case 'unchanged':
      return `cswap still reports ${failure.version}`;
    default:
      return failure.kind;
  }
}

/**
 * A window records when it starts an upgrade (in state shared by the windows), so another window
 * does not start one at the same time. A record older than `staleMs` (a window that closed during
 * the upgrade) or dated in the future no longer counts.
 */
export function upgradeRunningElsewhere(record: unknown, now: number, staleMs: number): boolean {
  return typeof record === 'number' && Number.isFinite(record) && record <= now + 60_000 && now - record < staleMs;
}
