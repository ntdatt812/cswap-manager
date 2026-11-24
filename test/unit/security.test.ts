import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cliError } from '../../src/core/cli/cliErrors';
import { CswapCli, cliEnvironment, type CliOutcome } from '../../src/core/cli/cswapCli';
import type { ProcessResult, ProcessRunner } from '../../src/core/cli/processRunner';
import { parseJsonDocument } from '../../src/core/model/json';
import { parseListOutput } from '../../src/core/model/parsers';
import { buildSnapshot } from '../../src/core/model/reconcile';
import type { AccountsSnapshot } from '../../src/core/model/types';
import type { Translate } from '../../src/core/presentation/accountTree';
import { DEFAULT_THRESHOLDS } from '../../src/core/presentation/format';
import { buildStatusBarModel } from '../../src/core/presentation/statusBar';
import { neutralizeLinks, redactText } from '../../src/core/security/redact';
import { ManagementService, sameAccountsAt } from '../../src/core/service/managementService';
import { OperationGate } from '../../src/core/service/operationGate';
import type { RefreshRequest, RefreshResult } from '../../src/core/service/refreshService';
import { SwitchService } from '../../src/core/service/switchService';
import { ok } from '../helpers/fixtures';

function snapshot(rows: Array<{ number: number; email: string }>, active = 1): AccountsSnapshot {
  const list = parseListOutput(JSON.stringify({ schemaVersion: 1, activeAccountNumber: active, accounts: rows.map((row) => ({ ...row, active: row.number === active })) }));
  assert.ok(list.ok);
  return buildSnapshot(list.value, undefined, 1);
}

describe('L1: CLI text cannot become links in notifications', () => {
  it('breaks markdown links and command/URL schemes', () => {
    const payload = '[Re-login](command:workbench.action.terminal.sendSequence?%7B%7D)';
    const safe = neutralizeLinks(payload);
    assert.equal(safe.includes(']('), false);
    assert.equal(/command:/i.test(safe), false);
    assert.equal(/https?:/i.test(neutralizeLinks('see https://evil.example')), false);
    assert.equal(neutralizeLinks('Cswap: switched to slot 2 (work).'), 'Cswap: switched to slot 2 (work).');
  });

  it('keeps only class-name-like error types from the CLI envelope', async () => {
    const runner: ProcessRunner = {
      run: () =>
        Promise.resolve<ProcessResult>({
          kind: 'exited',
          exitCode: 1,
          signal: null,
          stdout: '{"schemaVersion":1,"error":{"type":"[x](command:evil)","message":"boom"}}',
          stderr: '',
          durationMs: 1,
        }),
    };
    const cli = new CswapCli({
      runner,
      resolveExecutable: () => Promise.resolve({ ok: true, path: 'C:\\bin\\cswap.exe', source: 'path' }),
      settings: () => ({ timeoutMs: 1000, maxOutputBytes: 1000 }),
      workingDirectory: 'C:\\Users\\dev',
      baseEnv: {},
      homeDir: 'C:\\Users\\dev',
    });
    const outcome = await cli.switch({ kind: 'slot', slot: 2 });
    assert.ok(!outcome.ok);
    assert.equal(outcome.error.kind, 'cli-reported-error');
    assert.equal(outcome.error.cliErrorType, undefined);
  });
});

describe('L3: status bar text cannot inject icons through usage data', () => {
  const t: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
  it('sanitizes a hostile usageStatus and window key', () => {
    const list = parseListOutput(
      JSON.stringify({
        schemaVersion: 1,
        activeAccountNumber: 1,
        accounts: [{ number: 1, email: 'a@example.com', active: true, usageStatus: '$(pass-filled) ok' }],
      }),
    );
    assert.ok(list.ok);
    const model = buildStatusBarModel(
      { refreshing: false, snapshot: buildSnapshot(list.value, undefined, 0), lastSuccessAt: 0 },
      { now: 0, thresholds: DEFAULT_THRESHOLDS, t, formatDateTime: String, mode: 'slotUsage', freshness: { freshness: 'fresh' }, switching: false, describeError: (e) => e.message },
    );
    assert.equal(model?.text.includes('$(pass-filled)'), false);
  });
});

describe('L4: the account must not change between confirmation and execution', () => {
  const confirmed = snapshot([
    { number: 1, email: 'a@example.com' },
    { number: 3, email: 'target@example.com' },
  ]);
  const swapped = snapshot([
    { number: 1, email: 'a@example.com' },
    { number: 3, email: 'someone-else@example.com' },
  ]);

  it('compares account identity per slot', () => {
    assert.equal(sameAccountsAt(confirmed, confirmed, [3]), true);
    assert.equal(sameAccountsAt(confirmed, swapped, [3]), false);
    assert.equal(sameAccountsAt(confirmed, swapped, [1]), true);
    assert.equal(sameAccountsAt(confirmed, snapshot([{ number: 1, email: 'a@example.com' }]), [3]), false, 'slot emptied');
    assert.equal(sameAccountsAt(confirmed, confirmed, [7]), true, 'empty in both');
  });

  function refresherReturning(current: AccountsSnapshot) {
    const requests: RefreshRequest[] = [];
    return {
      requests,
      getState: () => ({ snapshot: confirmed }),
      refresh: (request: RefreshRequest): Promise<RefreshResult> => {
        requests.push(request);
        return Promise.resolve({ ok: true, snapshot: current });
      },
    };
  }

  it('refuses a management change when the slot now holds another account', async () => {
    let calls = 0;
    const refresher = refresherReturning(swapped);
    const service = new ManagementService({ manage: () => ((calls++), Promise.resolve(ok('manage', undefined) as CliOutcome<void>)) }, refresher, new OperationGate());
    const outcome = await service.apply({ kind: 'setDisabled', slot: 3, disabled: true }, confirmed);
    assert.deepEqual(outcome, { kind: 'rejected', reason: 'account-changed' });
    assert.equal(calls, 0, 'cswap was not run');
  });

  it('checks both slots of a move', async () => {
    const refresher = refresherReturning(swapped);
    const service = new ManagementService({ manage: () => Promise.resolve(ok('manage', undefined) as CliOutcome<void>) }, refresher, new OperationGate());
    assert.deepEqual(await service.apply({ kind: 'move', slot: 1, targetSlot: 3 }, confirmed), { kind: 'rejected', reason: 'account-changed' });
  });

  it('refuses a slot switch when the slot now holds another account', async () => {
    let calls = 0;
    const refresher = refresherReturning(swapped);
    const service = new SwitchService(
      { switch: () => ((calls++), Promise.resolve(ok('switch', { switched: true, to: { slot: 3 }, warnings: [] }))) },
      refresher,
      new OperationGate(),
    );
    assert.deepEqual(await service.switch({ kind: 'slot', slot: 3 }, confirmed), { kind: 'rejected', reason: 'account-changed' });
    assert.equal(calls, 0);
  });

  it('trusts a snapshot under 15 s old and switches without re-reading first (speed)', async () => {
    const fresh: AccountsSnapshot = { ...confirmed, capturedAt: 1_000_000 };
    const refresher = { ...refresherReturning(confirmed), getState: () => ({ snapshot: fresh }) };
    const service = new SwitchService(
      { switch: () => Promise.resolve(ok('switch', { switched: true, to: { slot: 3 }, warnings: [] })) },
      refresher,
      new OperationGate(),
      () => 1_000_000 + 5_000,
    );
    const outcome = await service.switch({ kind: 'slot', slot: 3 }, fresh);
    assert.equal(outcome.kind, 'switched');
    assert.deepEqual(
      refresher.requests.map((request) => request.trigger),
      ['post-switch'],
      'no pre-check, only the verification',
    );
  });

  it('re-checks a fresh snapshot when a later refresh failed or replaced it', async () => {
    const fresh: AccountsSnapshot = { ...confirmed, capturedAt: 1_000_000 };
    const switcher = () => ({ switch: () => Promise.resolve(ok('switch', { switched: true, to: { slot: 3 }, warnings: [] })) });
    for (const state of [
      { snapshot: fresh, lastError: cliError('timeout') },
      { snapshot: { ...fresh } },
    ]) {
      const refresher = { ...refresherReturning(confirmed), getState: () => state };
      const service = new SwitchService(switcher(), refresher, new OperationGate(), () => 1_000_000 + 5_000);
      await service.switch({ kind: 'slot', slot: 3 }, fresh);
      assert.equal(refresher.requests[0]?.trigger, 'manual', 'pre-check ran');
    }
  });

  it('proceeds when nothing changed', async () => {
    const refresher = refresherReturning(confirmed);
    const service = new ManagementService({ manage: () => Promise.resolve(ok('manage', undefined) as CliOutcome<void>) }, refresher, new OperationGate());
    const outcome = await service.apply({ kind: 'removeAlias', slot: 3 }, confirmed);
    assert.equal(outcome.kind, 'applied');
    assert.equal(refresher.requests.length, 2, 'pre-check refresh + verification refresh');
  });
});

describe('info-level hardening', () => {
  it('I2: redacts base64 secrets and profile names with spaces', () => {
    const base64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZn+/0123456789==';
    assert.equal(redactText(`token=${base64}`).includes(base64), false);
    assert.equal(redactText('C:\\Users\\John Smith\\.local\\bin'), 'C:\\Users\\<user>\\.local\\bin');
  });

  it('I3: does not pass ELECTRON_RUN_AS_NODE to the CLI', () => {
    const env = cliEnvironment({ ELECTRON_RUN_AS_NODE: '1', PATH: 'x' });
    assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
    assert.equal(env['PATH'], 'x');
  });

  it('I5: bounds JSON recovery attempts on pathological output', () => {
    const noise = Array.from({ length: 6 }, () => '{ not json').join('\n');
    assert.equal(parseJsonDocument(`banner\n${noise}\n{"ok":true}`).ok, false);
    assert.equal(parseJsonDocument('banner\n{"ok":true}').ok, true);
  });
});
