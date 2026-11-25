import * as path from 'node:path';
import { findExecutableIn, localAppDataDirectory, readEnv, searchPathEntries, windowsAppsDirectory, type ResolverEnvironment } from './executableResolver';

/** uv's own installation guide (also lists its standalone installers, which the extension never runs). */
export const UV_INSTALL_URL = 'https://docs.astral.sh/uv/getting-started/installation/';
/** The PyPI page of claude-swap, the package that provides the `cswap` command. */
export const CSWAP_PYPI_URL = 'https://pypi.org/project/claude-swap/';

export type InstallTool = 'uv' | 'pipx' | 'winget' | 'brew';

/**
 * The only arguments the installers are started with. They are fixed, never built from settings,
 * paths or account data, and none downloads and runs a remote script. The program itself is the
 * absolute path the extension located, started without a shell.
 */
export const INSTALL_ARGS: Readonly<Record<InstallTool, readonly string[]>> = {
  uv: ['tool', 'install', 'claude-swap'],
  pipx: ['install', 'claude-swap'],
  winget: ['install', '--id=astral-sh.uv', '-e', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements'],
  brew: ['install', 'uv'],
};

export interface InstallStep {
  readonly tool: InstallTool;
  /** Absolute path of the program, as located without a shell; the terminal starts exactly this file. */
  readonly program: string;
  readonly args: readonly string[];
}

/**
 * `run`: `first` runs the program found now; `next` (uv) is the program that step installs, located
 * again once the step has ended and then started with its own arguments. `manual`: nothing to run.
 */
export type InstallPlan = { readonly kind: 'run'; readonly first: InstallStep; readonly next?: InstallTool } | { readonly kind: 'manual' };

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** The step that starts `program` (an absolute path) with the tool's fixed arguments. */
export function installStep(tool: InstallTool, program: string): InstallStep {
  return { tool, program, args: INSTALL_ARGS[tool] };
}

/** The step as it is shown: the full program path (quoted when it holds a space), then its arguments. */
export function describeInstallStep(step: InstallStep): string {
  const program = /\s/.test(step.program) ? `"${step.program}"` : step.program;
  return [program, ...step.args].join(' ');
}

/** The tool's command by program name, for a user who runs it in a terminal of their own. */
export function installCommandByName(tool: InstallTool): string {
  return [tool, ...INSTALL_ARGS[tool]].join(' ');
}

/** The programs the plan can use on this platform, most preferred first. */
export function installToolsFor(platform: NodeJS.Platform): InstallTool[] {
  return ['uv', 'pipx', ...(platform === 'win32' ? (['winget'] as const) : []), ...(platform === 'darwin' ? (['brew'] as const) : [])];
}

/**
 * How to install cswap with what this machine has (`locate` gives each program's absolute path):
 * with uv, else pipx; else uv itself first (winget on Windows, Homebrew on macOS), then cswap with
 * uv. Without any of them there is nothing to run and the user is pointed to the instructions.
 */
export function planCswapInstall(platform: NodeJS.Platform, locate: (tool: InstallTool) => string | undefined): InstallPlan {
  const found = (tool: InstallTool): string | undefined => {
    const program = locate(tool);
    return program !== undefined && pathApi(platform).isAbsolute(program) ? program : undefined;
  };
  const run = (tool: InstallTool, next?: InstallTool): InstallPlan | undefined => {
    const program = found(tool);
    return program === undefined ? undefined : { kind: 'run', first: installStep(tool, program), ...(next === undefined ? {} : { next }) };
  };
  return (
    run('uv') ??
    run('pipx') ??
    (platform === 'win32' ? run('winget', 'uv') : undefined) ??
    (platform === 'darwin' ? run('brew', 'uv') : undefined) ?? { kind: 'manual' }
  );
}

/** Folder winget unpacks uv into (package id + the community source's id). */
export const WINGET_UV_PACKAGE_DIR = 'astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe';

/**
 * Where installers put these programs, for when their folder is not on this window's PATH: VS Code
 * keeps the PATH it started with, so a program installed a minute ago (winget adds its folder to the
 * user PATH) is only found here.
 */
export function knownToolDirectories(tool: InstallTool, environment: Pick<ResolverEnvironment, 'platform' | 'env' | 'homeDir'>): string[] {
  const { platform, env, homeDir } = environment;
  const api = pathApi(platform);
  const localBin = api.join(homeDir, '.local', 'bin');
  const cargoBin = api.join(homeDir, '.cargo', 'bin');
  if (platform === 'win32') {
    const local = localAppDataDirectory(environment);
    const programFiles = readEnv(env, 'ProgramFiles', platform);
    switch (tool) {
      case 'uv':
        return [
          localBin,
          cargoBin,
          api.join(local, 'Microsoft', 'WinGet', 'Links'),
          // Without the right to create links, winget leaves uv in its package folder.
          api.join(local, 'Microsoft', 'WinGet', 'Packages', WINGET_UV_PACKAGE_DIR),
          ...(programFiles !== undefined && programFiles !== '' && api.isAbsolute(programFiles) ? [api.join(programFiles, 'WinGet', 'Links')] : []),
        ];
      case 'pipx':
        return [localBin];
      case 'winget':
        return [windowsAppsDirectory(environment)];
      case 'brew':
        return [];
    }
  }
  const brewBins = platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  switch (tool) {
    case 'uv':
      return [localBin, cargoBin, ...brewBins];
    case 'pipx':
      return [localBin, ...brewBins];
    case 'brew':
      return brewBins;
    case 'winget':
      return [];
  }
}

/**
 * Finds an installer program without a shell and returns its absolute path: PATH entries (absolute,
 * outside the workspace folders) first, then its known folders. Only winget may be an app execution
 * alias, and only in `%LOCALAPPDATA%\Microsoft\WindowsApps`.
 */
export async function locateTool(tool: InstallTool, environment: ResolverEnvironment): Promise<string | undefined> {
  const options = { allowAppAlias: tool === 'winget' };
  return (
    (await findExecutableIn(tool, searchPathEntries(environment), environment, options)) ??
    (await findExecutableIn(tool, knownToolDirectories(tool, environment), environment, options))
  );
}

/** Every installer this platform's plan could use, located side by side (absolute paths). */
export async function locateInstallTools(environment: ResolverEnvironment): Promise<Map<InstallTool, string>> {
  const tools = installToolsFor(environment.platform);
  const locations = await Promise.all(tools.map((tool) => locateTool(tool, environment)));
  const found = new Map<InstallTool, string>();
  tools.forEach((tool, index) => {
    const location = locations[index];
    if (location !== undefined) {
      found.set(tool, location);
    }
  });
  return found;
}
