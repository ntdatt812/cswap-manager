import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyDisplayNames, cleanDisplayName, DISPLAY_NAME_MAX, displayNameKey } from '../../src/core/model/displayNames';
import { parseListOutput } from '../../src/core/model/parsers';
import { buildSnapshot } from '../../src/core/model/reconcile';
import type { Account, AccountsSnapshot, ListPayload } from '../../src/core/model/types';
import { accountName, hasCustomName, type Translate } from '../../src/core/presentation/accountTree';
import { buildDashboardModel } from '../../src/core/presentation/dashboard';
import { DEFAULT_THRESHOLDS, matchesFilter } from '../../src/core/presentation/format';
import { RefreshService } from '../../src/core/service/refreshService';
import { ok } from '../helpers/fixtures';

const t: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
const NOW = Date.parse('2026-11-24T04:00:00Z');

function listPayload(): ListPayload {
  const list = parseListOutput(
    JSON.stringify({
      schemaVersion: 1,
      activeAccountNumber: 1,
      accounts: [
        { number: 1, email: 'Work@Example.com', organizationUuid: 'org-1', active: true, alias: 'work', usageStatus: 'ok', usage: { sevenDay: { pct: 40 } } },
        { number: 2, email: 'home@example.com', active: false, usageStatus: 'ok', usage: { sevenDay: { pct: 10 } } },
        { number: 3, active: false, usageStatus: 'ok', usage: null },
      ],
    }),
  );
  assert.ok(list.ok);
  return list.value;
}

const snapshot = (): AccountsSnapshot => buildSnapshot(listPayload(), undefined, NOW);
const account = (snap: AccountsSnapshot, slot: number): Account => {
  const found = snap.accounts.find((candidate) => candidate.slot === slot);
  assert.ok(found);
  return found;
};

describe('display names', () => {
  it('keys an account by a short hash of its identity, never by slot or raw email', () => {
    const snap = snapshot();
    const key = displayNameKey(account(snap, 1));
    assert.match(key ?? '', /^[0-9a-f]{16}$/);
    assert.equal(key?.includes('example'), false);
    // The email is compared case-insensitively, like cswap does; the organization tells accounts apart.
    assert.equal(displayNameKey({ slot: 9, email: 'work@example.com', organizationUuid: 'org-1' }), key);
    assert.notEqual(displayNameKey({ slot: 1, email: 'work@example.com', organizationUuid: 'org-2' }), key);
    assert.equal(displayNameKey(account(snap, 3)), undefined, 'no email, nothing to attach to');
  });

  it('cleans names: collapses spaces, drops control characters, caps the length', () => {
    assert.equal(cleanDisplayName('  Công   việc \n chính '), 'Công việc chính');
    assert.equal(cleanDisplayName('Tab\there'), 'Tab here');
    assert.equal(cleanDisplayName('x'.repeat(60)).length, DISPLAY_NAME_MAX);
    assert.equal(cleanDisplayName('   '), '');
  });

  it('adds and removes names on a snapshot, leaving it untouched when nothing changes', () => {
    const snap = snapshot();
    const key = displayNameKey(account(snap, 1)) ?? '';
    const named = applyDisplayNames(snap, { [key]: 'Công việc' });
    assert.equal(account(named, 1).displayName, 'Công việc');
    assert.equal(account(named, 2).displayName, undefined);
    assert.equal(applyDisplayNames(named, { [key]: 'Công việc' }), named, 'same names: same object');
    assert.equal(account(applyDisplayNames(named, {}), 1).displayName, undefined, 'removed');
    assert.equal(applyDisplayNames(snap, {}), snap);
  });

  it('shows the display name first, then the alias, then the email, and keeps it searchable', () => {
    const snap = snapshot();
    const named = applyDisplayNames(snap, { [displayNameKey(account(snap, 2)) ?? '']: 'Cá nhân' });
    assert.equal(accountName(account(named, 1), t), 'work');
    assert.equal(accountName(account(named, 2), t), 'Cá nhân');
    assert.equal(hasCustomName(account(named, 2)), true);
    assert.equal(hasCustomName(account(snap, 2)), false);
    assert.equal(matchesFilter(account(named, 2), 'cá'), true);

    const model = buildDashboardModel(
      { refreshing: false, snapshot: named, lastSuccessAt: NOW },
      { now: NOW, thresholds: DEFAULT_THRESHOLDS, t, formatDateTime: String, freshness: { freshness: 'fresh' }, switching: false, describeError: (error) => error.message },
    );
    const row = model.rows.find((candidate) => candidate.slot === 2);
    assert.equal(row?.name, 'Cá nhân');
    assert.equal(row?.secondary, 'home@example.com', 'the email moves to the second line');
  });

  it('re-applies names without calling cswap again', async () => {
    let names: Record<string, string> = {};
    let calls = 0;
    const service = new RefreshService({
      cli: {
        list: () => ((calls++), Promise.resolve(ok('list', listPayload()))),
        status: () => Promise.reject(new Error('not used')),
      },
      now: () => NOW,
      decorate: (snap) => applyDisplayNames(snap, names),
    });
    await service.refresh({ trigger: 'manual' });
    const key = displayNameKey(account(service.getState().snapshot ?? snapshot(), 2)) ?? '';
    names = { [key]: 'Nhà' };
    service.redecorate();
    assert.equal(account(service.getState().snapshot ?? snapshot(), 2).displayName, 'Nhà');
    assert.equal(calls, 1);
  });
});
