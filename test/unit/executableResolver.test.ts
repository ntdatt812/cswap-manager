import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CachedExecutableResolver,
  absolutePathEntries,
  resolveCswapExecutable,
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
