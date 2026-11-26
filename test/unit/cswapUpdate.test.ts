import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  UPGRADE_ARGS,
  decideUpdate,
  describeUpgradeFailure,
  installedWith,
  planCswapUpgrade,
  upgradeEnvironment,
  upgradeProcessOutcome,
  upgradeRunningElsewhere,
  verifyUpgrade,
  type UpgradeTool,
} from '../../src/core/cli/cswapUpdate';
import type { ResolverEnvironment } from '../../src/core/cli/executableResolver';
import { PausableRunner } from '../../src/core/cli/pausableRunner';
import { NodeProcessRunner, type ProcessResult, type ProcessRunOptions, type ProcessRunner } from '../../src/core/cli/processRunner';
import { parseCliVersion, releaseLine, upgradeTested, type CliVersion } from '../../src/core/cli/version';
import { OperationGate } from '../../src/core/service/operationGate';

const version = (text: string): CliVersion => {
  const parsed = parseCliVersion(text);
  assert.ok(parsed);
  return parsed;
};

/** A Windows machine where only `files` and `dirs` exist (paths compared case-insensitively). */
function windowsEnv(options: { files?: string[]; dirs?: string[]; env?: Record<string, string>; workspaceFolders?: string[] } = {}): ResolverEnvironment {
  const files = new Set((options.files ?? []).map((file) => file.toLowerCase()));
  const dirs = new Set((options.dirs ?? []).map((dir) => dir.toLowerCase()));
  return {
    platform: 'win32',
    env: { Path: 'C:\\Windows\\System32', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', ...options.env },
    homeDir: 'C:\\Users\\dev',
    ...(options.workspaceFolders === undefined ? {} : { workspaceFolders: options.workspaceFolders }),
    statKind: (candidate) => Promise.resolve(files.has(candidate.toLowerCase()) ? 'file' : dirs.has(candidate.toLowerCase()) ? 'directory' : undefined),
    isExecutable: () => Promise.resolve(true),
  };
}

function posixEnv(options: { files?: string[]; dirs?: string[]; env?: Record<string, string> } = {}): ResolverEnvironment {
  const files = new Set(options.files ?? []);
  const dirs = new Set(options.dirs ?? []);
  return {
    platform: 'linux',
    env: { PATH: '/usr/bin', ...options.env },
    homeDir: '/home/dev',
    statKind: (candidate) => Promise.resolve(files.has(candidate) ? 'file' : dirs.has(candidate) ? 'directory' : undefined),
    isExecutable: (candidate) => Promise.resolve(files.has(candidate)),
  };
}

const UV_TOOLS_WIN = 'C:\\Users\\dev\\AppData\\Roaming\\uv\\tools\\claude-swap';
const LAUNCHER_WIN = 'C:\\Users\\dev\\.local\\bin\\cswap.exe';
const UV_WIN = 'C:\\Users\\dev\\.local\\bin\\uv.exe';

describe('cswap upgrade plan', () => {
  it('sees which installer holds claude-swap from its tool folders (overrides included, relative ones ignored)', async () => {
    assert.deepEqual(await installedWith(windowsEnv({ dirs: [UV_TOOLS_WIN] })), { uv: true, pipx: false });
    assert.deepEqual(await installedWith(windowsEnv({ dirs: ['C:\\Users\\dev\\pipx\\venvs\\claude-swap'] })), { uv: false, pipx: true });
    assert.deepEqual(await installedWith(windowsEnv({ dirs: ['D:\\uvtools\\claude-swap'], env: { uv_tool_dir: 'D:\\uvtools' } })), { uv: true, pipx: false }, 'Windows variables ignore case');
    assert.deepEqual(await installedWith(windowsEnv({ dirs: ['uvtools\\claude-swap'], env: { UV_TOOL_DIR: 'uvtools' } })), { uv: false, pipx: false }, 'relative folder');
    assert.deepEqual(await installedWith(posixEnv({ dirs: ['/home/dev/.local/share/uv/tools/claude-swap', '/home/dev/.local/share/pipx/venvs/claude-swap'] })), { uv: true, pipx: true });
    assert.deepEqual(await installedWith(posixEnv({ dirs: ['/data/pipx/venvs/claude-swap'], env: { PIPX_HOME: '/data/pipx' } })), { uv: false, pipx: true });
    assert.deepEqual(await installedWith(posixEnv({ dirs: ['/xdg/uv/tools/claude-swap'], env: { XDG_DATA_HOME: '/xdg' } })), { uv: true, pipx: false });
  });

  it('runs the located absolute uv / pipx with the fixed arguments', async () => {
    const located: UpgradeTool[] = [];
    const locate = (tool: UpgradeTool) => {
      located.push(tool);
      return Promise.resolve(tool === 'uv' ? UV_WIN : undefined);
    };
    assert.deepEqual(await planCswapUpgrade(LAUNCHER_WIN, windowsEnv({ dirs: [UV_TOOLS_WIN] }), locate), {
      kind: 'run',
      step: { tool: 'uv', program: UV_WIN, args: ['tool', 'upgrade', 'claude-swap'] },
    });
    assert.deepEqual(await planCswapUpgrade('/home/dev/.local/pipx/venvs/claude-swap/bin/cswap', posixEnv(), () => Promise.resolve('/home/dev/.local/bin/pipx')), {
      kind: 'run',
      step: { tool: 'pipx', program: '/home/dev/.local/bin/pipx', args: UPGRADE_ARGS.pipx },
    });
    assert.deepEqual(located, ['uv']);
  });

  it('falls back to instructions when the installer is ambiguous, unknown or not found', async () => {
    let calls = 0;
    const never = () => {
      calls += 1;
      return Promise.resolve(UV_WIN);
    };
    assert.deepEqual(await planCswapUpgrade(undefined, windowsEnv(), never), { kind: 'manual' }, 'cswap not found');
    assert.deepEqual(await planCswapUpgrade(LAUNCHER_WIN, windowsEnv({ dirs: [UV_TOOLS_WIN, 'C:\\Users\\dev\\pipx\\venvs\\claude-swap'] }), never), { kind: 'manual' }, 'ambiguous');
    assert.deepEqual(await planCswapUpgrade('D:\\tools\\cswap.exe', windowsEnv({ dirs: [UV_TOOLS_WIN] }), never), { kind: 'manual' }, 'own location');
    assert.equal(calls, 0, 'nothing is located without a known installer');
    const env = windowsEnv({ dirs: [UV_TOOLS_WIN] });
    assert.deepEqual(await planCswapUpgrade(LAUNCHER_WIN, env, () => Promise.resolve(undefined)), { kind: 'manual', tool: 'uv' }, 'uv not found');
    assert.deepEqual(await planCswapUpgrade(LAUNCHER_WIN, env, () => Promise.resolve('uv.exe')), { kind: 'manual', tool: 'uv' }, 'a bare name is never run');
  });

  it('never runs a uv from an open project, even when it comes first on PATH', async () => {
    const projectUv = 'D:\\project\\.venv\\Scripts\\uv.exe';
    const env = windowsEnv({
      files: [projectUv, UV_WIN],
      dirs: [UV_TOOLS_WIN],
      env: { Path: 'D:\\project\\.venv\\Scripts;.\\bin;C:\\Windows\\System32' },
      workspaceFolders: ['D:\\project'],
    });
    const plan = await planCswapUpgrade(LAUNCHER_WIN, env);
    assert.deepEqual(plan, { kind: 'run', step: { tool: 'uv', program: UV_WIN, args: UPGRADE_ARGS.uv } }, 'found in ~/.local/bin instead');
  });
});

describe('cswap update decision', () => {
  const base = { current: version('1.2.0'), latest: version('1.2.1'), automatic: true, requested: false, skipped: undefined };

  it('updates right away when automatic updates are on, even a skipped version', () => {
    assert.equal(decideUpdate(base), 'upgrade');
    assert.equal(decideUpdate({ ...base, skipped: '1.2.1' }), 'upgrade');
    assert.equal(decideUpdate({ ...base, requested: true }), 'upgrade');
    assert.equal(decideUpdate({ ...base, current: version('1.1.4'), latest: version('1.2.0') }), 'upgrade', 'to a tested line');
  });

  it('offers otherwise, unless the user skipped this version and did not ask', () => {
    const manual = { ...base, automatic: false };
    assert.equal(decideUpdate(manual), 'offer');
    assert.equal(decideUpdate({ ...manual, skipped: '1.2.1' }), 'none');
    assert.equal(decideUpdate({ ...manual, skipped: '1.2.1', requested: true }), 'offer');
    assert.equal(decideUpdate({ ...manual, skipped: '1.2.0' }), 'offer', 'an older skip does not hide a newer release');
  });

  it('only offers a release line the extension was not tested with, also when automatic', () => {
    for (const latest of ['1.3.0', '2.0.0']) {
      const untested = { ...base, latest: version(latest) };
      assert.equal(decideUpdate(untested), 'offer', latest);
      assert.equal(decideUpdate({ ...untested, skipped: latest }), 'none', `${latest} skipped`);
      assert.equal(decideUpdate({ ...untested, skipped: latest, requested: true }), 'offer', `${latest} asked for`);
    }
  });

  it('updates a patch of the line already in use, tested or not', () => {
    assert.equal(decideUpdate({ ...base, current: version('1.3.0'), latest: version('1.3.1') }), 'upgrade');
    assert.equal(decideUpdate({ ...base, current: version('1.3.0'), latest: version('1.4.0') }), 'offer');
  });

  it('names release lines and knows which moves are tested', () => {
    assert.equal(releaseLine(version('1.3.7')), '1.3');
    assert.equal(upgradeTested(version('1.2.0'), version('1.2.9')), true);
    assert.equal(upgradeTested(version('1.1.0'), version('1.2.0')), true);
    assert.equal(upgradeTested(version('1.2.0'), version('1.3.0')), false);
    assert.equal(upgradeTested(version('1.2.0'), version('2.0.0')), false);
  });

  it('does nothing when there is nothing newer or a version is unknown', () => {
    assert.equal(decideUpdate({ ...base, latest: version('1.2.0') }), 'none');
    assert.equal(decideUpdate({ ...base, latest: version('1.1.9') }), 'none');
    assert.equal(decideUpdate({ ...base, current: undefined }), 'none');
    assert.equal(decideUpdate({ ...base, latest: undefined }), 'none');
  });
});

describe('cswap upgrade result', () => {
  const exited = (exitCode: number | null, stderr = ''): ProcessResult => ({ kind: 'exited', exitCode, signal: null, stdout: 'raw stdout', stderr, durationMs: 5 });

  it('keeps only the exit code and one redacted, link-free line of stderr', () => {
    assert.deepEqual(upgradeProcessOutcome(exited(0, 'Updated claude-swap'), 'C:\\Users\\dev'), { ok: true });
    const stderr = 'Resolved 3 packages\nerror: failed to remove C:\\Users\\dev\\.local\\bin\\cswap.exe for dev@example.com, see [docs](https://example.com)\n';
    const outcome = upgradeProcessOutcome(exited(2, stderr), 'C:\\Users\\dev');
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.failure.kind === 'exited');
    assert.equal(outcome.failure.exitCode, 2);
    const detail = outcome.failure.detail ?? '';
    assert.match(detail, /^error: failed to remove ~\\\.local\\bin\\cswap\.exe/);
    assert.ok(!detail.includes('dev@example.com'), 'email redacted');
    assert.ok(!detail.includes('Resolved'), 'last line only');
    assert.ok(!/\]\(|https:/.test(detail), 'links neutralised');
    assert.deepEqual(upgradeProcessOutcome(exited(1), 'C:\\Users\\dev'), { ok: false, failure: { kind: 'exited', exitCode: 1 } });
  });

  it('names timeouts, output overruns and programs that could not start', () => {
    const failed = (failure: 'timeout' | 'output-limit' | 'not-found' | 'permission-denied', errorCode?: string): ProcessResult => ({
      kind: 'failed',
      failure,
      ...(errorCode === undefined ? {} : { errorCode }),
      stderr: '',
      durationMs: 1,
    });
    assert.deepEqual(upgradeProcessOutcome(failed('timeout'), '/home/dev'), { ok: false, failure: { kind: 'timeout' } });
    assert.deepEqual(upgradeProcessOutcome(failed('output-limit'), '/home/dev'), { ok: false, failure: { kind: 'output-limit' } });
    assert.deepEqual(upgradeProcessOutcome(failed('not-found', 'ENOENT'), '/home/dev'), { ok: false, failure: { kind: 'not-started', errorCode: 'ENOENT' } });
    assert.deepEqual(upgradeProcessOutcome(failed('permission-denied'), '/home/dev'), { ok: false, failure: { kind: 'not-started' } });
  });

  it('reads a real failing program through the runner without a shell', async () => {
    const script = 'process.stdout.write("stdout"); process.stderr.write("step 1\\nerror: Access is denied. (os error 5)\\n"); process.exit(2)';
    const result = await new NodeProcessRunner().run(process.execPath, ['-e', script], { timeoutMs: 10_000, maxOutputBytes: 1024 });
    assert.deepEqual(upgradeProcessOutcome(result, '/home/dev'), { ok: false, failure: { kind: 'exited', exitCode: 2, detail: 'error: Access is denied. (os error 5)' } });
  });

  it('confirms the new version after a successful run', () => {
    const target = version('1.3.0');
    assert.deepEqual(verifyUpgrade(version('1.3.0'), target), { ok: true });
    assert.deepEqual(verifyUpgrade(version('1.3.1'), target), { ok: true }, 'a newer release came out meanwhile');
    assert.deepEqual(verifyUpgrade(version('1.2.0'), target), { ok: false, failure: { kind: 'unchanged', version: '1.2.0' } });
    assert.deepEqual(verifyUpgrade(undefined, target), { ok: false, failure: { kind: 'unverified' } });
  });

  it('logs the kind, exit code and redacted detail only', () => {
    assert.equal(describeUpgradeFailure({ kind: 'exited', exitCode: 2, detail: 'error: denied' }), 'exited (exit 2) — error: denied');
    assert.equal(describeUpgradeFailure({ kind: 'exited', exitCode: null }), 'exited (exit null)');
    assert.equal(describeUpgradeFailure({ kind: 'not-started', errorCode: 'ENOENT' }), 'not started (ENOENT)');
    assert.equal(describeUpgradeFailure({ kind: 'unchanged', version: '1.2.0' }), 'cswap still reports 1.2.0');
    assert.equal(describeUpgradeFailure({ kind: 'busy' }), 'busy');
  });

  it('runs the installer without the extension host variable, and on Windows without searching the current folder', () => {
    const base = { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' };
    const windows = upgradeEnvironment(base, 'win32');
    assert.equal(windows['ELECTRON_RUN_AS_NODE'], undefined);
    assert.equal(windows['NoDefaultCurrentDirectoryInExePath'], '1');
    assert.equal(windows['NO_COLOR'], '1');
    assert.equal(windows['PATH'], '/usr/bin');
    assert.equal(upgradeEnvironment(base, 'linux')['NoDefaultCurrentDirectoryInExePath'], undefined);
  });

  it('lets one window update at a time, forgetting a record left by a window that closed', () => {
    const now = 1_000_000_000;
    const stale = 10 * 60_000;
    assert.equal(upgradeRunningElsewhere(undefined, now, stale), false);
    assert.equal(upgradeRunningElsewhere('soon', now, stale), false);
    assert.equal(upgradeRunningElsewhere(now - 60_000, now, stale), true);
    assert.equal(upgradeRunningElsewhere(now - stale, now, stale), false);
    assert.equal(upgradeRunningElsewhere(now + 24 * 60 * 60_000, now, stale), false, 'a record dated in the future');
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Each run waits until the test ends it; `started` lists the files in start order. */
class ControlledRunner implements ProcessRunner {
  readonly started: string[] = [];
  private readonly pending = new Map<string, Deferred<ProcessResult>>();

  run(file: string, _args: readonly string[], _options: ProcessRunOptions): Promise<ProcessResult> {
    this.started.push(file);
    const run = deferred<ProcessResult>();
    this.pending.set(file, run);
    return run.promise;
  }

  end(file: string): void {
    this.pending.get(file)?.resolve({ kind: 'exited', exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1 });
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const runOptions: ProcessRunOptions = { timeoutMs: 1000, maxOutputBytes: 1024 };

describe('PausableRunner', () => {
  it('lets running cswap commands finish, holds new ones while paused, then starts them', async () => {
    const inner = new ControlledRunner();
    const runner = new PausableRunner(inner);
    const events: string[] = [];
    const first = runner.run('list', [], runOptions);
    await tick();
    const paused = runner.pauseWhile(async (drained) => {
      events.push(`work (drained ${drained})`);
      await tick();
      events.push('work done');
    }, 1000);
    await tick();
    assert.equal(runner.isPaused(), true);
    const held = runner.run('status', [], runOptions).then(() => events.push('status done'));
    await tick();
    assert.deepEqual(events, [], 'the work waits for the running command');
    assert.deepEqual(inner.started, ['list'], 'the held command has not started');
    inner.end('list');
    await paused;
    await tick();
    assert.deepEqual(inner.started, ['list', 'status'], 'started once the pause ended');
    inner.end('status');
    await Promise.all([first, held]);
    assert.deepEqual(events, ['work (drained true)', 'work done', 'status done']);
    assert.equal(runner.isPaused(), false);
  });

  it('gives a running command a bounded time to finish', async () => {
    const inner = new ControlledRunner();
    const runner = new PausableRunner(inner);
    void runner.run('slow', [], runOptions);
    await tick();
    assert.equal(await runner.pauseWhile((drained) => Promise.resolve(drained), 20), false);
    inner.end('slow');
  });

  it('cancels a held command whose signal aborts, without starting it', async () => {
    const inner = new ControlledRunner();
    const runner = new PausableRunner(inner);
    const work = deferred<void>();
    const paused = runner.pauseWhile(() => work.promise, 1000);
    const controller = new AbortController();
    const held = runner.run('list', [], { ...runOptions, signal: controller.signal });
    controller.abort();
    const result = await held;
    assert.equal(result.kind === 'failed' ? result.failure : result.kind, 'cancelled');
    work.resolve();
    await paused;
    assert.deepEqual(inner.started, []);
  });

  it('stays paused until overlapping pauses have all ended', async () => {
    const inner = new ControlledRunner();
    const runner = new PausableRunner(inner);
    const a = deferred<void>();
    const b = deferred<void>();
    const first = runner.pauseWhile(() => a.promise, 1000);
    const second = runner.pauseWhile(() => b.promise, 1000);
    const held = runner.run('list', [], runOptions);
    a.resolve();
    await first;
    await tick();
    assert.deepEqual(inner.started, []);
    b.resolve();
    await second;
    await tick();
    assert.deepEqual(inner.started, ['list']);
    inner.end('list');
    await held;
  });
});

describe('OperationGate.runWhenFree', () => {
  it('runs at once when free, after the running operation otherwise', async () => {
    const gate = new OperationGate();
    assert.equal(await gate.runWhenFree(() => Promise.resolve('now'), 1000), 'now');
    const switching = deferred<void>();
    const events: string[] = [];
    const running = gate.run(async () => {
      await switching.promise;
      events.push('switch done');
    });
    const waiting = gate.runWhenFree(() => {
      events.push('update');
      return Promise.resolve('updated');
    }, 1000);
    await tick();
    assert.deepEqual(events, []);
    switching.resolve();
    await running;
    assert.equal(await waiting, 'updated');
    assert.deepEqual(events, ['switch done', 'update']);
    assert.equal(gate.isBusy(), false);
  });

  it('gives up without running when the gate stays busy', async () => {
    const gate = new OperationGate();
    const switching = deferred<void>();
    const running = gate.run(() => switching.promise);
    let ran = false;
    const result = await gate.runWhenFree(() => {
      ran = true;
      return Promise.resolve();
    }, 20);
    assert.equal(result, undefined);
    assert.equal(ran, false);
    switching.resolve();
    await running;
  });
});
