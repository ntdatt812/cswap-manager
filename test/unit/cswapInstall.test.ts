import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  INSTALL_ARGS,
  WINGET_UV_PACKAGE_DIR,
  describeInstallStep,
  installCommandByName,
  installStep,
  installToolsFor,
  knownToolDirectories,
  locateInstallTools,
  locateTool,
  planCswapInstall,
  type InstallPlan,
  type InstallStep,
  type InstallTool,
} from '../../src/core/cli/cswapInstall';
import { findExecutableIn, type ResolverEnvironment } from '../../src/core/cli/executableResolver';

const ALL_TOOLS: readonly InstallTool[] = ['uv', 'pipx', 'winget', 'brew'];
const PLATFORMS: readonly NodeJS.Platform[] = ['win32', 'darwin', 'linux'];

const WIN_PROGRAMS: Readonly<Record<InstallTool, string>> = {
  uv: 'C:\\Users\\dev\\.local\\bin\\uv.exe',
  pipx: 'C:\\Users\\dev\\.local\\bin\\pipx.exe',
  winget: 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe',
  brew: 'C:\\nowhere\\brew.exe',
};
const POSIX_PROGRAMS: Readonly<Record<InstallTool, string>> = {
  uv: '/home/dev/.local/bin/uv',
  pipx: '/home/dev/.local/bin/pipx',
  winget: '/nowhere/winget',
  brew: '/opt/homebrew/bin/brew',
};

function programsFor(platform: NodeJS.Platform): Readonly<Record<InstallTool, string>> {
  return platform === 'win32' ? WIN_PROGRAMS : POSIX_PROGRAMS;
}

/** A locator that finds the given tools at their usual absolute paths. */
function has(platform: NodeJS.Platform, ...tools: InstallTool[]): (tool: InstallTool) => string | undefined {
  return (tool) => (tools.includes(tool) ? programsFor(platform)[tool] : undefined);
}

function step(platform: NodeJS.Platform, tool: InstallTool): InstallStep {
  return { tool, program: programsFor(platform)[tool], args: INSTALL_ARGS[tool] };
}

function steps(plan: InstallPlan): InstallStep[] {
  return plan.kind === 'run' ? [plan.first] : [];
}

function windowsEnv(files: string[], pathValue = 'C:\\Windows\\System32;C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps', aliases: string[] = []): ResolverEnvironment {
  const known = new Set(files.map((file) => file.toLowerCase()));
  const aliasSet = new Set(aliases.map((file) => file.toLowerCase()));
  return {
    platform: 'win32',
    env: { Path: pathValue, LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
    homeDir: 'C:\\Users\\dev',
    // An app execution alias cannot be stat-ed, so it is no 'file' here.
    statKind: (candidate) => Promise.resolve(known.has(candidate.toLowerCase()) ? 'file' : undefined),
    isExecutable: () => Promise.resolve(true),
    isAppExecutionAlias: (candidate) => Promise.resolve(aliasSet.has(candidate.toLowerCase())),
  };
}

function posixEnv(platform: NodeJS.Platform, files: string[], pathValue = '/usr/bin:/bin'): ResolverEnvironment {
  const known = new Set(files);
  return {
    platform,
    env: { PATH: pathValue },
    homeDir: '/home/dev',
    statKind: (candidate) => Promise.resolve(known.has(candidate) ? 'file' : undefined),
    isExecutable: (candidate) => Promise.resolve(known.has(candidate)),
  };
}

describe('planCswapInstall', () => {
  it('installs with uv when uv is there (on every platform, before pipx), by its absolute path', () => {
    for (const platform of PLATFORMS) {
      const plan = planCswapInstall(platform, has(platform, 'uv', 'pipx', 'winget', 'brew'));
      assert.deepEqual(plan, { kind: 'run', first: step(platform, 'uv') }, platform);
    }
    assert.deepEqual(planCswapInstall('win32', has('win32', 'uv')), {
      kind: 'run',
      first: { tool: 'uv', program: 'C:\\Users\\dev\\.local\\bin\\uv.exe', args: ['tool', 'install', 'claude-swap'] },
    });
  });

  it('installs with pipx when there is no uv', () => {
    for (const platform of PLATFORMS) {
      const plan = planCswapInstall(platform, has(platform, 'pipx', 'winget', 'brew'));
      assert.deepEqual(plan, { kind: 'run', first: step(platform, 'pipx') }, platform);
    }
  });

  it('on Windows installs uv with winget (from the winget source) first, then cswap with the uv it installs', () => {
    const plan = planCswapInstall('win32', has('win32', 'winget', 'brew'));
    assert.deepEqual(plan, {
      kind: 'run',
      first: {
        tool: 'winget',
        program: 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe',
        args: ['install', '--id=astral-sh.uv', '-e', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements'],
      },
      next: 'uv',
    });
  });

  it('on macOS installs uv with Homebrew first, then cswap with uv', () => {
    const plan = planCswapInstall('darwin', has('darwin', 'brew', 'winget'));
    assert.deepEqual(plan, { kind: 'run', first: { tool: 'brew', program: '/opt/homebrew/bin/brew', args: ['install', 'uv'] }, next: 'uv' });
  });

  it('does not use winget outside Windows or Homebrew outside macOS', () => {
    assert.deepEqual(planCswapInstall('linux', has('linux', 'winget', 'brew')), { kind: 'manual' });
    assert.deepEqual(planCswapInstall('darwin', has('darwin', 'winget')), { kind: 'manual' });
    assert.deepEqual(planCswapInstall('win32', has('win32', 'brew')), { kind: 'manual' });
  });

  it('runs nothing when no installer is found', () => {
    for (const platform of PLATFORMS) {
      assert.deepEqual(planCswapInstall(platform, () => undefined), { kind: 'manual' }, platform);
    }
  });

  it('never runs a program by bare or relative name', () => {
    assert.deepEqual(planCswapInstall('win32', (tool) => (tool === 'uv' ? 'uv.exe' : tool === 'pipx' ? '.\\pipx.exe' : undefined)), { kind: 'manual' });
    assert.deepEqual(planCswapInstall('linux', (tool) => (tool === 'uv' ? 'uv' : tool === 'pipx' ? 'bin/pipx' : undefined)), { kind: 'manual' });
    assert.deepEqual(planCswapInstall('win32', (tool) => (tool === 'uv' ? 'uv' : WIN_PROGRAMS[tool])), { kind: 'run', first: step('win32', 'pipx') }, 'falls through to the next absolute one');
  });

  it('only ever uses absolute programs and the fixed argument arrays: no shell strings, no user data, no remote scripts', () => {
    const subsets = ALL_TOOLS.reduce<InstallTool[][]>((sets, tool) => [...sets, ...sets.map((set) => [...set, tool])], [[]]);
    for (const platform of PLATFORMS) {
      const api = platform === 'win32' ? path.win32 : path.posix;
      for (const subset of subsets) {
        const plan = planCswapInstall(platform, has(platform, ...subset));
        for (const planned of steps(plan)) {
          assert.ok(api.isAbsolute(planned.program), planned.program);
          assert.equal(planned.args, INSTALL_ARGS[planned.tool], 'the fixed array itself');
          assert.deepEqual(Object.keys(planned).sort(), ['args', 'program', 'tool'], 'no command string');
        }
        if (plan.kind === 'run' && plan.next !== undefined) {
          assert.equal(plan.next, 'uv');
        }
      }
    }
    for (const args of Object.values(INSTALL_ARGS)) {
      assert.ok(args.length > 0);
      for (const arg of args) {
        assert.match(arg, /^[a-z-][a-z0-9.=-]*$/, arg);
        assert.doesNotMatch(arg, /https?:|\||&|;|>|<|\$|`|iex|curl|irm|sudo|[\\/\s"']/, arg);
      }
    }
  });

  it('lists the installers each platform can use', () => {
    assert.deepEqual(installToolsFor('win32'), ['uv', 'pipx', 'winget']);
    assert.deepEqual(installToolsFor('darwin'), ['uv', 'pipx', 'brew']);
    assert.deepEqual(installToolsFor('linux'), ['uv', 'pipx']);
  });

  it('shows the full program path and its arguments (quoted when the path holds a space), and the command by name', () => {
    assert.equal(describeInstallStep(installStep('uv', 'C:\\Users\\dev\\.local\\bin\\uv.exe')), 'C:\\Users\\dev\\.local\\bin\\uv.exe tool install claude-swap');
    assert.equal(describeInstallStep(installStep('uv', 'C:\\Program Files\\WinGet\\Links\\uv.exe')), '"C:\\Program Files\\WinGet\\Links\\uv.exe" tool install claude-swap');
    assert.equal(
      describeInstallStep(step('win32', 'winget')),
      'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe install --id=astral-sh.uv -e --source winget --accept-source-agreements --accept-package-agreements',
    );
    assert.equal(installCommandByName('uv'), 'uv tool install claude-swap');
    assert.equal(installCommandByName('brew'), 'brew install uv');
  });
});

describe('locating installers without a shell', () => {
  it('finds a program on PATH by its absolute path (Windows: .exe only)', async () => {
    const env = windowsEnv(['C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe', 'C:\\Windows\\System32\\pipx.cmd']);
    assert.equal(await locateTool('winget', env), 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe');
    assert.equal(await locateTool('pipx', env), undefined, 'a .cmd shim is not counted');
  });

  it('accepts winget as an app execution alias, but only in %LOCALAPPDATA%\\Microsoft\\WindowsApps', async () => {
    const alias = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe';
    assert.equal(await locateTool('winget', windowsEnv([], undefined, [alias])), alias);
    const elsewhere = 'C:\\Tools\\winget.exe';
    assert.equal(await locateTool('winget', windowsEnv([], 'C:\\Tools', [elsewhere])), undefined, 'an alias-like file in another folder');
    const otherAppData = windowsEnv([], 'D:\\Other\\Microsoft\\WindowsApps', ['D:\\Other\\Microsoft\\WindowsApps\\winget.exe']);
    assert.equal(await locateTool('winget', otherAppData), undefined, 'a WindowsApps folder that is not this user\'s');
  });

  it('never accepts an app execution alias for the other installers', async () => {
    const dir = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps';
    const env = windowsEnv([], dir, [`${dir}\\uv.exe`, `${dir}\\pipx.exe`]);
    assert.equal(await locateTool('uv', env), undefined);
    assert.equal(await locateTool('pipx', env), undefined);
  });

  it('finds uv where winget puts it although that folder is not on this window\'s PATH yet', async () => {
    const packaged = `C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Packages\\${WINGET_UV_PACKAGE_DIR}\\uv.exe`;
    assert.equal(await locateTool('uv', windowsEnv([packaged])), packaged);
    const linked = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\uv.exe';
    assert.equal(await locateTool('uv', windowsEnv([linked, packaged])), linked);
  });

  it('prefers PATH over the known folders', async () => {
    const env = windowsEnv(['C:\\Tools\\uv.exe', 'C:\\Users\\dev\\.local\\bin\\uv.exe'], 'C:\\Tools');
    assert.equal(await locateTool('uv', env), 'C:\\Tools\\uv.exe');
  });

  it('skips PATH entries inside an open workspace folder', async () => {
    const env: ResolverEnvironment = {
      ...windowsEnv(['D:\\Projects\\evil\\.venv\\Scripts\\uv.exe', 'C:\\Users\\dev\\.local\\bin\\uv.exe'], 'D:\\Projects\\evil\\.venv\\Scripts'),
      workspaceFolders: ['d:\\projects\\EVIL'],
    };
    assert.equal(await locateTool('uv', env), 'C:\\Users\\dev\\.local\\bin\\uv.exe');
    const posix: ResolverEnvironment = { ...posixEnv('linux', ['/work/app/.venv/bin/uv', '/home/dev/.local/bin/uv'], '/work/app/.venv/bin'), workspaceFolders: ['/work/app'] };
    assert.equal(await locateTool('uv', posix), '/home/dev/.local/bin/uv');
  });

  it('finds Homebrew and uv in Homebrew\'s folder on macOS', async () => {
    const env = posixEnv('darwin', ['/opt/homebrew/bin/brew', '/opt/homebrew/bin/uv']);
    assert.equal(await locateTool('brew', env), '/opt/homebrew/bin/brew');
    const tools = await locateInstallTools(env);
    assert.deepEqual([...tools.entries()], [
      ['uv', '/opt/homebrew/bin/uv'],
      ['brew', '/opt/homebrew/bin/brew'],
    ]);
  });

  it('needs an executable file on POSIX', async () => {
    const env: ResolverEnvironment = { ...posixEnv('linux', ['/home/dev/.local/bin/uv']), isExecutable: () => Promise.resolve(false) };
    assert.equal(await locateTool('uv', env), undefined);
  });

  it('lists only absolute known folders', () => {
    const env = { ...windowsEnv([]), env: { LOCALAPPDATA: 'relative\\dir', ProgramFiles: '' } };
    for (const tool of ALL_TOOLS) {
      for (const dir of knownToolDirectories(tool, env)) {
        assert.match(dir, /^C:\\Users\\dev\\/, dir);
      }
    }
    assert.deepEqual(knownToolDirectories('brew', posixEnv('linux', [])), []);
    assert.deepEqual(knownToolDirectories('winget', posixEnv('darwin', [])), []);
  });

  it('findExecutableIn searches the folders in order', async () => {
    const env = posixEnv('linux', ['/b/tool', '/c/tool']);
    assert.equal(await findExecutableIn('tool', ['/a', '/b', '/c'], env), '/b/tool');
    assert.equal(await findExecutableIn('tool', ['/a'], env), undefined);
  });
});
