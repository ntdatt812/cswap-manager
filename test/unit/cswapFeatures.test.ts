import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autoSwitchRuleArgs, ruleMatches, validateRuleInput } from '../../src/core/cli/autoSwitchRules';
import { cliError } from '../../src/core/cli/cliErrors';
import { CswapCli, addArgs, addTokenArgs, manageArgs, parseAddOutput, parseRemoveOutput, tokenKind, type AddResult, type CliOutcome, type ManageOperation } from '../../src/core/cli/cswapCli';
import { isNewer, latestFromPypi, upgradeCommand } from '../../src/core/cli/cswapUpdate';
import {
  exportArgs,
  importArgs,
  importUsageArgs,
  isSafePathArgument,
  parseExportOutput,
  parseImportOutput,
  parseImportUsageOutput,
} from '../../src/core/cli/transfer';
import { NodeProcessRunner } from '../../src/core/cli/processRunner';
import { parseCliVersion, type CliVersion } from '../../src/core/cli/version';
import { comparablePath, mappingFor, parseMappingList } from '../../src/core/model/mappings';
import { applyPriorities, parsePriority, parsePriorityList, priorityOf, type PriorityEntry } from '../../src/core/model/priorities';
import { parseListOutput } from '../../src/core/model/parsers';
import { buildSnapshot } from '../../src/core/model/reconcile';
import type { AccountsSnapshot } from '../../src/core/model/types';
import { ManagementService, type ManageApplied } from '../../src/core/service/managementService';
import { PriorityStore } from '../../src/core/service/priorityStore';
import { OperationGate } from '../../src/core/service/operationGate';
import type { RefreshRequest, RefreshResult } from '../../src/core/service/refreshService';
import { draggedSlot, dropMove, previewMove, resolveDropTarget } from '../../src/core/presentation/accountDrag';
import { shownOrganization, type NodeModel } from '../../src/core/presentation/accountTree';
import { renewedLoginSlot, weeklyResets } from '../../src/core/presentation/snapshotChanges';
import { SLANT_BAR_PATTERN, usageBar } from '../../src/core/presentation/format';
import { tokenUsageLevel } from '../../src/core/presentation/quickSettings';
import { manageCliStubs, ok } from '../helpers/fixtures';

const version = (text: string): CliVersion => {
  const parsed = parseCliVersion(text);
  assert.ok(parsed);
  return parsed;
};

function snapshotOf(rows: ReadonlyArray<{ number: number; email: string }>, active = 1): AccountsSnapshot {
  const list = parseListOutput(
    JSON.stringify({ schemaVersion: 1, activeAccountNumber: active, accounts: rows.map((row) => ({ ...row, active: row.number === active, usageStatus: 'ok', usage: null })) }),
  );
  assert.ok(list.ok);
  return buildSnapshot(list.value, undefined, 1);
}

const PRIORITY_LIST = `Account priorities (higher first; default 0):
  Account-1  a@example.com  0
  Account-2  B@Example.com  50

Used only by: cswap auto --strategy priority-consume-first`;

describe('cswap priority', () => {
  it('validates tiers like cswap (whole numbers 0–1000)', () => {
    assert.equal(parsePriority(' 50 '), 50);
    assert.equal(parsePriority('0'), 0);
    assert.equal(parsePriority('1000'), 1000);
    for (const bad of ['1001', '-1', '1.5', '', 'ten', '--unset']) {
      assert.equal(parsePriority(bad), undefined, bad);
    }
  });

  it('reads the verified list format and refuses anything else', () => {
    assert.deepEqual(parsePriorityList(PRIORITY_LIST), [
      { slot: 1, email: 'a@example.com', tier: 0 },
      { slot: 2, email: 'b@example.com', tier: 50 },
    ]);
    assert.equal(parsePriorityList('something else'), undefined);
  });

  it('decides by slot, so accounts sharing an email (one per organization) keep their own tiers', () => {
    const shared = [
      { slot: 1, email: 'a@example.com', tier: 5 },
      { slot: 3, email: 'a@example.com', tier: 0 },
    ];
    assert.equal(priorityOf({ slot: 1, email: 'a@example.com' }, shared), 5);
    assert.equal(priorityOf({ slot: 3, email: 'A@example.com' }, shared), 0);
    // A list read before a move: the slot holds another email, and this email is not unique.
    assert.equal(priorityOf({ slot: 2, email: 'a@example.com' }, [...shared, { slot: 2, email: 'z@example.com', tier: 9 }]), undefined);
  });

  it('falls back to a unique email when the list predates a move', () => {
    const entries = parsePriorityList(PRIORITY_LIST) ?? [];
    const moved = snapshotOf([
      { number: 1, email: 'b@example.com' },
      { number: 2, email: 'a@example.com' },
    ]);
    const decorated = applyPriorities(moved, entries);
    assert.deepEqual(
      decorated.accounts.map((account) => `${account.slot}:${account.priority}`),
      ['1:50', '2:0'],
    );
    assert.equal(applyPriorities(decorated, entries), decorated, 'unchanged: same object');
    assert.equal(applyPriorities(decorated, undefined).accounts[0]?.priority, undefined, 'unknown again');
    assert.equal(priorityOf({ slot: 7 }, [{ slot: 7, tier: 3 }]), 3, 'no email: by slot');
  });

  it('builds priority and remove arguments from validated values only', () => {
    assert.deepEqual(manageArgs({ kind: 'setPriority', slot: 2, priority: 50 }), ['priority', '2', '50']);
    assert.deepEqual(manageArgs({ kind: 'clearPriority', slot: 2 }), ['priority', '2', '--unset']);
    assert.equal(manageArgs({ kind: 'setPriority', slot: 2, priority: 5000 }), undefined);
    assert.deepEqual(manageArgs({ kind: 'remove', slot: 3 }), ['remove', '3']);
    assert.equal(manageArgs({ kind: 'remove', slot: 0 }), undefined);
  });
});

describe('cswap add / remove', () => {
  it('builds add arguments only from a valid slot', () => {
    assert.deepEqual(addArgs({}), ['add']);
    assert.deepEqual(addArgs({ slot: 6 }), ['add', '--slot', '6']);
    assert.equal(addArgs({ slot: 0 }), undefined);
    assert.equal(addArgs({ slot: 1.5 }), undefined);
  });

  it('reads what cswap add and remove printed', () => {
    assert.deepEqual(parseAddOutput('Added Account 6: x@example.com [oauth]'), { ok: true, value: { kind: 'added', slot: 6 } });
    assert.deepEqual(parseAddOutput('Updated credentials for Account 2 (x@example.com)'), { ok: true, value: { kind: 'updated', slot: 2 } });
    assert.deepEqual(parseAddOutput('Moved from slot 2 → 6'), { ok: true, value: { kind: 'moved', slot: 6 } });
    assert.deepEqual(parseAddOutput('Slot 3 already occupied\nOverwrite slot 3? [y/N] Cancelled'), { ok: true, value: { kind: 'cancelled' } });
    assert.equal(parseAddOutput('???').ok, false);
    assert.equal(parseRemoveOutput('Removed Account-3 (x@example.com)').ok, true);
    assert.equal(parseRemoveOutput('Are you sure…? [y/N] Cancelled').ok, false, 'a prompt that was not confirmed is a failure');
  });

  it('answers a CLI prompt through stdin, and leaves stdin closed otherwise', async () => {
    const runner = new NodeProcessRunner();
    const echo = ['-e', "process.stdin.on('data', (d) => process.stdout.write(String(d))); process.stdin.on('end', () => process.stdout.write('<eof>'))"];
    const answered = await runner.run(process.execPath, echo, { timeoutMs: 10_000, maxOutputBytes: 4096, input: 'y\n' });
    assert.ok(answered.kind === 'exited');
    assert.equal(answered.stdout, 'y\n<eof>');
    const closed = await runner.run(process.execPath, echo, { timeoutMs: 10_000, maxOutputBytes: 4096 });
    assert.ok(closed.kind === 'exited');
    assert.equal(closed.stdout, '<eof>');
  });
});

describe('management of priorities, removal and adding', () => {
  const BEFORE = snapshotOf([
    { number: 1, email: 'a@example.com' },
    { number: 2, email: 'b@example.com' },
  ]);

  function fake(after: AccountsSnapshot, read: CliOutcome<PriorityEntry[]> = ok('priority', []), add?: CliOutcome<AddResult>) {
    const requests: RefreshRequest[] = [];
    const tokenCalls: Array<{ token: string; options: { slot?: number; email?: string } }> = [];
    return {
      requests,
      tokenCalls,
      cli: {
        manage: (_: ManageOperation) => Promise.resolve(ok('manage', undefined)),
        priorities: () => Promise.resolve(read),
        addAccount: () => Promise.resolve(add ?? ok('manage', { kind: 'cancelled' as const })),
        addToken: (token: string, options: { slot?: number; email?: string }) => {
          tokenCalls.push({ token, options });
          return Promise.resolve(add ?? ok('manage', { kind: 'cancelled' as const }));
        },
      },
      refresher: {
        getState: () => ({ snapshot: BEFORE }),
        refresh: (request: RefreshRequest): Promise<RefreshResult> => {
          requests.push(request);
          return Promise.resolve({ ok: true, snapshot: after });
        },
      },
    };
  }

  it('verifies a priority change by reading cswap priority back', async () => {
    const good = fake(BEFORE, ok('priority', [{ slot: 2, email: 'b@example.com', tier: 50 }]));
    assert.deepEqual(await new ManagementService(good.cli, good.refresher, new OperationGate()).apply({ kind: 'setPriority', slot: 2, priority: 50 }), {
      kind: 'applied',
      verification: 'confirmed',
    });
    const wrong = fake(BEFORE, ok('priority', [{ slot: 2, email: 'b@example.com', tier: 10 }]));
    assert.equal(((await new ManagementService(wrong.cli, wrong.refresher, new OperationGate()).apply({ kind: 'setPriority', slot: 2, priority: 50 })) as { verification?: string }).verification, 'mismatch');
    // cswap lists every account, 0 included.
    const cleared = fake(BEFORE, ok('priority', [{ slot: 1, email: 'a@example.com', tier: 0 }, { slot: 2, email: 'b@example.com', tier: 0 }]));
    assert.deepEqual(await new ManagementService(cleared.cli, cleared.refresher, new OperationGate()).apply({ kind: 'clearPriority', slot: 2 }), {
      kind: 'applied',
      verification: 'confirmed',
    });
    // A list that cannot identify the account never confirms anything.
    const unclear = fake(BEFORE, ok('priority', []));
    assert.deepEqual(await new ManagementService(unclear.cli, unclear.refresher, new OperationGate()).apply({ kind: 'clearPriority', slot: 2 }), {
      kind: 'applied',
      verification: 'unverified',
    });
  });

  it('confirms a removal only when the account is gone (followed by email)', async () => {
    const gone = fake(snapshotOf([{ number: 1, email: 'a@example.com' }]));
    assert.deepEqual(await new ManagementService(gone.cli, gone.refresher, new OperationGate()).apply({ kind: 'remove', slot: 2 }), { kind: 'applied', verification: 'confirmed' });
    const still = fake(snapshotOf([{ number: 1, email: 'a@example.com' }, { number: 5, email: 'b@example.com' }]));
    assert.equal(((await new ManagementService(still.cli, still.refresher, new OperationGate()).apply({ kind: 'remove', slot: 2 })) as { verification?: string }).verification, 'mismatch');
  });

  it('adds the current login and checks it became the active account in that slot', async () => {
    const added = fake(snapshotOf([{ number: 1, email: 'a@example.com' }, { number: 2, email: 'b@example.com' }, { number: 3, email: 'c@example.com' }], 3), undefined, ok('manage', { kind: 'added', slot: 3 }));
    const service = new ManagementService(added.cli, added.refresher, new OperationGate());
    let applied = 0;
    service.onDidApply(() => applied++);
    assert.deepEqual(await service.addCurrent({ slot: 3 }), { kind: 'added', result: { kind: 'added', slot: 3 }, verification: 'confirmed' });
    assert.equal(applied, 1);
    assert.equal(added.requests[0]?.verifyActive, true);
    const cancelled = fake(BEFORE, undefined, ok('manage', { kind: 'cancelled' }));
    assert.deepEqual(await new ManagementService(cancelled.cli, cancelled.refresher, new OperationGate()).addCurrent({}), { kind: 'cancelled' });
    const failed = fake(BEFORE, undefined, { ok: false, error: cliError('timeout', { command: 'manage' }), meta: { command: 'manage' } });
    assert.equal((await new ManagementService(failed.cli, failed.refresher, new OperationGate()).addCurrent({})).kind, 'failed');
  });

  it('adds a token account and checks only that its slot is listed (the active account stays)', async () => {
    const listed = snapshotOf([{ number: 1, email: 'a@example.com' }, { number: 2, email: 'b@example.com' }, { number: 4, email: 'setup-token-4@token.local' }], 1);
    const added = fake(listed, undefined, ok('manage', { kind: 'added', slot: 4 }));
    const service = new ManagementService(added.cli, added.refresher, new OperationGate());
    assert.deepEqual(await service.addToken('sk-ant-oat01-abc', { slot: 4 }), { kind: 'added', result: { kind: 'added', slot: 4 }, verification: 'confirmed' });
    assert.deepEqual(added.tokenCalls, [{ token: 'sk-ant-oat01-abc', options: { slot: 4 } }]);
    assert.equal(added.requests[0]?.verifyActive, false, 'no cswap status: the active account did not change');
    const missing = fake(BEFORE, undefined, ok('manage', { kind: 'added', slot: 4 }));
    assert.equal(((await new ManagementService(missing.cli, missing.refresher, new OperationGate()).addToken('sk-ant-oat01-abc', { slot: 4 })) as { verification?: string }).verification, 'mismatch');
  });
});

describe('cswap add-token', () => {
  const SETUP = `sk-ant-oat01-${'A'.repeat(40)}`;
  const KEY = `sk-ant-api03-${'b'.repeat(40)}`;

  it('tells setup-tokens from API keys the way cswap does, and refuses anything else', () => {
    assert.equal(tokenKind(SETUP), 'setup-token');
    assert.equal(tokenKind(`  ${SETUP}\n`), 'setup-token');
    assert.equal(tokenKind(`sk-ant-ort01-${'c'.repeat(40)}`), 'setup-token');
    assert.equal(tokenKind(KEY), 'api-key');
    assert.equal(tokenKind(`sk-ant-usr-${'d'.repeat(40)}`), 'api-key');
    for (const bad of ['', 'sk-ant-short', `${SETUP} extra`, `${SETUP}\nsecond`, `Bearer ${SETUP}`, `sk-ant-oat01-${'A'.repeat(30)}"`]) {
      assert.equal(tokenKind(bad), undefined, JSON.stringify(bad.slice(0, 20)));
    }
  });

  it('never puts the token in the arguments', () => {
    assert.deepEqual(addTokenArgs({}), ['add-token', '-']);
    assert.deepEqual(addTokenArgs({ slot: 6, email: 'me@example.com' }), ['add-token', '-', '--slot', '6', '--email', 'me@example.com']);
    assert.equal(addTokenArgs({ slot: 0 }), undefined);
    for (const email of ['-x@example.com', '--force', 'no-at-sign', 'a@b', 'a b@example.com']) {
      assert.equal(addTokenArgs({ email }), undefined, email);
    }
  });

  it('sends the token on stdin only and refuses a malformed one without running cswap', async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const cli = new CswapCli({
      runner: {
        run: (_file, args, options) => {
          calls.push({ args, ...(options.input === undefined ? {} : { input: options.input }) });
          return Promise.resolve({ kind: 'exited', exitCode: 0, signal: null, stdout: 'Added Account 6: setup-token-6@token.local [personal] (from token)\n', stderr: '', durationMs: 2 });
        },
      },
      resolveExecutable: () => Promise.resolve({ ok: true, path: 'C:\\bin\\cswap.exe', source: 'path' }),
      settings: () => ({ timeoutMs: 10_000, maxOutputBytes: 4096 }),
      workingDirectory: 'C:\\Users\\dev',
      baseEnv: {},
      homeDir: 'C:\\Users\\dev',
    });
    const outcome = await cli.addToken(` ${SETUP} `, { slot: 6 });
    assert.deepEqual(outcome.ok ? outcome.value : undefined, { kind: 'added', slot: 6 });
    assert.deepEqual(calls, [{ args: ['add-token', '-', '--slot', '6'], input: `${SETUP}\n` }]);
    assert.ok(!calls[0]!.args.some((arg) => arg.includes('sk-ant')));

    const refused = await cli.addToken('not a token', { slot: 6 });
    assert.equal(refused.ok ? 'ok' : refused.error.kind, 'invalid-request');
    assert.equal(calls.length, 1);
  });

  it('reads what cswap add-token printed', () => {
    assert.deepEqual(parseAddOutput('Updated token for Account 4 (setup-token-4@token.local [personal]).'), { ok: true, value: { kind: 'updated', slot: 4 } });
    assert.deepEqual(parseAddOutput('Updated API key for Account 5 (k@example.com [personal]).'), { ok: true, value: { kind: 'updated', slot: 5 } });
  });
});

describe('re-reading before a change', () => {
  const BEFORE = snapshotOf([
    { number: 1, email: 'a@example.com' },
    { number: 2, email: 'b@example.com' },
  ]);

  function counting(lastError?: unknown) {
    const requests: RefreshRequest[] = [];
    return {
      requests,
      cli: {
        ...manageCliStubs,
        manage: (_: ManageOperation) => Promise.resolve(ok('manage', undefined)),
      },
      refresher: {
        getState: () => ({ snapshot: BEFORE, ...(lastError === undefined ? {} : { lastError }) }),
        refresh: (request: RefreshRequest): Promise<RefreshResult> => {
          requests.push(request);
          return Promise.resolve({ ok: true, snapshot: BEFORE });
        },
      },
    };
  }

  it('is skipped only for fresh data that is still the latest read, like switching', async () => {
    const move: ManageOperation = { kind: 'move', slot: 1, targetSlot: 2 };
    const fresh = counting();
    await new ManagementService(fresh.cli, fresh.refresher, new OperationGate(), () => BEFORE.capturedAt + 1_000).apply(move, BEFORE);
    assert.equal(fresh.requests.length, 1, 'only the refresh after the move');
    const old = counting();
    await new ManagementService(old.cli, old.refresher, new OperationGate(), () => BEFORE.capturedAt + 60_000).apply(move, BEFORE);
    assert.equal(old.requests.length, 2, 'older than 15 s: re-read first');
    const failed = counting(new Error('refresh failed'));
    await new ManagementService(failed.cli, failed.refresher, new OperationGate(), () => BEFORE.capturedAt + 1_000).apply(move, BEFORE);
    assert.equal(failed.requests.length, 2, 'a later refresh failed: re-read first');
  });
});

describe('cswap map', () => {
  it('reads the verified list format, including the empty message', () => {
    assert.deepEqual(parseMappingList('No directory mappings yet.\nMap one with: cswap map <NUM|EMAIL> [PATH]'), []);
    assert.deepEqual(parseMappingList('Directory mappings:\n  d:\\projects\\hotel → 3: a@example.com\n  d:\\old → gone@example.com (account removed)'), [
      { path: 'd:\\projects\\hotel', slot: 3 },
      { path: 'd:\\old' },
    ]);
    assert.equal(parseMappingList('unexpected'), undefined);
  });

  it('finds the mapping for a folder like cswap: longest parent, case-insensitive on Windows', () => {
    const entries = [{ path: 'd:\\projects', slot: 1 }, { path: 'd:\\projects\\hotel', slot: 3 }];
    assert.equal(mappingFor('D:\\Projects\\Hotel\\src', entries, 'win32')?.slot, 3);
    assert.equal(mappingFor('d:\\projects\\other', entries, 'win32')?.slot, 1);
    assert.equal(mappingFor('d:\\projectsX', entries, 'win32'), undefined, 'a sibling with the same prefix is not a child');
    assert.equal(comparablePath('D:/Projects/Hotel/', 'win32'), 'd:\\projects\\hotel');
  });

  it('only passes absolute folders that cannot be read as flags', () => {
    assert.equal(isSafePathArgument('d:\\projects\\hotel', 'win32'), true);
    assert.equal(isSafePathArgument('-rf', 'win32'), false);
    assert.equal(isSafePathArgument('relative\\path', 'win32'), false);
    assert.equal(isSafePathArgument('/home/me/project', 'linux'), true);
    assert.equal(isSafePathArgument('/home/me\nproject', 'linux'), false);
  });
});

describe('per-model limits (autoswitch.model)', () => {
  it('accepts "all" or plain model names, and nothing that could become a flag', () => {
    assert.deepEqual(validateRuleInput('autoswitch.model', 'ALL'), { ok: true, value: 'all' });
    assert.deepEqual(validateRuleInput('autoswitch.model', ' Fable , Opus '), { ok: true, value: 'Fable,Opus' });
    for (const bad of ['--force', 'a;b', '', ',', 'x'.repeat(41)]) {
      assert.equal(validateRuleInput('autoswitch.model', bad).ok, false, bad);
    }
    assert.deepEqual(autoSwitchRuleArgs({ key: 'autoswitch.model', value: 'Fable' }), ['config', 'set', 'autoswitch.model', 'Fable']);
    assert.equal(ruleMatches({ model: 'Fable', customized: ['autoswitch.model'] }, 'autoswitch.model', 'Fable'), true);
    assert.equal(ruleMatches({ customized: [] }, 'autoswitch.model', ''), true, 'reset to default');
  });
});

describe('more cswap settings (hysteresis, unhealthy checks, history sharing, token usage)', () => {
  it('validates with the ranges in cswap SETTING_SPECS', () => {
    assert.deepEqual(validateRuleInput('autoswitch.hysteresisPct', '12.5'), { ok: true, value: '12.5' });
    assert.deepEqual(validateRuleInput('autoswitch.hysteresisPct', '0'), { ok: true, value: '0' });
    for (const bad of ['50.1', '-1', 'abc', '']) {
      assert.equal(validateRuleInput('autoswitch.hysteresisPct', bad).ok, false, bad);
    }
    assert.deepEqual(validateRuleInput('autoswitch.unhealthyTicks', '5'), { ok: true, value: '5' });
    for (const bad of ['0', '101', '2.5', '--x']) {
      assert.equal(validateRuleInput('autoswitch.unhealthyTicks', bad).ok, false, bad);
    }
    for (const key of ['run.shareHistory', 'usage.headerProbe', 'usage.fableProbe'] as const) {
      assert.deepEqual(validateRuleInput(key, 'false'), { ok: true, value: 'false' });
      assert.equal(validateRuleInput(key, 'yes').ok, false, 'only true/false are written');
    }
  });

  it('builds config arguments and verifies booleans read back', () => {
    assert.deepEqual(autoSwitchRuleArgs({ key: 'usage.headerProbe', value: true }), ['config', 'set', 'usage.headerProbe', 'true']);
    assert.deepEqual(autoSwitchRuleArgs({ key: 'autoswitch.unhealthyTicks', value: 4 }), ['config', 'set', 'autoswitch.unhealthyTicks', '4']);
    assert.equal(autoSwitchRuleArgs({ key: 'autoswitch.hysteresisPct', value: 80 }), undefined);
    assert.equal(ruleMatches({ shareHistory: false, customized: ['run.shareHistory'] }, 'run.shareHistory', 'false'), true);
    assert.equal(ruleMatches({ headerProbe: false, customized: [] }, 'usage.headerProbe', 'true'), false);
    assert.equal(ruleMatches({ unhealthyTicks: 4, customized: ['autoswitch.unhealthyTicks'] }, 'autoswitch.unhealthyTicks', '4'), true);
  });

  it('reads the token-usage level from the two probe settings', () => {
    assert.equal(tokenUsageLevel(undefined), undefined);
    assert.equal(tokenUsageLevel({}), 'off');
    assert.equal(tokenUsageLevel({ fableProbe: true }), 'off', 'the Fable probe acts only with the Haiku one');
    assert.equal(tokenUsageLevel({ headerProbe: true }), 'haiku');
    assert.equal(tokenUsageLevel({ headerProbe: true, fableProbe: true }), 'fable');
  });
});

describe('cswap update check', () => {
  it('reads the latest release from PyPI and compares versions', () => {
    assert.equal(latestFromPypi(JSON.stringify({ info: { version: '1.3.0' } }))?.text, '1.3.0');
    assert.equal(latestFromPypi(JSON.stringify({ info: { version: '1.3.0rc1' } })), undefined, 'pre-releases are ignored');
    assert.equal(latestFromPypi('not json'), undefined);
    assert.equal(isNewer(version('1.3.0'), version('1.2.0')), true);
    assert.equal(isNewer(version('1.2.0'), version('1.2.0')), false);
    assert.equal(isNewer(version('1.10.0'), version('1.9.9')), true);
    assert.equal(isNewer(version('1.2.9'), version('2.0.0')), false);
  });

  it('suggests the upgrade command for the way cswap was installed', () => {
    const none = { uv: false, pipx: false };
    assert.equal(upgradeCommand('C:\\Users\\me\\AppData\\Roaming\\uv\\tools\\claude-swap\\Scripts\\cswap.exe', none), 'uv tool upgrade claude-swap');
    assert.equal(upgradeCommand('/home/me/.local/pipx/venvs/claude-swap/bin/cswap', none), 'pipx upgrade claude-swap');
    // uv and pipx both put launchers in ~/.local/bin: the installer whose environment exists decides.
    const launcher = 'C:\\Users\\me\\.local\\bin\\cswap.exe';
    assert.equal(upgradeCommand(launcher, { uv: true, pipx: false }), 'uv tool upgrade claude-swap');
    assert.equal(upgradeCommand(launcher, { uv: false, pipx: true }), 'pipx upgrade claude-swap');
    assert.equal(upgradeCommand(launcher, { uv: true, pipx: true }), undefined, 'ambiguous');
    assert.equal(upgradeCommand(launcher, none), undefined);
    assert.equal(upgradeCommand('D:\\tools\\cswap.exe', { uv: true, pipx: false }), undefined);
  });
});

describe('cswap export / import / import-usage', () => {
  it('always passes a real file path, never "-" (stdin/stdout), and only validated options', () => {
    // Paths are absolute for the platform running the tests.
    const file = process.platform === 'win32' ? 'C:\\Users\\me\\backup.json' : '/home/me/backup.json';
    assert.deepEqual(exportArgs(file), ['export', file]);
    assert.deepEqual(exportArgs(file, 3), ['export', file, '--account', '3']);
    assert.equal(exportArgs('-'), undefined);
    assert.equal(exportArgs('backup.json'), undefined, 'relative');
    assert.equal(exportArgs(file, 0), undefined);
    assert.deepEqual(importArgs(file, false), ['import', file]);
    assert.deepEqual(importArgs(file, true), ['import', file, '--force']);
    assert.equal(importArgs('-', false), undefined);
    assert.deepEqual(importUsageArgs(file), ['import-usage', file]);
    assert.deepEqual(importUsageArgs(file, 600), ['import-usage', file, '--hold', '600']);
    assert.deepEqual(importUsageArgs(file, 0), ['import-usage', file, '--hold', '0']);
    assert.equal(importUsageArgs(file, -1), undefined);
    assert.equal(importUsageArgs(file, 1.5), undefined);
    assert.equal(isSafePathArgument('\\\\server\\share\\b.json', 'win32'), true);
    assert.equal(isSafePathArgument('C:\\a\u0007b.json', 'win32'), false);
  });

  it('reads the summaries cswap prints on stderr', () => {
    assert.deepEqual(parseExportOutput('Skipping Account-2 (x@example.com): no stored credentials/config — re-add with: cswap --add-account --slot 2\nExported 3 account(s) to C:\\b.json\n'), {
      ok: true,
      value: { exported: 3, skipped: 1 },
    });
    assert.equal(parseExportOutput('').ok, false);
    assert.deepEqual(parseImportOutput('Imported a@example.com → slot 4\nSkipped b@example.com (already exists, use --force)\nDone: 1 imported, 0 overwritten, 1 skipped\n'), {
      ok: true,
      value: { imported: 1, overwritten: 0, skipped: 1, replaced: 0 },
    });
    assert.deepEqual(
      parseImportOutput(
        'Overwrote a@example.com (slot 1)\nDone: 0 imported, 1 overwritten, 0 skipped, 2 replaced (dead token)\nNote: a@example.com is your current live login — activate the imported credentials with: cswap --switch-to 1 --force\n',
      ),
      { ok: true, value: { imported: 0, overwritten: 1, skipped: 0, replaced: 2, liveSlot: 1 } },
    );
    assert.equal(parseImportOutput('Error: import file not found').ok, false);
    assert.deepEqual(parseImportUsageOutput('Adopted usage for a@example.com → slot 1\nDone: 1 adopted, 0 kept, 2 skipped; fetching held for up to 600s\n'), {
      ok: true,
      value: { adopted: 1, kept: 0, skipped: 2 },
    });
    assert.equal(parseImportUsageOutput('nothing').ok, false);
  });
});

describe('slanted bars drawn with the extension icons', () => {
  const icons = (...cells: number[]): string => cells.map((cell) => `$(cswap-slant-${cell})`).join('');
  const repeat = (cell: number, count: number): number[] => Array.from({ length: count }, () => cell);

  it('fills the last cell in eighths where icons render', () => {
    assert.equal(usageBar(54, 10, 'parallelograms', { icons: true }), icons(...repeat(8, 5), 3, ...repeat(0, 4)));
    assert.equal(usageBar(50, 10, 'parallelograms', { icons: true }), icons(...repeat(8, 5), ...repeat(0, 5)));
    assert.equal(usageBar(1, 10, 'parallelograms', { icons: true }), icons(1, ...repeat(0, 9)), '1% is a sliver, not a whole cell');
    assert.equal(usageBar(98, 10, 'parallelograms', { icons: true }), icons(...repeat(8, 9), 6), '98% is not shown as 90%');
    assert.equal(usageBar(99.9, 10, 'parallelograms', { icons: true }), icons(...repeat(8, 9), 7), 'never full below 100%');
    assert.equal(usageBar(100, 10, 'parallelograms', { icons: true }), icons(...repeat(8, 10)));
    assert.equal(usageBar(0, 10, 'parallelograms', { icons: true }), icons(...repeat(0, 10)));
    assert.ok(SLANT_BAR_PATTERN.test(usageBar(37, 8, 'parallelograms', { icons: true })));
  });

  it('keeps Unicode glyphs where icons cannot render (tree items) and for other styles', () => {
    assert.equal(usageBar(54, 10, 'parallelograms'), '▰▰▰▰▰▱▱▱▱▱');
    assert.equal(usageBar(54, 10, 'blocks', { icons: true }), '█████▍░░░░');
  });

  it('recognises a bar made only of slant icons (what a tooltip may render as Markdown)', () => {
    assert.equal(SLANT_BAR_PATTERN.test(icons(8, 3, 0)), true);
    assert.equal(SLANT_BAR_PATTERN.test(`${icons(8)} $(gear)`), false);
    assert.equal(SLANT_BAR_PATTERN.test('$(cswap-slant-9)'), false);
  });
});

describe('drag and drop in the Accounts view', () => {
  const node = (kind: NodeModel['kind'], slot?: number): NodeModel => ({
    id: `${kind}:${slot ?? '-'}`,
    kind,
    label: 'x',
    collapsible: 'none',
    children: [],
    ...(slot === undefined ? {} : { slot }),
  });

  it('drags exactly one account, never a usage row or several items', () => {
    assert.equal(draggedSlot([node('account', 3)]), 3);
    assert.equal(draggedSlot([node('window', 3)]), undefined);
    assert.equal(draggedSlot([node('account', 3), node('account', 4)]), undefined);
    assert.equal(draggedSlot([]), undefined);
  });

  it('drops onto an account or any of its rows, or onto empty space to go to the end', () => {
    assert.deepEqual(dropMove(3, node('account', 1)), { slot: 3, target: 1 });
    assert.deepEqual(dropMove(3, node('window', 1)), { slot: 3, target: 1 }, 'a usage row counts as its account');
    assert.equal(dropMove(3, node('account', 3)), undefined, 'onto itself');
    assert.equal(dropMove(3, node('detail', 3)), undefined, 'onto one of its own rows');
    assert.equal(dropMove(3, node('window')), undefined, 'a row without an account');
    assert.deepEqual(dropMove(3, undefined), { slot: 3, target: 'end' });
    assert.equal(dropMove(0, node('account', 1)), undefined);
    assert.equal(resolveDropTarget(2, 'end', [1, 2, 5]), 6, 'after the highest slot');
    assert.equal(resolveDropTarget(5, 'end', [1, 2, 5]), undefined, 'already last');
    assert.equal(resolveDropTarget(2, 4, [1, 2, 4]), 4);
  });

  it('shows the move at once, and stops once a refresh already shows it', () => {
    const before = snapshotOf([
      { number: 1, email: 'a@example.com' },
      { number: 2, email: 'b@example.com' },
    ]);
    const move = { slot: 2, targetSlot: 1, dragged: { email: 'b@example.com' } };
    const shown = previewMove(before, move);
    assert.deepEqual(
      shown.accounts.map((account) => `${account.slot}:${account.email}`),
      ['2:a@example.com', '1:b@example.com'],
    );
    assert.equal(shown.active.slot, 2, 'the active account (a) now shows slot 2');
    const afterRefresh = snapshotOf([
      { number: 1, email: 'b@example.com' },
      { number: 2, email: 'a@example.com' },
    ]);
    assert.equal(previewMove(afterRefresh, move), afterRefresh, 'already moved: nothing swapped back');
    const toEnd = previewMove(before, { slot: 1, targetSlot: 3, dragged: { email: 'a@example.com' } });
    assert.deepEqual(
      toEnd.accounts.map((account) => `${account.slot}:${account.email}`),
      ['3:a@example.com', '2:b@example.com'],
    );
  });
});

describe('priorities kept in step with account changes', () => {
  const SNAPSHOT = snapshotOf([
    { number: 1, email: 'a@example.com' },
    { number: 2, email: 'b@example.com' },
  ]);

  it('reuses the read that verified a priority change and re-reads only after changes that can move tiers', async () => {
    let reads = 0;
    let changes = 0;
    const store = new PriorityStore(
      () => {
        reads++;
        return Promise.resolve(ok('priority', [{ slot: 2, email: 'b@example.com', tier: 7 }]));
      },
      () => changes++,
      () => undefined,
    );
    store.onApplied({ prioritiesChanged: true, priorities: [{ slot: 1, email: 'a@example.com', tier: 3 }] });
    assert.equal(reads, 0, 'the verifying read is reused');
    assert.equal(store.apply(SNAPSHOT).accounts[0]?.priority, 3);
    store.onApplied({ prioritiesChanged: false });
    assert.equal(reads, 0, 'a rotation or threshold change cannot move tiers');
    store.onApplied({ prioritiesChanged: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 1, 'a move, removal or add re-reads');
    assert.equal(store.apply(SNAPSHOT).accounts[1]?.priority, 7);
    assert.equal(changes, 2);
  });

  it('tells listeners what a change means for priorities', async () => {
    const events: ManageApplied[] = [];
    const cli = {
      ...manageCliStubs,
      manage: () => Promise.resolve(ok('manage', undefined)),
      priorities: () => Promise.resolve(ok('priority', [{ slot: 2, email: 'b@example.com', tier: 5 }])),
    };
    const refresher = { getState: () => ({ snapshot: SNAPSHOT }), refresh: (): Promise<RefreshResult> => Promise.resolve({ ok: true, snapshot: SNAPSHOT }) };
    const service = new ManagementService(cli, refresher, new OperationGate());
    service.onDidApply((event) => events.push(event));
    await service.apply({ kind: 'setPriority', slot: 2, priority: 5 });
    await service.apply({ kind: 'setThreshold', slot: 2, threshold: 80 });
    assert.deepEqual(events, [
      { prioritiesChanged: true, priorities: [{ slot: 2, email: 'b@example.com', tier: 5 }] },
      { prioritiesChanged: false },
    ]);
  });
});

describe('logging in again to an account cswap already has', () => {
  const NOW = Date.parse('2026-11-24T12:00:00Z');
  const DAY = 86_400_000;
  type Row = { number: number; email: string; loginExpiresAt?: string; usageStatus?: string };
  const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
  function snapshot(rows: Row[], active: number): AccountsSnapshot {
    const list = parseListOutput(
      JSON.stringify({ schemaVersion: 1, activeAccountNumber: active, accounts: rows.map((row) => ({ usageStatus: 'ok', usage: null, ...row, active: row.number === active })) }),
    );
    assert.ok(list.ok);
    return buildSnapshot(list.value, undefined, 1);
  }

  it('finds the slot whose expired or refused login was just renewed', () => {
    const before = snapshot([{ number: 1, email: 'a@example.com', loginExpiresAt: at(300 * DAY) }, { number: 2, email: 'b@example.com', loginExpiresAt: at(-DAY) }], 1);
    const after = snapshot([{ number: 1, email: 'a@example.com', loginExpiresAt: at(300 * DAY) }, { number: 2, email: 'B@example.com', loginExpiresAt: at(365 * DAY) }], 2);
    assert.equal(renewedLoginSlot(before, after, NOW), 2);

    const refused = snapshot([{ number: 2, email: 'b@example.com', loginExpiresAt: at(200 * DAY), usageStatus: 'relogin_required' }], 1);
    assert.equal(renewedLoginSlot(refused, snapshot([{ number: 2, email: 'b@example.com', loginExpiresAt: at(365 * DAY) }], 2), NOW), 2);
  });

  it('ignores a plain switch, a healthy account and a login that is still due', () => {
    const expired = snapshot([{ number: 2, email: 'b@example.com', loginExpiresAt: at(-DAY) }], 1);
    // `cswap switch 2` restores the stored (still expired) login: nothing was renewed.
    assert.equal(renewedLoginSlot(expired, snapshot([{ number: 2, email: 'b@example.com', loginExpiresAt: at(-DAY) }], 2), NOW), undefined);
    assert.equal(renewedLoginSlot(expired, snapshot([{ number: 2, email: 'b@example.com', loginExpiresAt: at(3 * DAY) }], 2), NOW), undefined, 'still within 7 days');
    const healthy = snapshot([{ number: 2, email: 'b@example.com', loginExpiresAt: at(100 * DAY) }], 2);
    assert.equal(renewedLoginSlot(healthy, snapshot([{ number: 2, email: 'b@example.com', loginExpiresAt: at(365 * DAY) }], 2), NOW), undefined);
    assert.equal(renewedLoginSlot(undefined, healthy, NOW), undefined);
  });
});

describe('weekly resets and default organizations', () => {
  const DAY = 86_400_000;
  const base = Date.parse('2026-11-24T12:00:00Z');
  type Row = { number: number; email: string; pct?: number; resetsAt?: number; organizationName?: string };
  function snapshot(rows: Row[]): AccountsSnapshot {
    const list = parseListOutput(
      JSON.stringify({
        schemaVersion: 1,
        activeAccountNumber: 1,
        accounts: rows.map((row) => ({
          number: row.number,
          email: row.email,
          active: row.number === 1,
          usageStatus: 'ok',
          ...(row.organizationName === undefined ? {} : { organizationName: row.organizationName }),
          usage: row.resetsAt === undefined ? null : { sevenDay: { pct: row.pct ?? 0, resetsAt: new Date(row.resetsAt).toISOString() } },
        })),
      }),
    );
    assert.ok(list.ok);
    return buildSnapshot(list.value, undefined, 1);
  }

  it('finds accounts whose weekly window started a new period after being used', () => {
    const before = snapshot([
      { number: 1, email: 'a@example.com', pct: 60, resetsAt: base + DAY },
      { number: 2, email: 'b@example.com', pct: 0, resetsAt: base + DAY },
      { number: 3, email: 'c@example.com', pct: 30, resetsAt: base + 3 * DAY },
    ]);
    const after = snapshot([
      { number: 1, email: 'a@example.com', pct: 0, resetsAt: base + 8 * DAY },
      { number: 2, email: 'b@example.com', pct: 0, resetsAt: base + 8 * DAY },
      { number: 3, email: 'c@example.com', pct: 31, resetsAt: base + 3 * DAY + 60_000 },
    ]);
    assert.deepEqual(weeklyResets(before, after).map((account) => account.slot), [1], 'unused (2) and a slightly moved reset time (3) are not resets');
    assert.deepEqual(weeklyResets(undefined, after), []);
    const moved = snapshot([{ number: 1, email: 'other@example.com', pct: 0, resetsAt: base + 8 * DAY }]);
    assert.deepEqual(weeklyResets(before, moved), [], 'another account in the slot is not a reset');
  });

  it('hides the default organization of a personal account', () => {
    const [own, team] = snapshot([
      { number: 1, email: 'Me@example.com', organizationName: "me@example.com's Organization" },
      { number: 2, email: 'b@example.com', organizationName: 'Acme Corp' },
    ]).accounts;
    assert.ok(own && team);
    assert.equal(shownOrganization(own), undefined);
    assert.equal(shownOrganization(team), 'Acme Corp');
  });
});
