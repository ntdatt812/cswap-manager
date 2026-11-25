import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  CachedExecutableResolver,
  absolutePathEntries,
  isSameOrInside,
  nodeResolverEnvironment,
  pathEntriesOutsideFolders,
  resolveCswapExecutable,
  windowsAppsDirectory,
  type ResolverEnvironment,
} from '../../src/core/cli/executableResolver';

interface FakeFs {
  files?: string[];
  dirs?: string[];
  executable?: string[];
}

function windowsEnv(fsState: FakeFs, pathValue = 'C:\\Tools;C:\\Python\\Scripts'): ResolverEnvironment {
  const files = new Set((fsState.files ?? []).map((file) => file.toLowerCase()));
  const dirs = new Set((fsState.dirs ?? []).map((dir) => dir.toLowerCase()));
  return {
    platform: 'win32',
    env: { Path: pathValue },
    homeDir: 'C:\\Users\\dev',
    statKind: (candidate) => {
      const key = candidate.toLowerCase();
      return Promise.resolve(files.has(key) ? 'file' : dirs.has(key) ? 'directory' : undefined);
    },
    isExecutable: () => Promise.resolve(true),
  };
}

function posixEnv(fsState: FakeFs, pathValue = '/usr/local/bin:/usr/bin'): ResolverEnvironment {
  const files = new Set(fsState.files ?? []);
  const executable = new Set(fsState.executable ?? fsState.files ?? []);
  return {
    platform: 'linux',
    env: { PATH: pathValue },
    homeDir: '/home/dev',
    statKind: (candidate) => Promise.resolve(files.has(candidate) ? 'file' : undefined),
    isExecutable: (candidate) => Promise.resolve(executable.has(candidate)),
  };
}

describe('resolveCswapExecutable — Windows', () => {
  it('finds cswap.exe on PATH (case-insensitive Path variable)', async () => {
    const result = await resolveCswapExecutable('', windowsEnv({ files: ['C:\\Python\\Scripts\\cswap.exe'] }));
    assert.deepEqual(result, { ok: true, path: 'C:\\Python\\Scripts\\cswap.exe', source: 'path' });
  });

  it('falls back to ~/.local/bin', async () => {
    const result = await resolveCswapExecutable(undefined, windowsEnv({ files: ['C:\\Users\\dev\\.local\\bin\\cswap.exe'] }));
    assert.deepEqual(result, { ok: true, path: 'C:\\Users\\dev\\.local\\bin\\cswap.exe', source: 'default-location' });
  });

  it('reports a .cmd shim as unsupported instead of running it through a shell', async () => {
    const result = await resolveCswapExecutable('', windowsEnv({ files: ['C:\\Tools\\cswap.cmd'] }));
    assert.deepEqual(result, { ok: false, reason: 'unsupported-shim', path: 'C:\\Tools\\cswap.cmd' });
  });

  it('prefers a real .exe over a shim', async () => {
    const result = await resolveCswapExecutable('', windowsEnv({ files: ['C:\\Tools\\cswap.cmd', 'C:\\Python\\Scripts\\cswap.exe'] }));
    assert.equal(result.ok && result.path, 'C:\\Python\\Scripts\\cswap.exe');
  });

  it('ignores relative PATH entries so the current folder cannot shadow the CLI', async () => {
    const result = await resolveCswapExecutable('', windowsEnv({ files: ['.\\cswap.exe', 'cswap.exe'] }, '.;bin;;"C:\\Tools"'));
    assert.deepEqual(result, { ok: false, reason: 'not-found' });
  });

  it('uses a configured absolute path', async () => {
    const result = await resolveCswapExecutable('D:\\apps\\cswap.exe', windowsEnv({ files: ['D:\\apps\\cswap.exe'] }));
    assert.deepEqual(result, { ok: true, path: 'D:\\apps\\cswap.exe', source: 'setting' });
  });

  it('appends .exe to an extension-less configured path', async () => {
    const result = await resolveCswapExecutable('D:\\apps\\cswap', windowsEnv({ files: ['D:\\apps\\cswap.exe'] }));
    assert.equal(result.ok && result.path, 'D:\\apps\\cswap.exe');
  });

  it('expands ~ in the configured path', async () => {
    const result = await resolveCswapExecutable('~\\.local\\bin\\cswap.exe', windowsEnv({ files: ['C:\\Users\\dev\\.local\\bin\\cswap.exe'] }));
    assert.equal(result.ok && result.source, 'setting');
  });

  it('never accepts an app execution alias for cswap, even in WindowsApps', async () => {
    const windowsApps = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps';
    assert.equal(windowsAppsDirectory({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, homeDir: 'C:\\Users\\dev' }), windowsApps);
    const aliasAsked: string[] = [];
    const env: ResolverEnvironment = {
      ...windowsEnv({}, `${windowsApps};C:\\Tools`),
      env: { Path: `${windowsApps};C:\\Tools`, LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
      // An alias-like reparse point: stat fails, lstat would call it a link.
      isAppExecutionAlias: (candidate) => {
        aliasAsked.push(candidate);
        return Promise.resolve(true);
      },
    };
    assert.deepEqual(await resolveCswapExecutable('', env), { ok: false, reason: 'not-found' });
    assert.deepEqual(aliasAsked, [], 'the cswap lookup never asks');
  });

  const realAlias = process.platform === 'win32' ? path.join(windowsAppsDirectory(nodeResolverEnvironment()), 'winget.exe') : '';
  // existsSync stats the file, which an alias refuses; lstat sees it.
  const hasRealAlias = realAlias !== '' && fs.lstatSync(realAlias, { throwIfNoEntry: false }) !== undefined;
  it('on this machine, a real app execution alias is no file to statKind (so never cswap), only to isAppExecutionAlias', { skip: !hasRealAlias }, async () => {
    const env = nodeResolverEnvironment();
    assert.equal(await env.statKind(realAlias), undefined);
    assert.equal(await env.isAppExecutionAlias?.(realAlias), true);
    assert.equal(await env.isAppExecutionAlias?.(process.execPath), false, 'a normal program is not an alias');
  });

  it('skips PATH entries inside an open workspace folder (case-insensitively), then uses the default location', async () => {
    const files = ['D:\\Work\\Repo\\.venv\\Scripts\\cswap.exe', 'C:\\Users\\dev\\.local\\bin\\cswap.exe'];
    const env: ResolverEnvironment = { ...windowsEnv({ files }, 'D:\\Work\\Repo\\.venv\\Scripts;C:\\Tools'), workspaceFolders: ['d:/work/repo/'] };
    assert.deepEqual(await resolveCswapExecutable('', env), { ok: true, path: 'C:\\Users\\dev\\.local\\bin\\cswap.exe', source: 'default-location' });
    const shimOnly: ResolverEnvironment = { ...windowsEnv({ files: ['D:\\Work\\Repo\\bin\\cswap.cmd'] }, 'D:\\Work\\Repo\\bin'), workspaceFolders: ['D:\\Work\\Repo'] };
    assert.deepEqual(await resolveCswapExecutable('', shimOnly), { ok: false, reason: 'not-found' }, 'a shim in the project is not even reported');
    const outside: ResolverEnvironment = { ...windowsEnv({ files: ['D:\\Work\\RepoTools\\cswap.exe'] }, 'D:\\Work\\RepoTools'), workspaceFolders: ['D:\\Work\\Repo'] };
    assert.equal((await resolveCswapExecutable('', outside)).ok, true, 'a sibling folder with a longer name is not inside');
  });

  it('rejects relative, missing, directory and shim settings without falling back to PATH', async () => {
    const env = windowsEnv({ files: ['C:\\Tools\\cswap.exe', 'D:\\apps\\cswap.bat'], dirs: ['D:\\apps'] });
    assert.deepEqual(await resolveCswapExecutable('cswap.exe', env), { ok: false, reason: 'setting-not-absolute', path: 'cswap.exe' });
    assert.equal((await resolveCswapExecutable('D:\\nope\\cswap.exe', env)).ok, false);
    assert.deepEqual(await resolveCswapExecutable('D:\\apps', env), { ok: false, reason: 'setting-not-a-file', path: 'D:\\apps' });
    assert.deepEqual(await resolveCswapExecutable('D:\\apps\\cswap.bat', env), { ok: false, reason: 'unsupported-shim', path: 'D:\\apps\\cswap.bat' });
  });
});

describe('resolveCswapExecutable — POSIX', () => {
  it('finds an executable cswap on PATH', async () => {
    const result = await resolveCswapExecutable('', posixEnv({ files: ['/usr/bin/cswap'] }));
    assert.deepEqual(result, { ok: true, path: '/usr/bin/cswap', source: 'path' });
  });

  it('skips files that are not executable', async () => {
    const result = await resolveCswapExecutable('', posixEnv({ files: ['/usr/bin/cswap'], executable: [] }));
    assert.deepEqual(result, { ok: false, reason: 'not-found' });
  });

  it('ignores empty PATH entries (current directory)', () => {
    assert.deepEqual(absolutePathEntries({ PATH: ':/usr/bin::./bin:/usr/bin' }, 'linux'), ['/usr/bin']);
  });

  it('skips PATH entries inside an open workspace folder', async () => {
    const env: ResolverEnvironment = { ...posixEnv({ files: ['/srv/app/.venv/bin/cswap', '/usr/bin/cswap'] }, '/srv/app/.venv/bin:/usr/bin'), workspaceFolders: ['/srv/app'] };
    assert.deepEqual(await resolveCswapExecutable('', env), { ok: true, path: '/usr/bin/cswap', source: 'path' });
  });
});

describe('pathEntriesOutsideFolders', () => {
  const win = { platform: 'win32' as const, homeDir: 'C:\\Users\\dev' };
  const linux = { platform: 'linux' as const, homeDir: '/home/dev' };

  it('drops the folder itself and everything inside it, nothing else', () => {
    const entries = ['/a/b', '/a/b/', '/a/b/.venv/bin', '/a/bc', '/a/bc/bin', '/a', '/usr/bin'];
    assert.deepEqual(pathEntriesOutsideFolders(entries, ['/a/b'], linux), ['/a/bc', '/a/bc/bin', '/a', '/usr/bin']);
    assert.deepEqual(pathEntriesOutsideFolders(entries, ['/a/b/'], linux), ['/a/bc', '/a/bc/bin', '/a', '/usr/bin'], 'a trailing separator on the folder');
    assert.deepEqual(pathEntriesOutsideFolders(['/a/./b/../b/bin'], ['/a/b'], linux), [], 'normalized first');
  });

  it('compares case-insensitively on Windows (and with either slash), case-sensitively on Linux', () => {
    const entries = ['C:\\Work\\Repo\\.venv\\Scripts', 'c:/work/repo/node_modules/.bin', 'C:\\Work\\Repository', 'C:\\Windows\\System32'];
    assert.deepEqual(pathEntriesOutsideFolders(entries, ['c:\\WORK\\repo\\'], win), ['C:\\Work\\Repository', 'C:\\Windows\\System32']);
    assert.deepEqual(pathEntriesOutsideFolders(['/Work/Repo/bin'], ['/work/repo'], linux), ['/Work/Repo/bin']);
  });

  it('does not use folders that hold the home folder (home, its parents, a root) or are not absolute', () => {
    const entries = ['C:\\Users\\dev\\.local\\bin', 'C:\\Users\\dev\\proj\\bin', 'C:\\Windows'];
    assert.deepEqual(pathEntriesOutsideFolders(entries, ['C:\\Users\\dev', 'C:\\Users', 'C:\\', 'relative', ''], win), entries);
    assert.deepEqual(pathEntriesOutsideFolders(entries, ['C:\\Users\\dev\\proj'], win), ['C:\\Users\\dev\\.local\\bin', 'C:\\Windows'], 'a project below home still counts');
    assert.deepEqual(pathEntriesOutsideFolders(['/home/dev/.local/bin'], ['/', '/home', '/home/dev/'], linux), ['/home/dev/.local/bin']);
  });

  it('isSameOrInside', () => {
    assert.equal(isSameOrInside('/a/b', '/a/b', 'linux'), true);
    assert.equal(isSameOrInside('/a/b/c', '/a/b', 'linux'), true);
    assert.equal(isSameOrInside('/a/bc', '/a/b', 'linux'), false);
    assert.equal(isSameOrInside('/anything', '/', 'linux'), true);
    assert.equal(isSameOrInside('D:\\x', 'd:\\', 'win32'), true);
    assert.equal(isSameOrInside('D:\\x', 'C:\\', 'win32'), false);
  });
});

describe('CachedExecutableResolver', () => {
  it('caches success, does not cache failure, and re-resolves after invalidate()', async () => {
    let calls = 0;
    const files: string[] = [];
    const env = windowsEnv({});
    const counting: ResolverEnvironment = {
      ...env,
      statKind: (candidate) => {
        calls++;
        return Promise.resolve(files.includes(candidate) ? 'file' : undefined);
      },
    };
    const resolver = new CachedExecutableResolver(() => '', counting);

    assert.equal((await resolver.resolve()).ok, false);
    files.push('C:\\Tools\\cswap.exe');
    assert.equal((await resolver.resolve()).ok, true, 'failure was not cached');

    const before = calls;
    await resolver.resolve();
    assert.equal(calls, before, 'success is cached');

    resolver.invalidate();
    await resolver.resolve();
    assert.ok(calls > before);
  });
});
