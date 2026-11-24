import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CswapCli, type CommandMeta } from '../../src/core/cli/cswapCli';
import type { CliError } from '../../src/core/cli/cliErrors';
import type { ExecutableResolution } from '../../src/core/cli/executableResolver';
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../../src/core/cli/processRunner';
import { fixture } from '../helpers/fixtures';

interface Call {
  file: string;
  args: readonly string[];
  options: ProcessRunOptions;
}

class FakeRunner implements ProcessRunner {
  readonly calls: Call[] = [];
  constructor(private readonly respond: (args: readonly string[]) => ProcessResult) {}
  run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ file, args, options });
    return Promise.resolve(this.respond(args));
  }
}

const exited = (stdout: string, exitCode = 0, stderr = ''): ProcessResult => ({
  kind: 'exited',
  exitCode,
  signal: null,
  stdout,
  stderr,
  durationMs: 12,
});

const EXE = 'C:\\Users\\dev\\.local\\bin\\cswap.exe';

function makeCli(runner: ProcessRunner, resolution: ExecutableResolution = { ok: true, path: EXE, source: 'path' }) {
  const finished: Array<{ meta: CommandMeta; error?: CliError }> = [];
  let missing = 0;
  const cli = new CswapCli({
    runner,
    resolveExecutable: () => Promise.resolve(resolution),
    onExecutableMissing: () => missing++,
    settings: () => ({ timeoutMs: 5000, maxOutputBytes: 4096 }),
    workingDirectory: 'C:\\Users\\dev',
    baseEnv: { PATH: 'C:\\Windows' },
    homeDir: 'C:\\Users\\dev',
    onCommandFinished: (meta, error) => finished.push(error === undefined ? { meta } : { meta, error }),
  });
  return { cli, finished, missingCount: () => missing };
}

describe('CswapCli', () => {
  it('invokes fixed argument arrays with bounded, shell-free options', async () => {
    const runner = new FakeRunner((args) =>
      args[0] === '--version' ? exited('cswap 1.1.0\n') : args[0] === 'list' ? exited(fixture('list-v1.json')) : exited(fixture('status-v1.json')),
    );
    const { cli } = makeCli(runner);
    assert.ok((await cli.version()).ok);
    assert.ok((await cli.list()).ok);
    assert.ok((await cli.status()).ok);

    assert.deepEqual(
      runner.calls.map((call) => call.args),
      [['--version'], ['list', '--json'], ['status', '--json']],
    );
    for (const call of runner.calls) {
      assert.equal(call.file, EXE);
      assert.equal(call.options.timeoutMs, 5000);
      assert.equal(call.options.maxOutputBytes, 4096);
      assert.equal(call.options.cwd, 'C:\\Users\\dev');
      assert.equal(call.options.env?.NO_COLOR, '1');
      assert.equal(call.options.env?.PYTHONIOENCODING, 'utf-8');
      assert.equal(call.options.env?.PATH, 'C:\\Windows');
    }
  });

  it('parses the version', async () => {
    const { cli } = makeCli(new FakeRunner(() => exited('cswap 1.1.0\n')));
    const outcome = await cli.version();
    assert.ok(outcome.ok);
    assert.equal(outcome.value.text, '1.1.0');
  });

  it('surfaces a stderr notice on success, redacted', async () => {
    const { cli } = makeCli(new FakeRunner(() => exited(fixture('list-v1.json'), 0, '\u001b[38;5;250mA newer version (1.2.0) for bob@example.com\u001b[0m\n')));
    const outcome = await cli.list();
    assert.ok(outcome.ok);
    assert.equal(outcome.meta.stderrNotice, 'A newer version (1.2.0) for <email>');
  });

  it('maps non-zero exit codes with a redacted last stderr line', async () => {
    const { cli, finished } = makeCli(
      new FakeRunner(() => exited('', 2, 'usage: cswap <command>\ncswap: error: unknown bob@example.com at C:\\Users\\dev\\x\n')),
    );
    const outcome = await cli.list();
    assert.ok(!outcome.ok);
    assert.equal(outcome.error.kind, 'non-zero-exit');
    assert.equal(outcome.error.exitCode, 2);
    assert.equal(outcome.error.detail, 'cswap: error: unknown <email> at ~\\x');
    assert.equal(finished[0]?.error?.kind, 'non-zero-exit');
  });

  it('maps malformed JSON and unexpected shapes', async () => {
    const malformed = makeCli(new FakeRunner(() => exited('{oops')));
    const outcome = await malformed.cli.list();
    assert.equal(outcome.ok ? 'ok' : outcome.error.kind, 'invalid-output');

    const shape = makeCli(new FakeRunner(() => exited('{"schemaVersion":1}')));
    const shaped = await shape.cli.list();
    assert.equal(shaped.ok ? 'ok' : shaped.error.kind, 'unexpected-shape');
  });

  it('maps an unrecognized version string', async () => {
    const { cli } = makeCli(new FakeRunner(() => exited('cswap dev-build')));
    const outcome = await cli.version();
    assert.equal(outcome.ok ? 'ok' : outcome.error.kind, 'invalid-output');
  });

  it('maps process failures and invalidates the executable on not-found', async () => {
    const cases: Array<[ProcessResult, string]> = [
      [{ kind: 'failed', failure: 'timeout', stderr: '', durationMs: 5000 }, 'timeout'],
      [{ kind: 'failed', failure: 'cancelled', stderr: '', durationMs: 1 }, 'cancelled'],
      [{ kind: 'failed', failure: 'output-limit', stderr: '', durationMs: 1 }, 'output-limit'],
      [{ kind: 'failed', failure: 'unsupported-executable', errorCode: 'EINVAL', stderr: '', durationMs: 1 }, 'unsupported-executable'],
      [{ kind: 'failed', failure: 'not-found', errorCode: 'ENOENT', stderr: '', durationMs: 1 }, 'executable-not-found'],
    ];
    for (const [result, expected] of cases) {
      const { cli, missingCount } = makeCli(new FakeRunner(() => result));
      const outcome = await cli.status();
      assert.equal(outcome.ok ? 'ok' : outcome.error.kind, expected);
      assert.equal(missingCount(), expected === 'executable-not-found' ? 1 : 0);
    }
  });

  it('does not spawn anything when the executable cannot be resolved', async () => {
    const runner = new FakeRunner(() => exited(''));
    const { cli } = makeCli(runner, { ok: false, reason: 'unsupported-shim', path: 'C:\\x\\cswap.cmd' });
    const outcome = await cli.list();
    assert.equal(outcome.ok ? 'ok' : outcome.error.kind, 'unsupported-executable');
    assert.equal(runner.calls.length, 0);
  });

  it('never exposes raw stdout in errors', async () => {
    const { cli } = makeCli(new FakeRunner(() => exited('secret bob@example.com sk-ant-abc not json', 1, '')));
    const outcome = await cli.list();
    assert.ok(!outcome.ok);
    assert.equal(JSON.stringify(outcome).includes('bob@example.com'), false);
    assert.equal(JSON.stringify(outcome).includes('sk-ant'), false);
  });
});
