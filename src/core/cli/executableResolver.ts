import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const CLI_BASE_NAME = 'cswap';

/** Extensions that Node can execute directly on Windows without a shell. */
const WINDOWS_DIRECT_EXTENSIONS = ['.exe', '.com'] as const;
/** Script shims that would need `cmd.exe`; reported as unsupported rather than shell-executed. */
const WINDOWS_SHIM_EXTENSIONS = ['.cmd', '.bat', '.ps1'] as const;

export type ExecutableSource = 'setting' | 'path' | 'default-location';

export interface ResolvedExecutable {
  readonly ok: true;
  readonly path: string;
  readonly source: ExecutableSource;
}

export type ExecutableResolutionFailure =
  | 'not-found'
  | 'setting-not-absolute'
  | 'setting-not-found'
  | 'setting-not-a-file'
  | 'unsupported-shim';

export interface UnresolvedExecutable {
  readonly ok: false;
  readonly reason: ExecutableResolutionFailure;
  /** Offending path (setting value or discovered shim); redact before display. */
  readonly path?: string;
}

export type ExecutableResolution = ResolvedExecutable | UnresolvedExecutable;

export interface ResolverEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  /**
   * The open workspace folders. PATH entries inside them are not searched, so a project cannot
   * supply a program through PATH (VS Code started from a shell with `<project>/.venv/bin` on PATH).
   */
  readonly workspaceFolders?: readonly string[];
  /** Returns 'file', 'directory', or undefined when the path does not exist. */
  statKind(candidate: string): Promise<'file' | 'directory' | 'other' | undefined>;
  /** POSIX only: whether the file is executable by the current user. */
  isExecutable(candidate: string): Promise<boolean>;
  /**
   * Windows only: whether the path is an app execution alias (`WindowsApps\winget.exe`), which starts
   * like a program but cannot be stat-ed. Asked only by lookups that accept an alias.
   */
  isAppExecutionAlias?(candidate: string): Promise<boolean>;
}

export function nodeResolverEnvironment(): ResolverEnvironment {
  return {
    platform: process.platform,
    env: process.env,
    homeDir: os.homedir(),
    async statKind(candidate) {
      try {
        const stats = await fs.stat(candidate);
        if (stats.isFile()) {
          return 'file';
        }
        return stats.isDirectory() ? 'directory' : 'other';
      } catch {
        return undefined;
      }
    },
    async isExecutable(candidate) {
      try {
        await fs.access(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    isAppExecutionAlias: nodeIsAppExecutionAlias,
  };
}

/** An app execution alias fails `stat` with EACCES (or UNKNOWN); Node's lstat reports it as a link. */
async function nodeIsAppExecutionAlias(candidate: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false;
  }
  try {
    await fs.stat(candidate);
    return false;
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (code !== 'EACCES' && code !== 'UNKNOWN') {
      return false;
    }
  }
  try {
    return (await fs.lstat(candidate)).isSymbolicLink();
  } catch {
    return false;
  }
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** `%LOCALAPPDATA%` when it is an absolute path, else `<home>\AppData\Local`. */
export function localAppDataDirectory(environment: Pick<ResolverEnvironment, 'platform' | 'env' | 'homeDir'>): string {
  const local = readEnv(environment.env, 'LOCALAPPDATA', 'win32');
  return local !== undefined && local !== '' && path.win32.isAbsolute(local) ? local : path.win32.join(environment.homeDir, 'AppData', 'Local');
}

/** The only folder whose app execution aliases are accepted (and only where a lookup asks for it). */
export function windowsAppsDirectory(environment: Pick<ResolverEnvironment, 'platform' | 'env' | 'homeDir'>): string {
  return path.win32.join(localAppDataDirectory(environment), 'Microsoft', 'WindowsApps');
}

/** Normalized, without trailing separators (a root keeps its own), case-folded where the file system usually is. */
function comparablePath(value: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform);
  let normalized = api.normalize(value);
  const root = api.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith(api.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

/** Whether `candidate` is `folder` or inside it (`/a/b` is not inside `/a/bc`). */
export function isSameOrInside(candidate: string, folder: string, platform: NodeJS.Platform): boolean {
  const child = comparablePath(candidate, platform);
  const parent = comparablePath(folder, platform);
  if (child === parent) {
    return true;
  }
  const sep = pathApi(platform).sep;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * The PATH entries that are neither one of the workspace folders nor inside one. A folder that holds
 * the home folder (the home folder itself, a parent of it, a drive root) is not a project's own
 * folder and is not used: it would hide the user's own tools, such as `~/.local/bin`.
 */
export function pathEntriesOutsideFolders(
  entries: readonly string[],
  folders: readonly string[],
  environment: Pick<ResolverEnvironment, 'platform' | 'homeDir'>,
): string[] {
  const { platform, homeDir } = environment;
  const api = pathApi(platform);
  const projects = folders.filter((folder) => folder !== '' && api.isAbsolute(folder) && !isSameOrInside(homeDir, folder, platform));
  return entries.filter((entry) => !projects.some((folder) => isSameOrInside(entry, folder, platform)));
}

/** The PATH entries lookups search: absolute ones, outside the open workspace folders. */
export function searchPathEntries(environment: ResolverEnvironment): string[] {
  return pathEntriesOutsideFolders(absolutePathEntries(environment.env, environment.platform), environment.workspaceFolders ?? [], environment);
}

/** An environment variable; on Windows the name is matched case-insensitively (`Path`, `PATH`). */
export function readEnv(env: ResolverEnvironment['env'], name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') {
    return env[name];
  }
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function expandHome(value: string, homeDir: string, platform: NodeJS.Platform): string {
  if (value === '~') {
    return homeDir;
  }
  if (value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'))) {
    return pathApi(platform).join(homeDir, value.slice(2));
  }
  return value;
}

/**
 * Only absolute PATH entries are searched. Relative entries (including empty ones, which mean the
 * current directory on POSIX) could let a workspace folder shadow the real CLI.
 */
export function absolutePathEntries(env: ResolverEnvironment['env'], platform: NodeJS.Platform): string[] {
  const api = pathApi(platform);
  const raw = readEnv(env, 'PATH', platform) ?? '';
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const part of raw.split(api.delimiter)) {
    const entry = part.trim().replace(/^"(.*)"$/, '$1');
    if (entry.length === 0 || !api.isAbsolute(entry)) {
      continue;
    }
    const key = platform === 'win32' ? entry.toLowerCase() : entry;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries;
}

function hasExtension(candidate: string, extensions: readonly string[], platform: NodeJS.Platform): boolean {
  const ext = pathApi(platform).extname(candidate).toLowerCase();
  return extensions.includes(ext);
}

async function isUsableFile(candidate: string, environment: ResolverEnvironment): Promise<boolean> {
  if ((await environment.statKind(candidate)) !== 'file') {
    return false;
  }
  return environment.platform === 'win32' ? true : environment.isExecutable(candidate);
}

async function resolveConfigured(setting: string, environment: ResolverEnvironment): Promise<ExecutableResolution> {
  const { platform } = environment;
  const api = pathApi(platform);
  const expanded = expandHome(setting, environment.homeDir, platform);
  if (!api.isAbsolute(expanded)) {
    return { ok: false, reason: 'setting-not-absolute', path: setting };
  }
  const normalized = api.normalize(expanded);

  if (platform === 'win32' && hasExtension(normalized, WINDOWS_SHIM_EXTENSIONS, platform)) {
    return { ok: false, reason: 'unsupported-shim', path: normalized };
  }

  const candidates =
    platform === 'win32' && api.extname(normalized) === ''
      ? [normalized, ...WINDOWS_DIRECT_EXTENSIONS.map((ext) => normalized + ext)]
      : [normalized];

  for (const candidate of candidates) {
    const kind = await environment.statKind(candidate);
    if (kind === undefined) {
      continue;
    }
    if (kind !== 'file') {
      return { ok: false, reason: 'setting-not-a-file', path: candidate };
    }
    if (platform === 'win32' && !hasExtension(candidate, WINDOWS_DIRECT_EXTENSIONS, platform)) {
      // An extension-less or unknown-extension file cannot be started without a shell on Windows.
      continue;
    }
    if (platform !== 'win32' && !(await environment.isExecutable(candidate))) {
      return { ok: false, reason: 'setting-not-a-file', path: candidate };
    }
    return { ok: true, path: candidate, source: 'setting' };
  }
  return { ok: false, reason: 'setting-not-found', path: normalized };
}

function candidateNames(baseName: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? WINDOWS_DIRECT_EXTENSIONS.map((ext) => baseName + ext) : [baseName];
}

export interface FindExecutableOptions {
  /**
   * Also accept a Windows app execution alias, but only in `%LOCALAPPDATA%\Microsoft\WindowsApps`
   * (where winget's lives). Off for cswap.
   */
  readonly allowAppAlias?: boolean;
}

async function isAcceptedAppAlias(candidate: string, environment: ResolverEnvironment): Promise<boolean> {
  if (environment.platform !== 'win32' || environment.isAppExecutionAlias === undefined) {
    return false;
  }
  if (comparablePath(path.win32.dirname(candidate), 'win32') !== comparablePath(windowsAppsDirectory(environment), 'win32')) {
    return false;
  }
  return environment.isAppExecutionAlias(candidate);
}

/**
 * The first program named `baseName` in `directories` (searched in order) that can be started without
 * a shell: on Windows `.exe`/`.com` only, on POSIX an executable file.
 */
export async function findExecutableIn(
  baseName: string,
  directories: readonly string[],
  environment: ResolverEnvironment,
  options: FindExecutableOptions = {},
): Promise<string | undefined> {
  const api = pathApi(environment.platform);
  for (const directory of directories) {
    for (const name of candidateNames(baseName, environment.platform)) {
      const candidate = api.join(directory, name);
      if ((await isUsableFile(candidate, environment)) || (options.allowAppAlias === true && (await isAcceptedAppAlias(candidate, environment)))) {
        return candidate;
      }
    }
  }
  return undefined;
}

async function findShim(directories: readonly string[], environment: ResolverEnvironment): Promise<string | undefined> {
  const api = pathApi(environment.platform);
  for (const directory of directories) {
    for (const ext of WINDOWS_SHIM_EXTENSIONS) {
      const candidate = api.join(directory, CLI_BASE_NAME + ext);
      if ((await environment.statKind(candidate)) === 'file') {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Well-known install locations used by `uv tool install` and `pipx`. */
export function defaultLocations(environment: Pick<ResolverEnvironment, 'platform' | 'homeDir'>): string[] {
  const api = pathApi(environment.platform);
  return [api.join(environment.homeDir, '.local', 'bin')];
}

/**
 * Resolves the absolute path of the `cswap` executable.
 * Order: explicit setting (never falls back if set but invalid) → absolute PATH entries outside the
 * workspace folders → default locations.
 */
export async function resolveCswapExecutable(
  setting: string | undefined,
  environment: ResolverEnvironment,
): Promise<ExecutableResolution> {
  const configured = setting?.trim() ?? '';
  if (configured.length > 0) {
    return resolveConfigured(configured, environment);
  }

  const pathDirs = searchPathEntries(environment);
  const groups: Array<{ source: ExecutableSource; directories: string[] }> = [
    { source: 'path', directories: pathDirs },
    { source: 'default-location', directories: defaultLocations(environment) },
  ];

  for (const group of groups) {
    const found = await findExecutableIn(CLI_BASE_NAME, group.directories, environment);
    if (found !== undefined) {
      return { ok: true, path: found, source: group.source };
    }
  }

  if (environment.platform === 'win32') {
    const shim = await findShim([...pathDirs, ...defaultLocations(environment)], environment);
    if (shim !== undefined) {
      return { ok: false, reason: 'unsupported-shim', path: shim };
    }
  }
  return { ok: false, reason: 'not-found' };
}

/** Caches the resolution until invalidated (e.g. on settings change or a not-found spawn error). */
export class CachedExecutableResolver {
  private pending: Promise<ExecutableResolution> | undefined;

  constructor(
    private readonly readSetting: () => string | undefined,
    private readonly environment: ResolverEnvironment,
  ) {}

  resolve(): Promise<ExecutableResolution> {
    if (!this.pending) {
      const attempt = resolveCswapExecutable(this.readSetting(), this.environment);
      this.pending = attempt;
      // Failures are not cached, so installing the CLI later is picked up on the next call.
      void attempt.then((result) => {
        if (!result.ok && this.pending === attempt) {
          this.pending = undefined;
        }
      });
    }
    return this.pending;
  }

  invalidate(): void {
    this.pending = undefined;
  }
}
