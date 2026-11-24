import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autoSwitchRuleArgs, ruleMatches, validateRuleInput } from '../../src/core/cli/autoSwitchRules';
import { cliError } from '../../src/core/cli/cliErrors';
import { addArgs, manageArgs, parseAddOutput, parseRemoveOutput, type AddResult, type CliOutcome, type ManageOperation } from '../../src/core/cli/cswapCli';
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
import { ManagementService } from '../../src/core/service/managementService';
import { OperationGate } from '../../src/core/service/operationGate';
import type { RefreshRequest, RefreshResult } from '../../src/core/service/refreshService';
import { draggedSlot, dropMove } from '../../src/core/presentation/accountDrag';
import type { NodeModel } from '../../src/core/presentation/accountTree';
import { SLANT_BAR_PATTERN, usageBar } from '../../src/core/presentation/format';
import { sanitizeLabelKeepingBars } from '../../src/core/presentation/statusBar';
import { ok } from '../helpers/fixtures';

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
  it('builds add arguments only from a valid slot and alias', () => {
    assert.deepEqual(addArgs({}), ['add']);
    assert.deepEqual(addArgs({ slot: 6, alias: 'Work' }), ['add', '--slot', '6', '--alias', 'work']);
    assert.equal(addArgs({ slot: 0 }), undefined);
    assert.equal(addArgs({ alias: '-x' }), undefined);
    assert.equal(addArgs({ alias: 'a b' }), undefined);
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
    return {
      requests,
      cli: {
        manage: (_: ManageOperation) => Promise.resolve(ok('manage', undefined)),
        priorities: () => Promise.resolve(read),
        ...(add === undefined ? {} : { addAccount: () => Promise.resolve(add) }),
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
      cli: { manage: (_: ManageOperation) => Promise.resolve(ok('manage', undefined)) },
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

  it('lets only the bar icons through a sanitised label', () => {
    assert.equal(sanitizeLabelKeepingBars(`7d ${icons(8, 3, 0)} 54%`), `7d ${icons(8, 3, 0)} 54%`);
    assert.equal(sanitizeLabelKeepingBars('$(gear) $(cswap-slant-9) $(cswap-slant-1x)'), '$\u200b(gear) $\u200b(cswap-slant-9) $\u200b(cswap-slant-1x)');
    assert.equal(SLANT_BAR_PATTERN.test(`${icons(8)} $(gear)`), false);
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

  it('drops onto another account only: the dragged account takes its slot', () => {
    assert.deepEqual(dropMove(3, node('account', 1)), { slot: 3, targetSlot: 1 });
    assert.equal(dropMove(3, node('account', 3)), undefined, 'onto itself');
    assert.equal(dropMove(3, node('window', 1)), undefined, 'onto a usage row');
    assert.equal(dropMove(3, undefined), undefined, 'onto empty space');
    assert.equal(dropMove(0, node('account', 1)), undefined);
  });
});
