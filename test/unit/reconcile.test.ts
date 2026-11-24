import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseListOutput, parseStatusOutput } from '../../src/core/model/parsers';
import { activeAccount, buildSnapshot, needsStatusCheck, resolveActive } from '../../src/core/model/reconcile';
import type { ListPayload, StatusPayload } from '../../src/core/model/types';
import { fixture } from '../helpers/fixtures';

function list(json: string = fixture('list-v1.json')): ListPayload {
  const result = parseListOutput(json);
  assert.ok(result.ok);
  return result.value;
}

function status(json: string = fixture('status-v1.json')): StatusPayload {
  const result = parseStatusOutput(json);
  assert.ok(result.ok);
  return result.value;
}

const twoAccounts = (activeNumber: string, flags: [boolean, boolean]): string =>
  `{"schemaVersion":1,"activeAccountNumber":${activeNumber},"accounts":[{"number":1,"email":"a@example.com","active":${flags[0]}},{"number":2,"email":"b@example.com","active":${flags[1]}}]}`;

describe('needsStatusCheck', () => {
  it('is false when the list is self-consistent', () => {
    assert.equal(needsStatusCheck(list()), false);
  });

  it('is true when activeAccountNumber is missing', () => {
    assert.equal(needsStatusCheck(list(twoAccounts('null', [false, true]))), true);
  });

  it('is true when flags disagree with activeAccountNumber', () => {
    assert.equal(needsStatusCheck(list(twoAccounts('1', [false, true]))), true);
  });

  it('is true when several accounts are flagged active', () => {
    assert.equal(needsStatusCheck(list(twoAccounts('1', [true, true]))), true);
  });

  it('is false for an empty account list', () => {
    assert.equal(needsStatusCheck(list('{"schemaVersion":1,"accounts":[]}')), false);
  });
});

describe('resolveActive', () => {
  it('resolves a consistent list without status', () => {
    assert.deepEqual(resolveActive(list()), { slot: 2, consistency: 'consistent', verifiedWithStatus: false });
  });

  it('confirms the active slot with matching status', () => {
    assert.deepEqual(resolveActive(list(), status()), { slot: 2, consistency: 'consistent', verifiedWithStatus: true });
  });

  it('reports a conflict when list flags disagree and status is absent', () => {
    assert.deepEqual(resolveActive(list(twoAccounts('1', [false, true]))), { consistency: 'conflict', verifiedWithStatus: false });
  });

  it('treats an activeAccountNumber pointing at a missing slot as inconsistent', () => {
    const resolution = resolveActive(list(twoAccounts('9', [false, false])));
    assert.equal(resolution.slot, undefined);
    assert.equal(resolution.consistency, 'conflict');
  });

  it('trusts status on conflict only when slot and email match the list entry', () => {
    const conflicting = list(twoAccounts('1', [true, false]));
    const statusForB = status('{"schemaVersion":1,"active":{"number":2,"email":"B@example.com","managed":true}}');
    assert.deepEqual(resolveActive(conflicting, statusForB), { slot: 2, consistency: 'conflict', verifiedWithStatus: true });
  });

  it('does not trust status when the email at that slot differs', () => {
    const otherEmail = status('{"schemaVersion":1,"active":{"number":2,"email":"intruder@example.com","managed":true}}');
    const resolution = resolveActive(list(), otherEmail);
    assert.equal(resolution.slot, undefined);
    assert.equal(resolution.consistency, 'conflict');
  });

  it('flags an unmanaged active login as a conflict with list claims', () => {
    const unmanaged = status('{"schemaVersion":1,"active":{"email":"x@example.com","managed":false}}');
    assert.deepEqual(resolveActive(list(), unmanaged), { consistency: 'conflict', verifiedWithStatus: true, activeUnmanaged: true });
  });

  it('is unknown when nothing identifies an active account', () => {
    assert.deepEqual(resolveActive(list(twoAccounts('null', [false, false]))), { consistency: 'unknown', verifiedWithStatus: false });
  });
});

describe('buildSnapshot', () => {
  it('merges fresher status usage into the matching account only', () => {
    const snapshot = buildSnapshot(list(), status(), 1000);
    const bob = activeAccount(snapshot);
    assert.equal(bob?.slot, 2);
    assert.equal(bob?.usage?.windows[0]?.pct, 41);
    assert.equal(bob?.usageFetchedAt, '2026-11-24T03:45:00.000Z');
    assert.equal(bob?.plan?.label, 'Ultra', 'plan still comes from list');
    assert.equal(snapshot.accounts[0]?.usage?.windows[0]?.pct, 100, 'other accounts untouched');
    assert.equal(snapshot.totalManagedAccounts, 2);
    assert.equal(snapshot.capturedAt, 1000);
  });

  it('keeps list usage when status data is older', () => {
    const older = status(fixture('status-v1.json').replace('2026-11-24T03:45:00Z', '2026-11-24T03:00:00Z'));
    const snapshot = buildSnapshot(list(), older, 1000);
    assert.equal(activeAccount(snapshot)?.usage?.windows[0]?.pct, 40);
  });

  it('does not merge status into an account with a different email', () => {
    const otherEmail = status(fixture('status-v1.json').replace('bob@example.com', 'mallory@example.com'));
    const snapshot = buildSnapshot(list(), otherEmail, 1000);
    assert.equal(snapshot.accounts[1]?.usage?.windows[0]?.pct, 40);
  });

  it('prefixes status warnings', () => {
    const snapshot = buildSnapshot(list(), status('{"active":null}'), 1);
    assert.ok(snapshot.warnings.some((warning) => warning.path === 'status:$.schemaVersion'));
  });
});
