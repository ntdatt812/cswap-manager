import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cliError } from '../../src/core/cli/cliErrors';
import { CswapCli, MUTATION_MIN_TIMEOUT_MS, switchArgs, type CliOutcome, type SwitchTarget } from '../../src/core/cli/cswapCli';
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../../src/core/cli/processRunner';
import { parseErrorEnvelope, parseListOutput, parseStatusOutput, parseSwitchOutput } from '../../src/core/model/parsers';
import { buildSnapshot } from '../../src/core/model/reconcile';
import type { SwitchResult } from '../../src/core/model/types';
import type { RefreshRequest, RefreshResult } from '../../src/core/service/refreshService';
import { SwitchService, verifyActive } from '../../src/core/service/switchService';
import { deferred, fail, fixture, ok } from '../helpers/fixtures';

describe('switch output parsing', () => {
  it('parses the observed no-op result', () => {
    const result = parseSwitchOutput(fixture('switch-noop.json'));
    assert.ok(result.ok);
    assert.deepEqual(result.value, {
      schemaVersion: 1,
      switched: false,
      from: { slot: 2, email: 'bob@example.com' },
      to: { slot: 2, email: 'bob@example.com' },
      strategy: 'direct',
      reason: 'already-active',
      warnings: [],
    });
  });

  it('parses a switch with warnings and ignores extra fields', () => {
    const result = parseSwitchOutput(fixture('switch-switched.json'));
    assert.ok(result.ok);
    assert.equal(result.value.switched, true);
    assert.equal(result.value.to?.slot, 1);
    assert.equal(result.value.strategy, 'best');
    assert.equal(result.value.warnings.length, 1);
  });

  it('accepts null from/to (unmanaged or no target)', () => {
    const result = parseSwitchOutput('{"schemaVersion":1,"switched":false,"from":null,"to":null,"reason":"only-one-account"}');
    assert.ok(result.ok);
    assert.equal(result.value.from, undefined);
    assert.equal(result.value.to, undefined);
  });

  it('requires the switched flag', () => {
    assert.equal(parseSwitchOutput('{"schemaVersion":1,"to":{"number":1}}').ok, false);
  });

  it('recognizes the error envelope only', () => {
    assert.deepEqual(parseErrorEnvelope('{"schemaVersion":1,"error":{"type":"AccountNotFoundError","message":"Account-99 does not exist"}}'), {
      type: 'AccountNotFoundError',
      message: 'Account-99 does not exist',
    });
    assert.equal(parseErrorEnvelope(fixture('switch-noop.json')), undefined);
    assert.equal(parseErrorEnvelope('nope'), undefined);
  });

  it('reads alias and disabled from list rows', () => {
    const list = parseListOutput('{"schemaVersion":1,"accounts":[{"number":1,"alias":"work","disabled":true}]}');
    assert.ok(list.ok);
    assert.deepEqual(list.value.accounts[0], { slot: 1, alias: 'work', disabled: true });
  });
});

describe('switchArgs', () => {
  it('builds slot and strategy arguments without --force', () => {
    assert.deepEqual(switchArgs({ kind: 'slot', slot: 3 }), ['switch', '3', '--json']);
    assert.deepEqual(switchArgs({ kind: 'strategy', strategy: 'best' }), ['switch', '--strategy', 'best', '--json']);
    assert.deepEqual(switchArgs({ kind: 'strategy', strategy: 'next-available' }), ['switch', '--strategy', 'next-available', '--json']);
  });

  it('rejects invalid slots and unknown strategies', () => {
    for (const slot of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal(switchArgs({ kind: 'slot', slot }), undefined, String(slot));
    }
    assert.equal(switchArgs({ kind: 'strategy', strategy: '--force' } as unknown as SwitchTarget), undefined);
  });
});

class RecordingRunner implements ProcessRunner {
  readonly calls: Array<{ args: readonly string[]; options: ProcessRunOptions }> = [];
  constructor(private readonly result: ProcessResult) {}
  run(_file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ args, options });
    return Promise.resolve(this.result);
  }
}

function cliWith(result: ProcessResult) {
  const runner = new RecordingRunner(result);
  const cli = new CswapCli({
    runner,
    resolveExecutable: () => Promise.resolve({ ok: true, path: 'C:\\bin\\cswap.exe', source: 'path' }),
    settings: () => ({ timeoutMs: 10_000, maxOutputBytes: 4096 }),
    workingDirectory: 'C:\\Users\\dev',
    baseEnv: {},
    homeDir: 'C:\\Users\\dev',
  });
  return { cli, runner };
}

const exited = (stdout: string, exitCode = 0): ProcessResult => ({ kind: 'exited', exitCode, signal: null, stdout, stderr: '', durationMs: 5 });

describe('CswapCli.switch', () => {
  it('uses a long, non-cancellable timeout for the mutating command', async () => {
    const { cli, runner } = cliWith(exited(fixture('switch-noop.json')));
    const outcome = await cli.switch({ kind: 'slot', slot: 2 });
    assert.ok(outcome.ok);
    assert.deepEqual(runner.calls[0]?.args, ['switch', '2', '--json']);
    assert.equal(runner.calls[0]?.options.timeoutMs, MUTATION_MIN_TIMEOUT_MS);
    assert.equal(runner.calls[0]?.options.signal, undefined);
  });

  it('maps the CLI error envelope (exit 1) with a redacted detail', async () => {
    const { cli } = cliWith(exited('{"schemaVersion":1,"error":{"type":"AccountNotFoundError","message":"No account bob@example.com"}}', 1));
    const outcome = await cli.switch({ kind: 'slot', slot: 99 });
    assert.ok(!outcome.ok);
    assert.equal(outcome.error.kind, 'cli-reported-error');
    assert.equal(outcome.error.cliErrorType, 'AccountNotFoundError');
    assert.equal(outcome.error.detail, 'AccountNotFoundError: No account <email>');
  });

  it('refuses an invalid target without spawning', async () => {
    const { cli, runner } = cliWith(exited(''));
    const outcome = await cli.switch({ kind: 'slot', slot: -3 });
    assert.equal(outcome.ok ? 'ok' : outcome.error.kind, 'invalid-request');
    assert.equal(runner.calls.length, 0);
  });
});

function refreshResult(activeNumber: number, withStatus = true, statusNumber = activeNumber): RefreshResult {
  const listJson = JSON.stringify({
    schemaVersion: 1,
    activeAccountNumber: activeNumber,
    accounts: [
      { number: 1, email: 'alice@example.com', active: activeNumber === 1 },
      { number: 2, email: 'bob@example.com', active: activeNumber === 2 },
    ],
  });
  const list = parseListOutput(listJson);
  assert.ok(list.ok);
  const email = statusNumber === 1 ? 'alice@example.com' : 'bob@example.com';
  const status = parseStatusOutput(`{"schemaVersion":1,"active":{"number":${statusNumber},"email":"${email}","managed":true}}`);
  assert.ok(status.ok);
  return { ok: true, snapshot: buildSnapshot(list.value, withStatus ? status.value : undefined, 1) };
}

class FakeSwitchDeps {
  readonly refreshRequests: RefreshRequest[] = [];
  switchResult: CliOutcome<SwitchResult> = ok('switch', { switched: true, to: { slot: 1 }, warnings: [] });
  refreshOutcome: RefreshResult = refreshResult(1);
  gate: Promise<void> = Promise.resolve();

  readonly cli = { switch: async () => (await this.gate, this.switchResult) };
  readonly refresher = {
    refresh: (request: RefreshRequest) => {
      this.refreshRequests.push(request);
      return Promise.resolve(this.refreshOutcome);
    },
    getState: () => ({}),
  };
}

describe('verifyActive', () => {
  it('confirms only a consistent, status-verified match', () => {
    assert.equal(verifyActive(refreshResult(1), 1).status, 'confirmed');
    assert.equal(verifyActive(refreshResult(1, false), 1).status, 'unverified', 'list only');
    assert.deepEqual(verifyActive(refreshResult(2), 1), { status: 'mismatch', activeSlot: 2 });
    assert.deepEqual(verifyActive({ ok: false, error: cliError('timeout') }, 1), { status: 'unverified', refreshError: cliError('timeout') });
  });
});

describe('SwitchService', () => {
  it('switches, then verifies with a fresh status-backed refresh', async () => {
    const deps = new FakeSwitchDeps();
    const service = new SwitchService(deps.cli, deps.refresher);
    const outcome = await service.switch({ kind: 'strategy', strategy: 'best' });
    assert.equal(outcome.kind, 'switched');
    assert.ok(outcome.kind === 'switched');
    assert.equal(outcome.verification.status, 'confirmed');
    assert.deepEqual(deps.refreshRequests, [{ trigger: 'post-switch', verifyActive: true, requireFresh: true }]);
  });

  it('reports a mismatch when the refreshed state disagrees with the CLI claim', async () => {
    const deps = new FakeSwitchDeps();
    deps.refreshOutcome = refreshResult(2);
    const outcome = await new SwitchService(deps.cli, deps.refresher).switch({ kind: 'slot', slot: 1 });
    assert.ok(outcome.kind === 'switched');
    assert.deepEqual(outcome.verification, { status: 'mismatch', activeSlot: 2 });
  });

  it('reports no-op results with the current state', async () => {
    const deps = new FakeSwitchDeps();
    deps.switchResult = ok('switch', { switched: false, reason: 'already-best', to: { slot: 1 }, warnings: [] });
    const outcome = await new SwitchService(deps.cli, deps.refresher).switch({ kind: 'strategy', strategy: 'best' });
    assert.ok(outcome.kind === 'not-switched');
    assert.equal(outcome.result.reason, 'already-best');
    assert.equal(outcome.verification.status, 'confirmed');
  });

  it('still refreshes after a failed switch so the UI shows the real state', async () => {
    const deps = new FakeSwitchDeps();
    deps.switchResult = fail('switch', 'timeout');
    const outcome = await new SwitchService(deps.cli, deps.refresher).switch({ kind: 'slot', slot: 1 });
    assert.ok(outcome.kind === 'failed');
    assert.equal(outcome.error.kind, 'timeout');
    assert.equal(outcome.verification.activeSlot, 1);
    assert.equal(deps.refreshRequests.length, 1);
  });

  it('rejects a second switch while one is running and emits state changes', async () => {
    const deps = new FakeSwitchDeps();
    const gate = deferred<void>();
    deps.gate = gate.promise;
    const service = new SwitchService(deps.cli, deps.refresher);
    const events: boolean[] = [];
    service.onDidChangeSwitching((switching) => events.push(switching));

    const first = service.switch({ kind: 'slot', slot: 1 });
    assert.equal(service.isSwitching(), true);
    assert.deepEqual(await service.switch({ kind: 'slot', slot: 1 }), { kind: 'busy' });
    gate.resolve();
    assert.equal((await first).kind, 'switched');
    assert.equal(service.isSwitching(), false);
    assert.deepEqual(events, [true, false]);
  });
});
