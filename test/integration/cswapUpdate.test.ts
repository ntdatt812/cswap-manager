/**
 * The cswap update flow in the extension host, with fakes only: no uv or pipx is started, cswap is
 * a fake and nothing is fetched from PyPI. The terminal test runs the host's own Node executable.
 */
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CliOutcome } from '../../src/core/cli/cswapCli';
import type { ExecutableResolution, ResolverEnvironment } from '../../src/core/cli/executableResolver';
import { PausableRunner } from '../../src/core/cli/pausableRunner';
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../../src/core/cli/processRunner';
import { parseCliVersion, type CliVersion } from '../../src/core/cli/version';
import { OperationGate } from '../../src/core/service/operationGate';
import type { RefreshResult } from '../../src/core/service/refreshService';
import { CswapUpdateCheck } from '../../src/vscode/cswapUpdateCheck';
import { ProgramTerminal } from '../../src/vscode/programTerminal';

const RUNNING_KEY = 'cswapManager.cswapUpdate.running';
const windows = process.platform === 'win32';
const home = path.join(os.tmpdir(), 'cswap-update-fake-home');
const exe = (name: string) => (windows ? `${name}.exe` : name);
const launcher = path.join(home, '.local', 'bin', exe('cswap'));
const uv = path.join(home, '.local', 'bin', exe('uv'));
const appData = path.join(home, 'AppData', 'Roaming');
const uvTools = windows ? path.join(appData, 'uv', 'tools', 'claude-swap') : path.join(home, '.local', 'share', 'uv', 'tools', 'claude-swap');
const pipxVenv = path.join(home, '.local', 'pipx', 'venvs', 'claude-swap');

const version = (text: string): CliVersion => {
  const parsed = parseCliVersion(text);
  assert.ok(parsed);
  return parsed;
};

function environment(dirs: string[]): ResolverEnvironment {
  const comparable = (candidate: string) => (windows ? candidate.toLowerCase() : candidate);
  const known = new Set(dirs.map(comparable));
  return {
    platform: process.platform,
    env: { PATH: '', APPDATA: appData },
    homeDir: home,
    statKind: (candidate) => Promise.resolve(comparable(candidate) === comparable(uv) ? 'file' : known.has(comparable(candidate)) ? 'directory' : undefined),
    isExecutable: () => Promise.resolve(true),
  };
}

class Memento {
  private readonly values = new Map<string, unknown>();
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
  get<T>(key: string, fallback?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : fallback;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
    return Promise.resolve();
  }
  setKeysForSync(): void {}
}

interface Shown {
  readonly level: 'info' | 'warning';
  readonly message: string;
  readonly buttons: string[];
}

/** Records notifications instead of showing them (no button is picked). */
function captureMessages(): { shown: Shown[]; restore(): void } {
  const window = vscode.window as unknown as Record<'showInformationMessage' | 'showWarningMessage', (...args: unknown[]) => Thenable<unknown>>;
  const originals = { info: window.showInformationMessage, warning: window.showWarningMessage };
  const shown: Shown[] = [];
  const record = (level: Shown['level']) => (message: unknown, ...rest: unknown[]) => {
    shown.push({ level, message: String(message), buttons: rest.filter((item): item is string => typeof item === 'string') });
    return Promise.resolve(undefined);
  };
  window.showInformationMessage = record('info');
  window.showWarningMessage = record('warning');
  return {
    shown,
    restore: () => {
      window.showInformationMessage = originals.info;
      window.showWarningMessage = originals.warning;
    },
  };
}

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ProcessRunOptions;
  readonly gateBusy: boolean;
  readonly cswapPaused: boolean;
}

function fixture(options: { automatic?: boolean; result?: ProcessResult; dirs?: string[]; versions?: string[] } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const versions = [...(options.versions ?? ['1.2.0', '1.3.0'])];
  let invalidations = 0;
  let refreshes = 0;
  const gate = new OperationGate();
  const cswapRunner = new PausableRunner({ run: () => Promise.reject(new Error('cswap is a fake here')) });
  const globalState = new Memento();
  const runner: ProcessRunner = {
    run: (file, args, runOptions) => {
      calls.push({ file, args, options: runOptions, gateBusy: gate.isBusy(), cswapPaused: cswapRunner.isPaused() });
      return Promise.resolve(options.result ?? { kind: 'exited', exitCode: 0, signal: null, stdout: '', stderr: 'Updated claude-swap v1.2.0 -> v1.3.0', durationMs: 3 });
    },
  };
  const check = new CswapUpdateCheck({
    context: { globalState },
    cli: {
      version: () => {
        const next = versions.length > 1 ? versions.shift() : versions[0];
        return Promise.resolve({ ok: true, value: version(next ?? '0.0.0'), meta: { command: 'version' } } as unknown as CliOutcome<CliVersion>);
      },
    },
    resolver: {
      resolve: () => Promise.resolve({ ok: true, path: launcher, source: 'path' } satisfies ExecutableResolution),
      invalidate: () => {
        invalidations += 1;
      },
    },
    environment: environment(options.dirs ?? [uvTools]),
    gate,
    cswapRunner,
    refreshService: {
      refresh: () => {
        refreshes += 1;
        return Promise.resolve({ ok: false } as unknown as RefreshResult);
      },
    },
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
    homeDir: home,
    enabled: () => true,
    automatic: () => options.automatic ?? true,
    runner,
    fetchLatest: () => Promise.resolve(version('1.3.0')),
  });
  return { check, calls, logs, globalState, gate, cswapRunner, counts: () => ({ invalidations, refreshes }) };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await pause(20);
  }
  return predicate();
}

suite('cswap update (fakes, extension host)', () => {
  let messages: ReturnType<typeof captureMessages>;

  setup(() => {
    messages = captureMessages();
  });

  teardown(() => {
    messages.restore();
  });

  test('updates in the background with the located uv, then confirms the new version', async () => {
    const { check, calls, logs, globalState, gate, cswapRunner, counts } = fixture();
    const state = await check.check(true);
    assert.equal(state.latest?.text, '1.3.0');
    assert.ok(await waitFor(() => messages.shown.length > 0));
    assert.deepEqual(messages.shown, [{ level: 'info', message: 'cswap was updated: 1.2.0 → 1.3.0.', buttons: [] }]);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.file, uv, 'the absolute program that was located');
    assert.deepEqual(call.args, ['tool', 'upgrade', 'claude-swap']);
    assert.equal(call.options.cwd, home);
    assert.equal(call.options.timeoutMs, 5 * 60_000);
    assert.equal(call.options.env?.['NoDefaultCurrentDirectoryInExePath'], windows ? '1' : undefined);
    assert.equal(call.options.env?.['ELECTRON_RUN_AS_NODE'], undefined);
    assert.ok(call.gateBusy, 'inside the operation gate');
    assert.ok(call.cswapPaused, 'cswap commands held');
    assert.deepEqual(counts(), { invalidations: 1, refreshes: 1 });
    assert.equal(check.getState().current?.text, '1.3.0');
    assert.equal(globalState.get(RUNNING_KEY), undefined, 'the marker is cleared');
    assert.equal(gate.isBusy(), false);
    assert.equal(cswapRunner.isPaused(), false);
    assert.ok(logs.every((line) => !line.includes('Updated claude-swap')), 'no installer output in the log');
  });

  test('reports a failure with the exit code and a redacted line, offering Try again and Open in terminal', async () => {
    const stderr = 'Resolved 4 packages\nerror: failed to replace cswap.exe of dev@example.com: Access is denied. (os error 5)\n';
    const { check, calls, logs, counts } = fixture({ result: { kind: 'exited', exitCode: 2, signal: null, stdout: '', stderr, durationMs: 3 } });
    await check.check(true);
    assert.ok(await waitFor(() => messages.shown.length > 0));
    const [shown] = messages.shown;
    assert.ok(shown);
    assert.equal(shown.level, 'warning');
    assert.match(shown.message, /^cswap was not updated: uv exited with code 2: error: failed to replace cswap\.exe of <email>: Access is denied\. \(os error 5\)/);
    assert.equal(shown.message.includes('cswap run'), windows, 'the lock hint on Windows');
    assert.deepEqual(shown.buttons, ['Try again', 'Open in terminal']);
    assert.equal(calls.length, 1);
    assert.deepEqual(counts(), { invalidations: 0, refreshes: 0 });
    assert.ok(logs.every((line) => !line.includes('dev@example.com') && !line.includes('Resolved 4 packages')));
  });

  test('says so when the installer succeeds but cswap still reports the old version', async () => {
    const { check } = fixture({ versions: ['1.2.0', '1.2.0'] });
    await check.check(true);
    assert.ok(await waitFor(() => messages.shown.length > 0));
    assert.equal(messages.shown[0]?.message, 'uv finished, but cswap still reports 1.2.0.');
    assert.equal(messages.shown[0]?.level, 'warning');
  });

  test('asks first when automatic updates are off', async () => {
    const { check, calls } = fixture({ automatic: false });
    await check.check(true);
    assert.ok(await waitFor(() => messages.shown.length > 0));
    assert.deepEqual(messages.shown, [{ level: 'info', message: 'cswap 1.3.0 is available (you have 1.2.0).', buttons: ['Update', 'Skip this version'] }]);
    assert.equal(calls.length, 0);
  });

  test('leaves the update to another window that is running one', async () => {
    const { check, calls, globalState } = fixture();
    await globalState.update(RUNNING_KEY, Date.now());
    await check.check(true);
    assert.ok(await waitFor(() => messages.shown.length > 0));
    assert.deepEqual(messages.shown, [{ level: 'info', message: 'cswap is being updated in another window.', buttons: [] }]);
    assert.equal(calls.length, 0);
  });

  test('"Open in terminal" starts the program itself and keeps its terminal open after it exits', async () => {
    const view = new ProgramTerminal('Cswap test: program terminal');
    try {
      view.terminal.show(true);
      view.writeLine('header');
      // The extension host's own executable runs as Node with ELECTRON_RUN_AS_NODE.
      const end = await view.run(process.execPath, ['-e', 'console.log("output"); process.exit(3)'], { cwd: os.tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      assert.deepEqual(end, { kind: 'exited', code: 3 });
      await pause(200);
      assert.equal(view.terminal.exitStatus, undefined, 'still open');
      assert.ok(vscode.window.terminals.includes(view.terminal));
      const missing = await view.run(path.join(home, 'no-such-program'), [], { cwd: os.tmpdir(), env: process.env });
      assert.equal(missing.kind, 'not-started');
    } finally {
      view.dispose();
    }
  });

  test('gives the command to run by hand when uv and pipx both hold claude-swap', async () => {
    const { check, calls } = fixture({ dirs: [uvTools, pipxVenv] });
    await check.check(true);
    assert.ok(await waitFor(() => messages.shown.length > 0));
    const [shown] = messages.shown;
    assert.equal(shown?.message, 'cswap 1.3.0 is available (you have 1.2.0). Update cswap with the tool you installed it with, for example "uv tool upgrade claude-swap".');
    assert.deepEqual(shown?.buttons, ['Skip this version']);
    assert.equal(calls.length, 0);
  });
});
