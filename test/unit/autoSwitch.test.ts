import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autoSwitchRuleArgs, ruleMatches, validateRuleInput } from '../../src/core/cli/autoSwitchRules';
import { cliError } from '../../src/core/cli/cliErrors';
import { CswapCli, type CliOutcome } from '../../src/core/cli/cswapCli';
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../../src/core/cli/processRunner';
import { buildTickResult, parseAutoEvents, parseAutoSwitchRules, type AutoSwitchRules, type AutoTickResult } from '../../src/core/model/autoSwitch';
import { parseListOutput } from '../../src/core/model/parsers';
import { buildSnapshot } from '../../src/core/model/reconcile';
import {
  AutoSwitchService,
  ERROR_NOTICE_AFTER,
  FileLease,
  LEASE_UNAVAILABLE,
  type AutoSwitchNotice,
  type LeaderLease,
} from '../../src/core/service/autoSwitchService';
import { OperationGate } from '../../src/core/service/operationGate';
import type { RefreshRequest, RefreshResult } from '../../src/core/service/refreshService';

/** The two lines observed from `cswap auto --once --dry-run --json` on cswap 1.2.0 (emails replaced). */
const OBSERVED_NO_SWITCH = [
  '{"schemaVersion":1,"event":"poll","ts":"2026-11-24T05:00:00Z","active":{"number":5,"email":"a@example.com"},"threshold":90,"headroomPct":{"1":6,"5":54},"windowsPct":{"1":{"7d":94},"5":{"7d":46}}}',
  '{"schemaVersion":1,"event":"no-switch","ts":"2026-11-24T05:00:00Z","reason":"below-threshold","detail":"Account-5 7d 46% < 90%"}',
].join('\n');

const SWITCH_LINE = (dryRun: boolean) =>
  `{"schemaVersion":1,"event":"switch","ts":"t","trigger":"proactive","from":{"number":5,"email":"a@example.com"},"to":{"number":4,"email":"b@example.com"},"warnings":[],"dryRun":${dryRun}}`;

describe('auto-switch event parsing', () => {
  it('parses the observed poll/no-switch stream without keeping emails', () => {
    const events = parseAutoEvents(OBSERVED_NO_SWITCH);
    assert.deepEqual(events, [
      { kind: 'poll', activeSlot: 5, threshold: 90 },
      { kind: 'no-switch', reason: 'below-threshold' },
    ]);
    assert.equal(JSON.stringify(events).includes('@'), false);
  });

  it('maps --once exit codes and parses switch, exhausted, error and unknown events', () => {
    assert.equal(buildTickResult('', 0, false).outcome, 'switched');
    assert.equal(buildTickResult('', 1, false).outcome, 'error');
    assert.equal(buildTickResult('', 2, false).outcome, 'no-action');
    assert.equal(buildTickResult('', 3, false).outcome, 'blocked');
    assert.equal(buildTickResult('', 9, false).outcome, 'unknown');
    const events = parseAutoEvents(
      [
        SWITCH_LINE(false),
        '{"event":"all-exhausted","earliestResetAt":"2026-11-25T00:00:00Z"}',
        '{"event":"error","message":"timeout","transient":true}',
        '{"event":"sleep","seconds":60}',
        'not json',
        '{"event":',
      ].join('\n'),
    );
    assert.deepEqual(events, [
      { kind: 'switch', trigger: 'proactive', fromSlot: 5, toSlot: 4, dryRun: false, warningCount: 0 },
      { kind: 'all-exhausted', earliestResetAt: '2026-11-25T00:00:00Z' },
      { kind: 'error', message: 'timeout', transient: true },
      { kind: 'other', name: 'sleep' },
    ]);
  });

  it('reads only the settings it shows, and never the settings path', () => {
    const rules = parseAutoSwitchRules(
      JSON.stringify({
        schemaVersion: 1,
        path: 'C:\\Users\\someone\\.claude-swap\\settings.json',
        settings: [
          { key: 'autoswitch.threshold', value: 85, isSet: true },
          { key: 'autoswitch.weeklyThreshold', value: null, isSet: false },
          { key: 'autoswitch.intervalSeconds', value: 60, isSet: false },
          { key: 'autoswitch.unhealthyTicks', value: 3, isSet: false },
          { key: 'autoswitch.strategy', value: 'best', isSet: false },
          { key: 'run.shareHistory', value: false, isSet: true },
          { key: 'usage.headerProbe', value: 'yes', isSet: false },
          { key: 'ui.theme', value: 'dark', isSet: true },
        ],
      }),
    );
    assert.deepEqual(rules, {
      threshold: 85,
      intervalSeconds: 60,
      unhealthyTicks: 3,
      strategy: 'best',
      shareHistory: false,
      customized: ['autoswitch.threshold', 'run.shareHistory'],
    });
    assert.equal(JSON.stringify(rules).includes('Users'), false);
    assert.equal(parseAutoSwitchRules('{"settings":{}}'), undefined);
  });
});

describe('auto-switch rule validation (matches cswap config set)', () => {
  it('accepts the documented ranges and strategies', () => {
    assert.deepEqual(validateRuleInput('autoswitch.threshold', '85'), { ok: true, value: '85' });
    assert.deepEqual(validateRuleInput('autoswitch.weeklyThreshold', '97.5'), { ok: true, value: '97.5' });
    assert.deepEqual(validateRuleInput('autoswitch.intervalSeconds', '15'), { ok: true, value: '15' });
    assert.deepEqual(validateRuleInput('autoswitch.cooldownSeconds', '0'), { ok: true, value: '0' });
    assert.deepEqual(validateRuleInput('autoswitch.strategy', 'consume-first'), { ok: true, value: 'consume-first' });
  });

  it('rejects what cswap rejects and anything flag-like', () => {
    for (const [key, value] of [
      ['autoswitch.threshold', '150'],
      ['autoswitch.threshold', '10'],
      ['autoswitch.threshold', '-90'],
      ['autoswitch.intervalSeconds', '5'],
      ['autoswitch.cooldownSeconds', '1.5'],
      ['autoswitch.strategy', 'nope'],
      ['autoswitch.strategy', '--force'],
    ] as const) {
      assert.equal(validateRuleInput(key, value).ok, false, `${key}=${value}`);
    }
  });

  it('builds config set arguments only for allow-listed keys', () => {
    assert.deepEqual(autoSwitchRuleArgs({ key: 'autoswitch.threshold', value: 85 }), ['config', 'set', 'autoswitch.threshold', '85']);
    assert.equal(autoSwitchRuleArgs({ key: 'autoswitch.threshold', value: 150 }), undefined);
    assert.equal(autoSwitchRuleArgs({ key: 'ui.theme', value: 1 } as never), undefined);
  });
});

describe('CswapCli auto commands', () => {
  class Runner implements ProcessRunner {
    readonly calls: Array<{ args: readonly string[]; options: ProcessRunOptions }> = [];
    constructor(private readonly result: ProcessResult) {}
    run(_file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
      this.calls.push({ args, options });
      return Promise.resolve(this.result);
    }
  }
  const cliWith = (result: ProcessResult) => {
    const runner = new Runner(result);
    const cli = new CswapCli({
      runner,
      resolveExecutable: () => Promise.resolve({ ok: true, path: 'C:\\bin\\cswap.exe', source: 'path' }),
      settings: () => ({ timeoutMs: 10_000, maxOutputBytes: 64_000 }),
      workingDirectory: 'C:\\Users\\dev',
      baseEnv: {},
      homeDir: 'C:\\Users\\dev',
    });
    return { cli, runner };
  };
  const exited = (stdout: string, exitCode: number): ProcessResult => ({ kind: 'exited', exitCode, signal: null, stdout, stderr: '', durationMs: 3 });

  it('runs a dry-run tick as a cancellable read and accepts exit 2 as "no action"', async () => {
    const { cli, runner } = cliWith(exited(OBSERVED_NO_SWITCH, 2));
    const outcome = await cli.autoTick({ dryRun: true });
    assert.ok(outcome.ok);
    assert.equal(outcome.value.outcome, 'no-action');
    assert.deepEqual(runner.calls[0]?.args, ['auto', '--once', '--json', '--dry-run']);
    assert.equal(runner.calls[0]?.options.timeoutMs, 10_000);
  });

  it('runs a real tick as a non-cancellable mutation and accepts exit 0/3', async () => {
    const { cli, runner } = cliWith(exited(SWITCH_LINE(false), 0));
    const outcome = await cli.autoTick({ dryRun: false });
    assert.ok(outcome.ok);
    assert.equal(outcome.value.outcome, 'switched');
    assert.deepEqual(runner.calls[0]?.args, ['auto', '--once', '--json']);
    assert.ok((runner.calls[0]?.options.timeoutMs ?? 0) >= 600_000, 'long safety timeout for a real tick');
    const blocked = await cliWith(exited('{"event":"all-exhausted"}', 3)).cli.autoTick({ dryRun: false });
    assert.equal(blocked.ok && blocked.value.outcome, 'blocked');
  });

  it('reads rules with config --json list and refuses unknown rule keys without spawning', async () => {
    const { cli, runner } = cliWith(exited('{"settings":[{"key":"autoswitch.threshold","value":90,"isSet":false}]}', 0));
    const rules = await cli.readAutoSwitchRules();
    assert.ok(rules.ok);
    assert.deepEqual(runner.calls[0]?.args, ['config', '--json', 'list']);
    const refused = await cli.resetAutoSwitchRule('ui.theme' as never);
    assert.equal(refused.ok ? 'ok' : refused.error.kind, 'invalid-request');
    assert.equal(runner.calls.length, 1);
  });
});

describe('FileLease', () => {
  const store = () => {
    let content: string | undefined;
    return { read: () => Promise.resolve(content), write: (value: string) => Promise.resolve(void (content = value)), remove: () => Promise.resolve(void (content = undefined)) };
  };

  it('lets one window hold the lease until its heartbeat goes stale', async () => {
    const shared = store();
    const a = new FileLease(shared, 'window-a', () => 1_000);
    const b = new FileLease(shared, 'window-b', () => 1_000);
    assert.equal(await a.tryAcquire(0), true);
    assert.equal(await b.tryAcquire(500), false, 'fresh heartbeat');
    assert.equal(await a.tryAcquire(900), true, 'holder renews');
    assert.equal(await b.tryAcquire(2_500), true, 'stale heartbeat is taken over');
    await a.release();
    assert.equal(await b.tryAcquire(2_600), true, 'release by a non-holder changes nothing');
    await b.release();
    assert.equal(await a.tryAcquire(2_700), true);
  });
});

function snapshotWithActive(slot: number): RefreshResult {
  const list = parseListOutput(
    JSON.stringify({
      schemaVersion: 1,
      activeAccountNumber: slot,
      accounts: [4, 5].map((number) => ({ number, email: `u${number}@example.com`, active: number === slot })),
    }),
  );
  assert.ok(list.ok);
  return { ok: true, snapshot: buildSnapshot(list.value, undefined, 1) };
}

class FakeAutoCli {
  readonly ticks: boolean[] = [];
  next: CliOutcome<AutoTickResult> = this.tick(OBSERVED_NO_SWITCH, 2, false);
  rules: AutoSwitchRules = { threshold: 90, intervalSeconds: 5, customized: [] };

  tick(stdout: string, exitCode: number, dryRun: boolean): CliOutcome<AutoTickResult> {
    return { ok: true, value: buildTickResult(stdout, exitCode, dryRun), meta: { command: 'auto', exitCode } };
  }

  autoTick(options: { dryRun: boolean }): Promise<CliOutcome<AutoTickResult>> {
    this.ticks.push(options.dryRun);
    return Promise.resolve(this.next);
  }

  readAutoSwitchRules(): Promise<CliOutcome<AutoSwitchRules>> {
    return Promise.resolve({ ok: true, value: this.rules, meta: { command: 'config' } });
  }
}

function setup(lease: LeaderLease = { tryAcquire: () => Promise.resolve(true), release: () => Promise.resolve() }) {
  const cli = new FakeAutoCli();
  const notices: AutoSwitchNotice[] = [];
  const refreshes: RefreshRequest[] = [];
  const gate = new OperationGate();
  const timers = { setTimeout: () => 1, clearTimeout: () => undefined };
  const service = new AutoSwitchService({
    cli,
    refresher: {
      refresh: (request) => {
        refreshes.push(request);
        return Promise.resolve(snapshotWithActive(4));
      },
    },
    gate,
    lease,
    onNotice: (notice) => notices.push(notice),
    timers,
  });
  return { cli, notices, refreshes, gate, service };
}

describe('AutoSwitchService', () => {
  it('does nothing while off and uses dry runs in notify mode', async () => {
    const { cli, service } = setup();
    assert.equal(await service.tick(), false);
    await service.setMode('notify');
    assert.equal(await service.tick(), true);
    assert.deepEqual(cli.ticks, [true]);
    assert.equal(service.getState().lastReason, 'below-threshold');
    assert.equal(service.intervalMs(), 15_000, 'cswap minimum interval is enforced');
  });

  it('notifies a would-be switch once until the situation changes', async () => {
    const { cli, notices, service } = setup();
    await service.setMode('notify');
    cli.next = cli.tick(SWITCH_LINE(true), 0, true);
    await service.tick();
    await service.tick();
    assert.deepEqual(notices, [{ kind: 'would-switch', fromSlot: 5, toSlot: 4, trigger: 'proactive' }]);
    cli.next = cli.tick(OBSERVED_NO_SWITCH, 2, true);
    await service.tick();
    cli.next = cli.tick(SWITCH_LINE(true), 0, true);
    await service.tick();
    assert.equal(notices.length, 2, 'notified again after it cleared');
  });

  it('switches in switch mode and verifies the new active account', async () => {
    const { cli, notices, refreshes, service } = setup();
    await service.setMode('switch');
    cli.next = cli.tick(SWITCH_LINE(false), 0, false);
    await service.tick();
    assert.deepEqual(cli.ticks, [false]);
    assert.deepEqual(refreshes, [{ trigger: 'post-switch', verifyActive: true, requireFresh: true }]);
    assert.deepEqual(notices, [{ kind: 'switched', fromSlot: 5, toSlot: 4, trigger: 'proactive', verification: 'unverified', activeSlot: 4 }]);
    assert.equal(service.getState().lastSwitch?.toSlot, 4);
  });

  it('reports "all at limit" once and repeated errors only after several in a row', async () => {
    const { cli, notices, service } = setup();
    await service.setMode('switch');
    cli.next = cli.tick('{"event":"all-exhausted","earliestResetAt":"2026-11-25T00:00:00Z"}', 3, false);
    await service.tick();
    await service.tick();
    assert.deepEqual(notices, [{ kind: 'blocked', earliestResetAt: '2026-11-25T00:00:00Z' }]);
    cli.next = { ok: false, error: cliError('timeout'), meta: { command: 'auto' } };
    for (let i = 0; i < ERROR_NOTICE_AFTER + 1; i++) {
      await service.tick();
    }
    assert.equal(notices.filter((notice) => notice.kind === 'failing').length, 1);
    assert.equal(service.getState().consecutiveErrors, ERROR_NOTICE_AFTER + 1);
  });

  it('stays on standby when another window holds the lease, and skips while another operation runs', async () => {
    const standby = setup({ tryAcquire: () => Promise.resolve(false), release: () => Promise.resolve() });
    await standby.service.setMode('switch');
    assert.equal(await standby.service.tick(), false);
    assert.equal(standby.service.getState().role, 'standby');
    assert.deepEqual(standby.cli.ticks, []);

    const busy = setup();
    await busy.service.setMode('switch');
    let release: () => void = () => undefined;
    const held = busy.gate.run(() => new Promise<void>((resolve) => (release = resolve)));
    assert.equal(await busy.service.tick(), false);
    assert.deepEqual(busy.cli.ticks, []);
    release();
    await held;
  });

  it('releases the lease when turned off', async () => {
    let released = 0;
    const { service } = setup({ tryAcquire: () => Promise.resolve(true), release: () => Promise.resolve(void released++) });
    await service.setMode('switch');
    await service.setMode('off');
    assert.equal(released, 1);
    assert.equal(service.getState().role, 'idle');
  });
});

describe('security review regressions', () => {
  it('M1: a mode change while the lease is being acquired never leads to a real tick', async () => {
    for (const next of ['notify', 'off'] as const) {
      let grant: (value: boolean) => void = () => undefined;
      const { cli, service } = setup({ tryAcquire: () => new Promise<boolean>((resolve) => (grant = resolve)), release: () => Promise.resolve() });
      await service.setMode('switch');
      const ticking = service.tick();
      await service.setMode(next);
      grant(true);
      await ticking;
      assert.equal(cli.ticks.includes(false), false, `no real tick after switching to ${next}`);
      assert.deepEqual(cli.ticks, next === 'notify' ? [true] : []);
    }
  });

  it('L1: ignores wrongly typed rule values and keeps the interval finite and bounded', async () => {
    const parsed = parseAutoSwitchRules(
      JSON.stringify({
        settings: [
          { key: 'autoswitch.intervalSeconds', value: 'abc' },
          { key: 'autoswitch.threshold', value: true },
          { key: 'autoswitch.strategy', value: 5 },
        ],
      }),
    );
    assert.deepEqual(parsed, { customized: [] });
    const { cli, service } = setup();
    for (const [value, expected] of [
      [Number.NaN, 60_000],
      [1e9, 3_600_000],
      [1, 15_000],
      [90, 90_000],
    ] as const) {
      cli.rules = { intervalSeconds: value, customized: [] };
      await service.reloadRules();
      assert.equal(service.intervalMs(), expected, String(value));
    }
  });

  it('L2: an unwritable lease is reported as an error instead of an unhandled rejection', async () => {
    const { notices, service } = setup({ tryAcquire: () => Promise.reject(new Error('EPERM')), release: () => Promise.reject(new Error('EPERM')) });
    await service.setMode('switch');
    for (let i = 0; i < ERROR_NOTICE_AFTER; i++) {
      assert.equal(await service.tick(), false);
    }
    assert.equal(service.getState().lastOutcome, 'error');
    assert.deepEqual(notices, [{ kind: 'failing', message: LEASE_UNAVAILABLE }]);
    await service.setMode('off');
    assert.equal(service.getState().mode, 'off');
  });

  it('L3: a real switch without a readable switch event is still verified and notified', async () => {
    const { cli, notices, refreshes, service } = setup();
    await service.setMode('switch');
    cli.next = cli.tick('{"event":"renamed-switch"}', 0, false);
    await service.tick();
    assert.equal(refreshes.length, 1);
    assert.deepEqual(notices, [{ kind: 'switched', verification: 'unverified', toSlot: 4, activeSlot: 4 }]);
    assert.equal(service.getState().lastSwitch?.dryRun, false);
  });

  it('L6: a failed real tick refreshes the state; a failed dry run does not', async () => {
    const real = setup();
    await real.service.setMode('switch');
    real.cli.next = { ok: false, error: cliError('timeout'), meta: { command: 'auto' } };
    await real.service.tick();
    assert.equal(real.refreshes.length, 1);

    const dry = setup();
    await dry.service.setMode('notify');
    dry.cli.next = { ok: false, error: cliError('timeout'), meta: { command: 'auto' } };
    await dry.service.tick();
    assert.equal(dry.refreshes.length, 0);
  });

  it('treats a lease heartbeat far in the future as stale', async () => {
    let content: string | undefined = JSON.stringify({ owner: 'other', heartbeat: 10_000_000 });
    const lease = new FileLease(
      { read: () => Promise.resolve(content), write: (value) => Promise.resolve(void (content = value)), remove: () => Promise.resolve(void (content = undefined)) },
      'me',
      () => 1_000,
    );
    assert.equal(await lease.tryAcquire(0), true);
  });

  it('verifies the value the rules editor wrote', () => {
    const rules: AutoSwitchRules = { threshold: 85, strategy: 'best', intervalSeconds: 60, customized: ['autoswitch.threshold'] };
    assert.equal(ruleMatches(rules, 'autoswitch.threshold', '85'), true);
    assert.equal(ruleMatches(rules, 'autoswitch.threshold', '80'), false);
    assert.equal(ruleMatches(rules, 'autoswitch.strategy', 'best'), true);
    assert.equal(ruleMatches(rules, 'autoswitch.intervalSeconds', ''), true, 'reset: no longer customized');
    assert.equal(ruleMatches(rules, 'autoswitch.threshold', ''), false, 'reset did not take effect');
  });
});
