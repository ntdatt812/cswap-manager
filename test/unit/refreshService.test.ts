import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CliOutcome } from '../../src/core/cli/cswapCli';
import { parseListOutput, parseStatusOutput } from '../../src/core/model/parsers';
import type { ListPayload, StatusPayload } from '../../src/core/model/types';
import { RefreshService, assessFreshness, type AccountsCli, type AccountsState } from '../../src/core/service/refreshService';
import { deferred, fail, fixture, ok, type Deferred } from '../helpers/fixtures';

function listPayload(json = fixture('list-v1.json')): ListPayload {
  const result = parseListOutput(json);
  assert.ok(result.ok);
  return result.value;
}

function statusPayload(): StatusPayload {
  const result = parseStatusOutput(fixture('status-v1.json'));
  assert.ok(result.ok);
  return result.value;
}

class ScriptedCli implements AccountsCli {
  listCalls = 0;
  statusCalls = 0;
  readonly signals: AbortSignal[] = [];
  listQueue: Array<CliOutcome<ListPayload> | Deferred<CliOutcome<ListPayload>>> = [];
  statusResult: CliOutcome<StatusPayload> = ok('status', statusPayload());

  list(signal?: AbortSignal): Promise<CliOutcome<ListPayload>> {
    this.listCalls++;
    if (signal) {
      this.signals.push(signal);
    }
    const next = this.listQueue.shift() ?? ok('list', listPayload());
    return 'promise' in next ? next.promise : Promise.resolve(next);
  }

  status(): Promise<CliOutcome<StatusPayload>> {
    this.statusCalls++;
    return Promise.resolve(this.statusResult);
  }
}

describe('RefreshService', () => {
  it('loads a snapshot using list only when the list is self-consistent', async () => {
    const cli = new ScriptedCli();
    const service = new RefreshService({ cli, now: () => 5000 });
    const result = await service.refresh({ trigger: 'manual' });
    assert.ok(result.ok);
    assert.equal(result.snapshot.active.slot, 2);
    assert.equal(cli.listCalls, 1);
    assert.equal(cli.statusCalls, 0);
    const state = service.getState();
    assert.equal(state.lastSuccessAt, 5000);
    assert.equal(state.refreshing, false);
    assert.equal(assessFreshness(state, 5000).freshness, 'fresh');
  });

  it('verifies with list and status at the same time, not one after the other', async () => {
    const cli = new ScriptedCli();
    const pendingList = deferred<CliOutcome<ListPayload>>();
    cli.listQueue.push(pendingList);
    const service = new RefreshService({ cli });
    const running = service.refresh({ trigger: 'post-switch', verifyActive: true });
    await Promise.resolve();
    assert.equal(cli.statusCalls, 1, 'status already started while list is still running');
    pendingList.resolve(ok('list', listPayload()));
    const result = await running;
    assert.ok(result.ok);
    assert.equal(cli.listCalls, 1);
    assert.equal(cli.statusCalls, 1);
  });

  it('calls status when verification is requested or the list is ambiguous', async () => {
    const cli = new ScriptedCli();
    const service = new RefreshService({ cli });
    await service.refresh({ trigger: 'post-switch', verifyActive: true });
    assert.equal(cli.statusCalls, 1);

    cli.listQueue.push(ok('list', listPayload(fixture('list-v1.json').replace('"activeAccountNumber": 2', '"activeAccountNumber": null'))));
    const result = await service.refresh({ trigger: 'manual' });
    assert.equal(cli.statusCalls, 2);
    assert.ok(result.ok);
    assert.equal(result.snapshot.active.verifiedWithStatus, true);
  });

  it('coalesces concurrent refreshes into one CLI run', async () => {
    const cli = new ScriptedCli();
    const gate = deferred<CliOutcome<ListPayload>>();
    cli.listQueue.push(gate);
    const service = new RefreshService({ cli });

    const first = service.refresh({ trigger: 'interval' });
    const second = service.refresh({ trigger: 'manual' });
    assert.equal(service.getState().refreshing, true);
    gate.resolve(ok('list', listPayload()));
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
    assert.equal(cli.listCalls, 1);
  });

  it('queues exactly one follow-up run for requireFresh while a refresh is running', async () => {
    const cli = new ScriptedCli();
    const gate = deferred<CliOutcome<ListPayload>>();
    cli.listQueue.push(gate);
    const service = new RefreshService({ cli });

    const running = service.refresh({ trigger: 'interval' });
    const fresh1 = service.refresh({ trigger: 'post-switch', requireFresh: true });
    const fresh2 = service.refresh({ trigger: 'post-switch', requireFresh: true, verifyActive: true });
    gate.resolve(ok('list', listPayload()));
    await running;
    const [r1, r2] = await Promise.all([fresh1, fresh2]);
    assert.equal(r1, r2);
    assert.equal(cli.listCalls, 2);
    assert.equal(cli.statusCalls, 1, 'verifyActive from the second request is merged');
  });

  it('joins the queued follow-up when asked in the gap after a run ends, instead of starting a second run', async () => {
    const cli = new ScriptedCli();
    const gate = deferred<CliOutcome<ListPayload>>();
    cli.listQueue.push(gate);
    const service = new RefreshService({ cli });

    const running = service.refresh({ trigger: 'interval' });
    // Registered before the follow-up below, so it runs first when the run ends: the gap.
    const inGap = running.then(() => service.refresh({ trigger: 'external', requireFresh: true }));
    const followUp = service.refresh({ trigger: 'post-switch', requireFresh: true });
    gate.resolve(ok('list', listPayload()));
    assert.equal(await inGap, await followUp);
    assert.equal(cli.listCalls, 2, 'the first run and one follow-up, no run beside it');
  });

  it('whenIdle waits for the run under way and its queued follow-up, and starts none itself', async () => {
    const cli = new ScriptedCli();
    const first = deferred<CliOutcome<ListPayload>>();
    const second = deferred<CliOutcome<ListPayload>>();
    cli.listQueue.push(first, second);
    const service = new RefreshService({ cli });
    await service.whenIdle();
    assert.equal(cli.listCalls, 0, 'idle: resolves at once without a run');

    void service.refresh({ trigger: 'interval' });
    void service.refresh({ trigger: 'post-switch', requireFresh: true });
    let idle = false;
    const waiting = service.whenIdle().then(() => {
      idle = true;
    });
    first.resolve(ok('list', listPayload()));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(idle, false, 'still waiting for the follow-up');
    second.resolve(ok('list', listPayload()));
    await waiting;
    assert.equal(cli.listCalls, 2);
    assert.equal(service.getState().refreshing, false);
  });

  it('whenIdle returns after dispose even while a run never reports back', async () => {
    const cli = new ScriptedCli();
    cli.listQueue.push(deferred<CliOutcome<ListPayload>>());
    const service = new RefreshService({ cli });
    void service.refresh({ trigger: 'manual' });
    service.dispose();
    await service.whenIdle();
  });

  it('keeps the last good snapshot and marks it stale when a refresh fails', async () => {
    const cli = new ScriptedCli();
    let now = 1000;
    const service = new RefreshService({ cli, now: () => now });
    await service.refresh({ trigger: 'manual' });

    now = 2000;
    cli.listQueue.push(fail('list', 'timeout'));
    const result = await service.refresh({ trigger: 'manual' });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.snapshot, 'last good snapshot is returned');
    const state = service.getState();
    assert.equal(state.lastError?.kind, 'timeout');
    assert.equal(state.lastSuccessAt, 1000);
    assert.equal(state.lastAttemptAt, 2000);
    assert.deepEqual(assessFreshness(state, 2000), { freshness: 'stale', reason: 'refresh-failed' });

    cli.listQueue.push(ok('list', listPayload()));
    await service.refresh({ trigger: 'manual' });
    assert.equal(service.getState().lastError, undefined, 'success clears the error');
  });

  it('reports no data (not an empty list) when the first refresh fails', async () => {
    const cli = new ScriptedCli();
    cli.listQueue.push(fail('list', 'executable-not-found'));
    const service = new RefreshService({ cli });
    const result = await service.refresh({ trigger: 'activation' });
    assert.ok(!result.ok);
    assert.equal(result.snapshot, undefined);
    assert.equal(assessFreshness(service.getState(), Date.now()).freshness, 'none');
  });

  it('keeps list data with a warning when status verification fails', async () => {
    const cli = new ScriptedCli();
    cli.statusResult = fail('status', 'non-zero-exit');
    const service = new RefreshService({ cli });
    const result = await service.refresh({ trigger: 'post-switch', verifyActive: true });
    assert.ok(result.ok);
    assert.equal(result.snapshot.active.verifiedWithStatus, false);
    assert.equal(service.getState().lastWarning?.kind, 'non-zero-exit');
  });

  it('marks data stale when it is older than the threshold', () => {
    const state: AccountsState = { refreshing: false, lastSuccessAt: 0, snapshot: { accounts: [], active: { consistency: 'unknown', verifiedWithStatus: false }, capturedAt: 0, warnings: [] } };
    assert.deepEqual(assessFreshness(state, 10_000, 5_000), { freshness: 'stale', reason: 'too-old' });
    assert.deepEqual(assessFreshness(state, 4_000, 5_000), { freshness: 'fresh' });
  });

  it('emits state changes and contains faulty listeners', async () => {
    const service = new RefreshService({ cli: new ScriptedCli() });
    const seen: boolean[] = [];
    service.onDidChange(() => {
      throw new Error('listener bug');
    });
    service.onDidChange((state) => seen.push(state.refreshing));
    await service.refresh({ trigger: 'manual' });
    assert.deepEqual(seen, [true, false]);
  });

  it('converts unexpected adapter exceptions into an error result', async () => {
    const cli = new ScriptedCli();
    cli.list = () => Promise.reject(new Error('bug'));
    const service = new RefreshService({ cli });
    const result = await service.refresh({ trigger: 'manual' });
    assert.equal(result.ok ? 'ok' : result.error.kind, 'unexpected-error');
    assert.equal(service.getState().refreshing, false);
  });

  it('aborts the in-flight command on dispose and refuses new work', async () => {
    const cli = new ScriptedCli();
    const gate = deferred<CliOutcome<ListPayload>>();
    cli.listQueue.push(gate);
    const service = new RefreshService({ cli });
    const pending = service.refresh({ trigger: 'manual' });
    service.dispose();
    assert.equal(cli.signals[0]?.aborted, true);
    assert.equal(service.getState().refreshing, false, 'a cancelled run does not stay "running"');
    gate.resolve(fail('list', 'cancelled'));
    assert.equal((await pending).ok, false);
    const after = await service.refresh({ trigger: 'manual' });
    assert.equal(after.ok ? 'ok' : after.error.kind, 'cancelled');
    assert.equal(cli.listCalls, 1);
  });
});
