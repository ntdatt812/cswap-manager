import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { NodeProcessRunner, classifySpawnError, type ProcessRunOptions } from '../../src/core/cli/processRunner';

const NODE = process.execPath;
const runner = new NodeProcessRunner();
const options = (overrides: Partial<ProcessRunOptions> = {}): ProcessRunOptions => ({
  timeoutMs: 10_000,
  maxOutputBytes: 1024 * 1024,
  ...overrides,
});

describe('NodeProcessRunner (real child processes)', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const result = await runner.run(NODE, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'], options());
    assert.equal(result.kind, 'exited');
    assert.ok(result.kind === 'exited');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'out');
    assert.equal(result.stderr, 'err');
  });

  it('reports non-zero exit codes', async () => {
    const result = await runner.run(NODE, ['-e', 'process.exit(3)'], options());
    assert.ok(result.kind === 'exited');
    assert.equal(result.exitCode, 3);
  });

  it('passes arguments literally, without shell interpretation', async () => {
    const dangerous = ['a & echo pwned', '%PATH%', '$(whoami)', '"quoted"', 'semi;colon', '|pipe'];
    const result = await runner.run(NODE, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...dangerous], options());
    assert.ok(result.kind === 'exited');
    assert.deepEqual(JSON.parse(result.stdout), dangerous);
  });

  it('decodes multi-byte UTF-8 split across chunks', async () => {
    const script = 'const b = Buffer.from("é€😀".repeat(5000)); for (let i = 0; i < b.length; i += 7) process.stdout.write(b.subarray(i, i + 7));';
    const result = await runner.run(NODE, ['-e', script], options());
    assert.ok(result.kind === 'exited');
    assert.equal(result.stdout, 'é€😀'.repeat(5000));
  });

  it('times out and kills a hung process', async () => {
    const started = Date.now();
    const result = await runner.run(NODE, ['-e', 'setTimeout(() => {}, 60_000)'], options({ timeoutMs: 300 }));
    assert.deepEqual(result.kind === 'failed' ? result.failure : result.kind, 'timeout');
    assert.ok(Date.now() - started < 5000);
  });

  it('does not hang when a grandchild keeps the output pipes open', async () => {
    const script =
      'require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "inherit" }); setTimeout(() => {}, 8000);';
    const started = Date.now();
    const result = await runner.run(NODE, ['-e', script], options({ timeoutMs: 400 }));
    assert.deepEqual(result.kind === 'failed' ? result.failure : result.kind, 'timeout');
    assert.ok(Date.now() - started < 3000);
  });

  it('stops reading when stdout exceeds the limit', async () => {
    const result = await runner.run(NODE, ['-e', 'process.stdout.write("x".repeat(200_000))'], options({ maxOutputBytes: 1024 }));
    assert.deepEqual(result.kind === 'failed' ? result.failure : result.kind, 'output-limit');
  });

  it('supports cancellation', async () => {
    const controller = new AbortController();
    const pending = runner.run(NODE, ['-e', 'setTimeout(() => {}, 60_000)'], options({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.deepEqual(result.kind === 'failed' ? result.failure : result.kind, 'cancelled');
  });

  it('does not start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runner.run(NODE, ['-e', ''], options({ signal: controller.signal }));
    assert.deepEqual(result.kind === 'failed' ? result.failure : result.kind, 'cancelled');
  });

  it('reports a missing executable as not-found', async () => {
    const missing = path.join(os.tmpdir(), 'cswap-manager-missing-dir', process.platform === 'win32' ? 'cswap.exe' : 'cswap');
    const result = await runner.run(missing, ['--version'], options());
    assert.deepEqual(result.kind === 'failed' ? result.failure : result.kind, 'not-found');
  });

  it('refuses .cmd shims on Windows instead of using a shell', { skip: process.platform !== 'win32' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cswap-manager-test-'));
    const shim = path.join(dir, 'cswap.cmd');
    fs.writeFileSync(shim, '@echo off\r\necho shim\r\n');
    try {
      const result = await runner.run(shim, ['--version'], options());
      assert.deepEqual(result.kind === 'failed' ? result.failure : result.kind, 'unsupported-executable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('classifySpawnError', () => {
  it('maps OS error codes', () => {
    assert.equal(classifySpawnError('ENOENT'), 'not-found');
    assert.equal(classifySpawnError('EACCES'), 'permission-denied');
    assert.equal(classifySpawnError('EPERM'), 'permission-denied');
    assert.equal(classifySpawnError('EINVAL'), 'unsupported-executable');
    assert.equal(classifySpawnError(undefined), 'spawn-failed');
  });
});
