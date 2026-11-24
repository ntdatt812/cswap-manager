import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cliError } from '../../src/core/cli/cliErrors';
import { CswapCli, manageArgs, type CliOutcome, type ManageOperation } from '../../src/core/cli/cswapCli';
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../../src/core/cli/processRunner';
import { normalizeAlias, parseThreshold } from '../../src/core/model/accountPolicy';
import { parseListOutput } from '../../src/core/model/parsers';
import { buildSnapshot } from '../../src/core/model/reconcile';
import type { AccountsSnapshot } from '../../src/core/model/types';
import { accountContextValue, availableActions } from '../../src/core/presentation/accountActions';
import { ManagementService, expectationFor } from '../../src/core/service/managementService';
import { OperationGate } from '../../src/core/service/operationGate';
import type { RefreshRequest, RefreshResult } from '../../src/core/service/refreshService';
import { SwitchService } from '../../src/core/service/switchService';
import { parseWebviewMessage } from '../../src/core/webview/messages';
import { deferred, ok } from '../helpers/fixtures';

type Row = { number: number; email: string; alias?: string; disabled?: boolean; threshold?: number; active?: boolean };

function snapshot(rows: Row[]): AccountsSnapshot {
  const list = parseListOutput(JSON.stringify({ schemaVersion: 1, activeAccountNumber: 3, accounts: rows }));
  assert.ok(list.ok);
  return buildSnapshot(list.value, undefined, 1);
}

const BASE: Row[] = [
  { number: 1, email: 'alice@example.com' },
  { number: 2, email: 'bob@example.com' },
  { number: 3, email: 'carol@example.com', active: true },
];

describe('alias and threshold validation (mirrors cswap 1.1.0, matches live probes)', () => {
  it('normalizes aliases to lower case', () => {
    assert.deepEqual(normalizeAlias('  Cswap-Probe2 '), { ok: true, value: 'cswap-probe2' });
    assert.deepEqual(normalizeAlias('work.dev_1'), { ok: true, value: 'work.dev_1' });
  });

  it('rejects what the CLI rejects', () => {
    assert.deepEqual(normalizeAlias('123'), { ok: false, problem: 'numeric' });
    assert.deepEqual(normalizeAlias('bad name'), { ok: false, problem: 'invalid-characters' });
    assert.deepEqual(normalizeAlias('--unset'), { ok: false, problem: 'leading-dash' });
    assert.deepEqual(normalizeAlias('  '), { ok: false, problem: 'empty' });
    assert.deepEqual(normalizeAlias('ünï'), { ok: false, problem: 'invalid-characters' });
  });

  it('accepts thresholds from 50 to 99.9 only', () => {
    assert.deepEqual(parseThreshold('85'), { ok: true, value: 85 });
    assert.deepEqual(parseThreshold('99.9'), { ok: true, value: 99.9 });
    assert.deepEqual(parseThreshold('50'), { ok: true, value: 50 });
    for (const bad of ['150', '10', '49.99', '100']) {
      assert.deepEqual(parseThreshold(bad), { ok: false, problem: 'out-of-range' }, bad);
    }
    for (const bad of ['', 'abc', '-60', '8e1', '85%', ' NaN']) {
      assert.deepEqual(parseThreshold(bad), { ok: false, problem: 'not-a-number' }, bad);
    }
  });
});

describe('manageArgs', () => {
  it('builds the verified argument vectors', () => {
    assert.deepEqual(manageArgs({ kind: 'setAlias', slot: 2, alias: 'Work' }), ['alias', '2', 'work']);
    assert.deepEqual(manageArgs({ kind: 'removeAlias', slot: 2 }), ['alias', '2', '--unset']);
    assert.deepEqual(manageArgs({ kind: 'setDisabled', slot: 2, disabled: true }), ['disable', '2']);
    assert.deepEqual(manageArgs({ kind: 'setDisabled', slot: 2, disabled: false }), ['enable', '2']);
    assert.deepEqual(manageArgs({ kind: 'setThreshold', slot: 2, threshold: 87.5 }), ['threshold', '2', '87.5']);
    assert.deepEqual(manageArgs({ kind: 'clearThreshold', slot: 2 }), ['threshold', '2', '--unset']);
    assert.deepEqual(manageArgs({ kind: 'move', slot: 2, targetSlot: 4 }), ['move', '2', '4']);
  });

  it('refuses values that could become flags or are out of range', () => {
    const invalid: ManageOperation[] = [
      { kind: 'setAlias', slot: 2, alias: '--unset' },
      { kind: 'setAlias', slot: 2, alias: '-x' },
      { kind: 'setAlias', slot: 2, alias: '42' },
      { kind: 'setThreshold', slot: 2, threshold: 150 },
      { kind: 'setThreshold', slot: 2, threshold: Number.NaN },
      { kind: 'move', slot: 2, targetSlot: 0 },
      { kind: 'move', slot: 0, targetSlot: 2 },
      { kind: 'removeAlias', slot: 1.5 },
    ];
    for (const operation of invalid) {
      assert.equal(manageArgs(operation), undefined, JSON.stringify(operation));
    }
  });
});

describe('CswapCli.manage', () => {
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
      settings: () => ({ timeoutMs: 10_000, maxOutputBytes: 4096 }),
      workingDirectory: 'C:\\Users\\dev',
      baseEnv: {},
      homeDir: 'C:\\Users\\dev',
    });
    return { cli, runner };
  };

  it('treats exit 0 with human text as success and never cancels the write', async () => {
    const { cli, runner } = cliWith({ kind: 'exited', exitCode: 0, signal: null, stdout: "Set alias 'work' for Account 2\n", stderr: '', durationMs: 3 });
    const outcome = await cli.manage({ kind: 'setAlias', slot: 2, alias: 'work' });
    assert.equal(outcome.ok, true);
    assert.deepEqual(runner.calls[0]?.args, ['alias', '2', 'work']);
    assert.equal(runner.calls[0]?.options.signal, undefined);
    assert.ok((runner.calls[0]?.options.timeoutMs ?? 0) >= 120_000);
  });

  it('maps exit 1 to an error with the redacted CLI message', async () => {
    const stderr = "A newer version of claude-swap is available (1.2.0).\nError: Account-1 (alice@example.com) threshold must be between 50 and 99.9, got 150\n";
    const { cli } = cliWith({ kind: 'exited', exitCode: 1, signal: null, stdout: '', stderr, durationMs: 3 });
    const outcome = await cli.manage({ kind: 'clearThreshold', slot: 1 });
    assert.ok(!outcome.ok);
    assert.equal(outcome.error.kind, 'non-zero-exit');
    assert.equal(outcome.error.detail, 'Error: Account-1 (<email>) threshold must be between 50 and 99.9, got 150');
  });

  it('rejects invalid operations without spawning', async () => {
    const { cli, runner } = cliWith({ kind: 'exited', exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1 });
    const outcome = await cli.manage({ kind: 'setAlias', slot: 2, alias: '--unset' });
    assert.equal(outcome.ok ? 'ok' : outcome.error.kind, 'invalid-request');
    assert.equal(runner.calls.length, 0);
  });
});

describe('expectationFor', () => {
  const before = snapshot(BASE);
  const check = (operation: ManageOperation, after: Row[]) => {
    const expectation = expectationFor(operation, before);
    assert.ok(expectation);
    return expectation(snapshot(after));
  };

  it('verifies alias, rotation and threshold changes on the same account', () => {
    assert.equal(check({ kind: 'setAlias', slot: 1, alias: 'Work' }, [{ ...BASE[0]!, alias: 'work' }, BASE[1]!, BASE[2]!]), true);
    assert.equal(check({ kind: 'setAlias', slot: 1, alias: 'work' }, BASE), false);
    assert.equal(check({ kind: 'removeAlias', slot: 1 }, BASE), true);
    assert.equal(check({ kind: 'setDisabled', slot: 2, disabled: true }, [BASE[0]!, { ...BASE[1]!, disabled: true }, BASE[2]!]), true);
    assert.equal(check({ kind: 'setDisabled', slot: 2, disabled: false }, BASE), true);
    assert.equal(check({ kind: 'setThreshold', slot: 2, threshold: 85 }, [BASE[0]!, { ...BASE[1]!, threshold: 85 }, BASE[2]!]), true);
    assert.equal(check({ kind: 'clearThreshold', slot: 2 }, [BASE[0]!, { ...BASE[1]!, threshold: 85 }, BASE[2]!]), false);
  });

  it('follows the account by identity, not by slot', () => {
    // The alias landed on a different account in slot 1 → not confirmed.
    assert.equal(check({ kind: 'setAlias', slot: 1, alias: 'work' }, [{ number: 1, email: 'mallory@example.com', alias: 'work' }, BASE[1]!, BASE[2]!]), false);
  });

  it('verifies moves to an empty slot and swaps with an occupied one', () => {
    assert.equal(check({ kind: 'move', slot: 1, targetSlot: 4 }, [{ ...BASE[0]!, number: 4 }, BASE[1]!, BASE[2]!]), true);
    assert.equal(
      check({ kind: 'move', slot: 1, targetSlot: 2 }, [
        { ...BASE[1]!, number: 1 },
        { ...BASE[0]!, number: 2 },
        BASE[2]!,
      ]),
      true,
    );
    assert.equal(check({ kind: 'move', slot: 1, targetSlot: 2 }, [{ ...BASE[0]!, number: 2 }, BASE[2]!]), false, 'occupant vanished');
    assert.equal(check({ kind: 'move', slot: 1, targetSlot: 4 }, BASE), false);
  });

  it('returns undefined for an unknown slot', () => {
    assert.equal(expectationFor({ kind: 'removeAlias', slot: 9 }, before), undefined);
  });
});

describe('ManagementService', () => {
  class Fake {
    readonly requests: RefreshRequest[] = [];
    current: AccountsSnapshot | undefined = snapshot(BASE);
    after: RefreshResult = { ok: true, snapshot: snapshot([{ ...BASE[0]!, alias: 'work' }, BASE[1]!, BASE[2]!]) };
    result: CliOutcome<void> = ok('manage', undefined);
    gate = Promise.resolve();
    calls = 0;
    readonly cli = {
      manage: async () => {
        this.calls++;
        await this.gate;
        return this.result;
      },
    };
    readonly refresher = {
      getState: () => (this.current === undefined ? {} : { snapshot: this.current }),
      refresh: (request: RefreshRequest) => {
        this.requests.push(request);
        return Promise.resolve(this.after);
      },
    };
  }

  it('applies, refreshes and confirms', async () => {
    const fake = new Fake();
    const outcome = await new ManagementService(fake.cli, fake.refresher, new OperationGate()).apply({ kind: 'setAlias', slot: 1, alias: 'work' });
    assert.deepEqual(outcome, { kind: 'applied', verification: 'confirmed' });
    assert.deepEqual(fake.requests, [{ trigger: 'manual', requireFresh: true, verifyActive: false }]);
  });

  it('reports mismatch, unverified and failure honestly', async () => {
    const mismatch = new Fake();
    mismatch.after = { ok: true, snapshot: snapshot(BASE) };
    assert.deepEqual(await new ManagementService(mismatch.cli, mismatch.refresher, new OperationGate()).apply({ kind: 'setAlias', slot: 1, alias: 'work' }), {
      kind: 'applied',
      verification: 'mismatch',
    });

    const unverified = new Fake();
    unverified.after = { ok: false, error: cliError('timeout') };
    const outcome = await new ManagementService(unverified.cli, unverified.refresher, new OperationGate()).apply({ kind: 'removeAlias', slot: 1 });
    assert.equal(outcome.kind === 'applied' && outcome.verification, 'unverified');

    const failed = new Fake();
    failed.result = { ok: false, error: cliError('non-zero-exit'), meta: { command: 'manage' } };
    assert.equal((await new ManagementService(failed.cli, failed.refresher, new OperationGate()).apply({ kind: 'removeAlias', slot: 1 })).kind, 'failed');
    assert.equal(failed.requests.length, 1, 'still refreshes after a failure');
  });

  it('rejects unknown accounts without running the CLI', async () => {
    const fake = new Fake();
    const outcome = await new ManagementService(fake.cli, fake.refresher, new OperationGate()).apply({ kind: 'removeAlias', slot: 42 });
    assert.deepEqual(outcome, { kind: 'rejected', reason: 'unknown-account' });
    assert.equal(fake.calls, 0);
  });

  it('shares one gate with switching so mutations never overlap', async () => {
    const fake = new Fake();
    const gate = new OperationGate();
    const blocker = deferred<void>();
    fake.gate = blocker.promise;
    const management = new ManagementService(fake.cli, fake.refresher, gate);
    const switching = new SwitchService({ switch: () => Promise.resolve(ok('switch', { switched: false, warnings: [] })) }, fake.refresher, gate);

    const running = management.apply({ kind: 'setAlias', slot: 1, alias: 'work' });
    assert.equal(gate.isBusy(), true);
    assert.deepEqual(await switching.switch({ kind: 'slot', slot: 2 }), { kind: 'busy' });
    assert.deepEqual(await management.apply({ kind: 'removeAlias', slot: 1 }), { kind: 'busy' });
    blocker.resolve();
    assert.equal((await running).kind, 'applied');
    assert.equal(gate.isBusy(), false);
  });
});

describe('account actions and context values', () => {
  const [alice] = snapshot([{ number: 1, email: 'alice@example.com', alias: 'work', disabled: true, threshold: 90 }]).accounts;
  const [bob] = snapshot([{ number: 2, email: 'bob@example.com' }]).accounts;

  it('offers only the actions that apply', () => {
    assert.ok(alice && bob);
    assert.deepEqual(availableActions(alice), ['setDisplayName', 'setAlias', 'removeAlias', 'enable', 'setThreshold', 'clearThreshold', 'setPriority', 'move', 'remove']);
    assert.deepEqual(availableActions(bob), ['setDisplayName', 'setAlias', 'disable', 'setThreshold', 'setPriority', 'move', 'remove']);
    assert.ok(availableActions({ ...bob, priority: 5 }).includes('clearPriority'));
  });

  it('encodes state flags for menu when-clauses', () => {
    assert.ok(alice && bob);
    assert.equal(accountContextValue(alice, false), 'cswap.account:inactive:disabled:aliased:threshold');
    assert.equal(accountContextValue(bob, true), 'cswap.account:active:enabled:unaliased:nothreshold');
  });

  it('accepts only allow-listed management messages from the webview', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'manageAccount', action: 'move', slot: 2 }), { type: 'manageAccount', action: 'move', slot: 2 });
    for (const bad of [
      { type: 'manageAccount', action: 'purge', slot: 2 },
      { type: 'manageAccount', action: 'remove', slot: 2 },
      { type: 'manageAccount', action: 'setAlias', slot: 0 },
      { type: 'manageAccount', action: 'setAlias', slot: '2' },
      { type: 'manageAccount', action: 'setAlias', slot: 2, alias: '--force' },
    ]) {
      const parsed = parseWebviewMessage(bad);
      if (bad.slot === 2 && bad.action === 'setAlias') {
        // Extra fields are dropped: the alias itself is always typed into a VS Code input box.
        assert.deepEqual(parsed, { type: 'manageAccount', action: 'setAlias', slot: 2 });
      } else {
        assert.equal(parsed, undefined, JSON.stringify(bad));
      }
    }
  });
});
