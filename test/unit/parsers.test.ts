import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseJsonDocument } from '../../src/core/model/json';
import { parseListOutput, parseStatusOutput } from '../../src/core/model/parsers';
import { fixture } from '../helpers/fixtures';

describe('parseListOutput — observed schema v1', () => {
  const result = parseListOutput(fixture('list-v1.json'));
  assert.ok(result.ok);
  const list = result.value;

  it('reads top-level fields without warnings', () => {
    assert.equal(list.schemaVersion, 1);
    assert.equal(list.activeAccountNumber, 2);
    assert.deepEqual(list.warnings, []);
  });

  it('orders accounts by slot regardless of CLI order', () => {
    assert.deepEqual(
      list.accounts.map((account) => account.slot),
      [1, 2],
    );
  });

  it('normalizes account, plan and timestamp fields', () => {
    const bob = list.accounts[1];
    assert.ok(bob);
    assert.equal(bob.email, 'bob@example.com');
    assert.equal(bob.activeFlag, true);
    assert.equal(bob.isOrganization, true);
    assert.equal(bob.usageStatus, 'ok');
    assert.equal(bob.loginExpiresAt, '2026-12-14T05:07:32.000Z');
    assert.equal(bob.usageAgeSeconds, 181.6);
    assert.deepEqual(bob.plan, {
      label: 'Ultra',
      displayName: 'Ultra',
      tier: 'default_claude_max_20x',
      organizationType: 'claude_max',
      billingType: 'stripe_subscription',
      subscriptionStatus: 'active',
      expired: false,
      fetchedAt: '2026-11-24T00:46:28.000Z',
    });
  });

  it('keeps usage windows dynamic and parses microsecond timestamps', () => {
    const usage = list.accounts[1]?.usage;
    assert.ok(usage);
    assert.equal(usage.windows.length, 1);
    const [window] = usage.windows;
    assert.equal(window?.key, 'sevenDay');
    assert.equal(window?.pct, 40);
    assert.equal(window?.resetsAt, '2026-11-28T04:00:00.097Z');
    assert.equal(window?.expectedPct, 42.6);
    assert.equal(window?.aheadOfPace, false);
    assert.equal(window?.willLastToReset, true);
    assert.equal(usage.scoped[0]?.name, 'ModelA');
  });

  it('leaves absent optional fields undefined rather than defaulting them', () => {
    const scoped = list.accounts[0]?.usage?.scoped[0];
    assert.ok(scoped);
    assert.equal('projectedExhaustionAt' in scoped, false);
  });
});

describe('parseListOutput — schema drift and malformed entries', () => {
  const result = parseListOutput(fixture('list-drift.json'));
  assert.ok(result.ok);
  const list = result.value;
  const codes = list.warnings.map((warning) => `${warning.code}@${warning.path}`);

  it('flags an untested schema version but still parses', () => {
    assert.equal(list.schemaVersion, 2);
    assert.ok(codes.includes('schema-version-untested@$.schemaVersion'));
  });

  it('skips accounts without a slot, duplicates and non-objects', () => {
    assert.deepEqual(
      list.accounts.map((account) => account.slot),
      [3, 4],
    );
    assert.equal(list.accounts[0]?.email, 'carol@example.com');
    assert.ok(codes.includes('account-without-slot@$.accounts[1]'));
    assert.ok(codes.includes('duplicate-slot@$.accounts[2]'));
    assert.ok(codes.includes('unexpected-type@$.accounts[4]'));
  });

  it('accepts unknown window keys in CLI order and ignores non-window fields', () => {
    const windows = list.accounts[0]?.usage?.windows ?? [];
    assert.deepEqual(
      windows.map((window) => window.key),
      ['fiveHour', 'sevenDay', 'monthlyBurst'],
    );
    assert.equal(windows[0]?.pct, 87.5);
  });

  it('drops wrongly typed values with a warning instead of failing', () => {
    const sevenDay = list.accounts[0]?.usage?.windows[1];
    assert.equal(sevenDay?.pct, undefined);
    assert.equal(sevenDay?.resetsAt, undefined);
    assert.ok(codes.includes('unexpected-type@$.accounts[0].usage.sevenDay.pct'));
    assert.ok(codes.includes('invalid-timestamp@$.accounts[0].usage.sevenDay.resetsAt'));
  });

  it('keeps named scopes and skips unnamed or invalid ones', () => {
    const scoped = list.accounts[0]?.usage?.scoped ?? [];
    assert.deepEqual(
      scoped.map((entry) => entry.name),
      ['ModelB'],
    );
    assert.ok(codes.includes('scope-without-name@$.accounts[0].usage.scoped[1]'));
  });

  it('passes unknown usageStatus values through and tolerates sparse plans', () => {
    assert.equal(list.accounts[0]?.usageStatus, 'rate_limited');
    assert.deepEqual(list.accounts[0]?.plan, { label: 'Pro' });
    assert.equal(list.accounts[1]?.usage, undefined);
  });

  it('never puts values in warnings', () => {
    const serialized = JSON.stringify(list.warnings);
    assert.equal(serialized.includes('example.com'), false);
    assert.equal(serialized.includes('garbage-date'), false);
  });
});

describe('parseListOutput — failures and edge cases', () => {
  it('rejects malformed JSON', () => {
    const result = parseListOutput('{"accounts": [');
    assert.deepEqual(result.ok ? 'ok' : result.reason, 'invalid-json');
  });

  it('rejects empty output', () => {
    const result = parseListOutput('   \n');
    assert.equal(result.ok, false);
  });

  it('rejects a non-object document', () => {
    const result = parseListOutput('[1,2,3]');
    assert.deepEqual(result.ok ? 'ok' : result.reason, 'unexpected-shape');
  });

  it('rejects an object without an accounts array', () => {
    const result = parseListOutput('{"schemaVersion":1,"accounts":{}}');
    assert.deepEqual(result.ok ? 'ok' : result.reason, 'unexpected-shape');
  });

  it('accepts an empty account list and warns on a missing schema version', () => {
    const result = parseListOutput('{"accounts":[]}');
    assert.ok(result.ok);
    assert.deepEqual(result.value.accounts, []);
    assert.equal(result.value.warnings[0]?.code, 'schema-version-missing');
  });

  it('treats null fields as absent without warnings', () => {
    const result = parseListOutput('{"schemaVersion":1,"activeAccountNumber":null,"accounts":[{"number":1,"email":null,"usage":null,"plan":null}]}');
    assert.ok(result.ok);
    assert.equal(result.value.activeAccountNumber, undefined);
    assert.deepEqual(result.value.accounts, [{ slot: 1 }]);
    assert.deepEqual(result.value.warnings, []);
  });

  it('rejects fractional or negative slots', () => {
    const result = parseListOutput('{"schemaVersion":1,"accounts":[{"number":1.5},{"number":-1},{"number":"2"}]}');
    assert.ok(result.ok);
    assert.deepEqual(result.value.accounts, []);
  });

  it('tolerates a banner line and a BOM before the JSON payload', () => {
    const result = parseListOutput(`﻿A newer version is available\n${fixture('list-v1.json')}`);
    assert.ok(result.ok);
    assert.equal(result.value.accounts.length, 2);
    assert.ok(result.value.warnings.some((warning) => warning.code === 'leading-noise'));
  });
});

describe('parseStatusOutput', () => {
  it('parses the observed status shape', () => {
    const result = parseStatusOutput(fixture('status-v1.json'));
    assert.ok(result.ok);
    const { active, totalManagedAccounts, warnings } = result.value;
    assert.equal(active?.slot, 2);
    assert.equal(active?.managed, true);
    assert.equal(active?.plan, undefined);
    assert.equal(active?.usage?.windows[0]?.pct, 41);
    assert.equal(totalManagedAccounts, 2);
    assert.deepEqual(warnings, []);
  });

  it('treats a null active account as none', () => {
    const result = parseStatusOutput('{"schemaVersion":1,"active":null,"totalManagedAccounts":0}');
    assert.ok(result.ok);
    assert.equal(result.value.active, undefined);
    assert.equal(result.value.totalManagedAccounts, 0);
  });

  it('keeps an unmanaged active login without a slot', () => {
    const result = parseStatusOutput('{"schemaVersion":1,"active":{"email":"x@example.com","managed":false}}');
    assert.ok(result.ok);
    assert.equal(result.value.active?.slot, undefined);
    assert.equal(result.value.active?.managed, false);
  });

  it('rejects malformed JSON', () => {
    assert.equal(parseStatusOutput('not json').ok, false);
  });
});

describe('parseJsonDocument', () => {
  it('does not recover from noise after the payload', () => {
    assert.equal(parseJsonDocument('{"a":1}\ntrailing text').ok, false);
  });
});
