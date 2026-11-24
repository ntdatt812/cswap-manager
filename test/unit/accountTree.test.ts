import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cliError } from '../../src/core/cli/cliErrors';
import { parseListOutput, parseStatusOutput } from '../../src/core/model/parsers';
import { buildSnapshot } from '../../src/core/model/reconcile';
import type { AccountsSnapshot } from '../../src/core/model/types';
import {
  buildAccountNodes,
  describeView,
  relativeAge,
  type NodeModel,
  type Translate,
  type TreeBuildOptions,
} from '../../src/core/presentation/accountTree';
import { DEFAULT_THRESHOLDS } from '../../src/core/presentation/format';
import type { AccountsState } from '../../src/core/service/refreshService';
import { fixture } from '../helpers/fixtures';

const t: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
const NOW = Date.parse('2026-11-24T04:00:00Z');

function snapshot(listJson = fixture('list-v1.json'), withStatus = false): AccountsSnapshot {
  const list = parseListOutput(listJson);
  assert.ok(list.ok);
  const status = withStatus ? parseStatusOutput(fixture('status-v1.json')) : undefined;
  return buildSnapshot(list.value, status?.ok ? status.value : undefined, NOW - 60_000);
}

const options = (overrides: Partial<TreeBuildOptions> = {}): TreeBuildOptions => ({
  now: NOW,
  thresholds: DEFAULT_THRESHOLDS,
  t,
  formatDateTime: (epoch) => new Date(epoch).toISOString().slice(0, 16),
  sortOrder: 'slot',
  ...overrides,
});

function child(node: NodeModel | undefined, idSuffix: string): NodeModel | undefined {
  return node?.children.find((candidate) => candidate.id.endsWith(idSuffix));
}

describe('buildAccountNodes', () => {
  const nodes = buildAccountNodes(snapshot(), options());
  const [alice, bob] = nodes;

  it('lists accounts in slot order with stable ids', () => {
    assert.deepEqual(nodes.map((node) => node.id), ['account:1', 'account:2']);
    assert.equal(alice?.label, '1 · alice@example.com');
  });

  it('makes the active account prominent and expanded', () => {
    assert.equal(bob?.icon?.id, 'pass-filled');
    assert.equal(bob?.icon?.color, 'charts.green');
    assert.equal(bob?.collapsible, 'expanded');
    assert.equal(bob?.contextValue, 'cswap.account:active:enabled:unaliased:nothreshold');
    assert.match(bob?.description ?? '', /^Active · Ultra · 7d 40% · ↻ 4d 0h$/);
    assert.equal(alice?.collapsible, 'collapsed');
  });

  it('colours inactive accounts by their worst usage level', () => {
    assert.equal(alice?.icon?.id, 'error');
    assert.equal(alice?.icon?.color, 'charts.red');
  });

  it('renders one child per usage window and scope, using the CLI keys', () => {
    const window = child(bob, ':window:sevenDay');
    assert.equal(window?.label, '7d');
    assert.equal(window?.description, '████░░░░░░ 40% · resets in 4d 0h');
    const scope = child(bob, ':scope:0:ModelA');
    assert.equal(scope?.label, 'ModelA');
    assert.equal(scope?.description, '▏░░░░░░░░░ 1% · resets in 4d 0h');
  });

  it('shows pace fields only when the CLI supplies them', () => {
    const windowRows = child(bob, ':window:sevenDay')?.tooltip?.rows.map((row) => row.label) ?? [];
    assert.ok(windowRows.includes('Projected exhaustion'));
    const aliceScopeRows = child(alice, ':scope:0:ModelA')?.tooltip?.rows.map((row) => row.label) ?? [];
    assert.equal(aliceScopeRows.includes('Projected exhaustion'), false);
  });

  it('flags reset times that have already passed instead of showing a negative countdown', () => {
    assert.equal(child(alice, ':window:sevenDay')?.description, '██████████ 100% · resets in 1h 0m');
    const later = buildAccountNodes(snapshot(), options({ now: Date.parse('2026-11-24T06:00:00Z') }));
    assert.match(child(later[0], ':window:sevenDay')?.description ?? '', /reset time passed/);
    assert.equal(later[0]?.description?.includes('↻'), false, 'no countdown for a passed reset');
  });

  it('adds plan, freshness and organization details', () => {
    assert.equal(child(bob, ':plan')?.description, 'Ultra · active');
    assert.equal(child(bob, ':fetched')?.description, '4m ago');
    assert.equal(child(bob, ':org')?.description, 'Example Org B');
  });

  it('flags a login only when it is due within a week (like cswap), or already lapsed', () => {
    const expiry = Date.parse('2026-12-14T05:07:32.000Z');
    const loginAt = (now: number) => child(buildAccountNodes(snapshot(), options({ now }))[1], ':login');
    assert.equal(child(bob, ':login'), undefined, '20 days out: nothing to flag');
    const due = loginAt(expiry - 2 * 86_400_000);
    assert.equal(due?.label, 'Re-login due');
    assert.match(due?.description ?? '', /^in 2d/);
    assert.equal(due?.icon?.color, 'charts.yellow');
    const lapsed = loginAt(expiry + 60_000);
    assert.match(lapsed?.description ?? '', /^now \(expired /);
    assert.equal(lapsed?.icon?.color, 'charts.red');
  });

  it('handles accounts without usage or with an unavailable usage status', () => {
    const sparse = buildAccountNodes(snapshot(fixture('list-drift.json')), options());
    const carol = sparse.find((node) => node.id === 'account:3');
    const bare = sparse.find((node) => node.id === 'account:4');
    assert.equal(carol?.icon?.id, 'pass-filled', 'active wins');
    assert.match(carol?.description ?? '', /usage rate_limited/);
    assert.match(carol?.description ?? '', /5h 87\.5%/);
    assert.match(carol?.description ?? '', /7d \?/);
    assert.equal(bare?.label, '4 · Account 4');
    assert.match(bare?.description ?? '', /usage unknown/);
    assert.equal(child(bare, ':usageStatus')?.description, 'not reported by cswap');
  });

  it('applies filter and sort without changing slot identity', () => {
    const filtered = buildAccountNodes(snapshot(), options({ filter: 'bob' }));
    assert.deepEqual(filtered.map((node) => node.id), ['account:2']);
    const sorted = buildAccountNodes(snapshot(), options({ sortOrder: 'mostUsed' }));
    assert.deepEqual(sorted.map((node) => node.id), ['account:1', 'account:2']);
  });

  it('notes when the active account came from conflicting sources', () => {
    const conflicting = snapshot(fixture('list-v1.json').replace('"activeAccountNumber": 2', '"activeAccountNumber": 1'), true);
    const node = buildAccountNodes(conflicting, options()).find((candidate) => candidate.id === 'account:2');
    assert.match(node?.tooltip?.notes?.[0] ?? '', /sources disagreed/);
  });
});

describe('describeView', () => {
  const describeError = (error: { message: string }) => error.message;
  const base = { now: NOW, t, describeError, visibleCount: 2 };

  it('is loading before any data', () => {
    assert.deepEqual(describeView({ refreshing: true }, { ...base, freshness: { freshness: 'none' } }), { state: 'loading' });
  });

  it('maps first-load errors to dedicated welcome states', () => {
    const notFound: AccountsState = { refreshing: false, lastError: cliError('executable-not-found') };
    assert.equal(describeView(notFound, { ...base, freshness: { freshness: 'none' } }).state, 'notFound');
    const shim: AccountsState = { refreshing: false, lastError: cliError('unsupported-executable') };
    assert.equal(describeView(shim, { ...base, freshness: { freshness: 'none' } }).state, 'unsupportedExecutable');
    const timeout: AccountsState = { refreshing: false, lastError: cliError('timeout') };
    const view = describeView(timeout, { ...base, freshness: { freshness: 'none' } });
    assert.equal(view.state, 'error');
    assert.match(view.message ?? '', /timeout/);
  });

  it('describes fresh data with the active slot and age', () => {
    const state: AccountsState = { refreshing: false, snapshot: snapshot(), lastSuccessAt: NOW - 120_000 };
    assert.deepEqual(describeView(state, { ...base, freshness: { freshness: 'fresh' } }), {
      state: 'ready',
      description: 'Active: #2 · updated 2m ago',
    });
  });

  it('marks stale data and explains why', () => {
    const state: AccountsState = { refreshing: false, snapshot: snapshot(), lastSuccessAt: NOW - 600_000, lastError: cliError('timeout') };
    const view = describeView(state, { ...base, freshness: { freshness: 'stale', reason: 'refresh-failed' } });
    assert.equal(view.description, 'Stale · Active: #2 · updated 10m ago');
    assert.match(view.message ?? '', /^Last refresh failed: .*timeout.* Showing data from 10m ago\.$/);

    const old = describeView({ ...state, lastError: undefined }, { ...base, freshness: { freshness: 'stale', reason: 'too-old' } });
    assert.match(old.message ?? '', /out of date/);
  });

  it('distinguishes empty, filtered-empty, conflict and untested schema', () => {
    const empty = snapshot('{"schemaVersion":1,"accounts":[]}');
    assert.equal(describeView({ refreshing: false, snapshot: empty }, { ...base, freshness: { freshness: 'fresh' } }).state, 'empty');

    const filtered = describeView({ refreshing: false, snapshot: snapshot() }, { ...base, visibleCount: 0, filter: 'zzz', freshness: { freshness: 'fresh' } });
    assert.equal(filtered.state, 'filteredEmpty');
    assert.match(filtered.message ?? '', /Filter "zzz": 0 of 2 accounts/);

    const conflict = snapshot(fixture('list-v1.json').replace('"activeAccountNumber": 2', '"activeAccountNumber": 1'));
    const conflictView = describeView({ refreshing: false, snapshot: conflict }, { ...base, freshness: { freshness: 'fresh' } });
    assert.equal(conflictView.description?.startsWith('Active: unknown'), true);
    assert.match(conflictView.message ?? '', /disagree/);

    const drift = describeView({ refreshing: false, snapshot: snapshot(fixture('list-drift.json')) }, { ...base, freshness: { freshness: 'fresh' } });
    assert.match(drift.message ?? '', /schema version 2 has not been tested/);
  });
});

describe('relativeAge', () => {
  it('rounds to friendly units', () => {
    assert.equal(relativeAge(10_000, t), 'just now');
    assert.equal(relativeAge(5 * 60_000, t), '5m ago');
    assert.equal(relativeAge(3 * 3_600_000, t), '3h ago');
    assert.equal(relativeAge(2 * 86_400_000, t), '2d ago');
  });
});
