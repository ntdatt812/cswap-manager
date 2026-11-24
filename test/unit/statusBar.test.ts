import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cliError } from '../../src/core/cli/cliErrors';
import { parseListOutput } from '../../src/core/model/parsers';
import { buildSnapshot } from '../../src/core/model/reconcile';
import type { AccountsSnapshot } from '../../src/core/model/types';
import type { Translate } from '../../src/core/presentation/accountTree';
import { DEFAULT_THRESHOLDS } from '../../src/core/presentation/format';
import { buildQuickSwitchItems } from '../../src/core/presentation/quickSwitch';
import { buildStatusBarModel, sanitizeLabel, type StatusBarOptions } from '../../src/core/presentation/statusBar';
import type { AccountsState } from '../../src/core/service/refreshService';
import { fixture } from '../helpers/fixtures';

const t: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
const NOW = Date.parse('2026-11-24T04:00:00Z');

function snapshot(json = fixture('list-v1.json')): AccountsSnapshot {
  const list = parseListOutput(json);
  assert.ok(list.ok);
  return buildSnapshot(list.value, undefined, NOW - 60_000);
}

const options = (overrides: Partial<StatusBarOptions> = {}): StatusBarOptions => ({
  now: NOW,
  thresholds: DEFAULT_THRESHOLDS,
  t,
  formatDateTime: (epoch) => new Date(epoch).toISOString().slice(0, 16),
  mode: 'slotUsage',
  freshness: { freshness: 'fresh' },
  switching: false,
  describeError: (error) => error.message,
  ...overrides,
});

const ready = (snap = snapshot()): AccountsState => ({ refreshing: false, snapshot: snap, lastSuccessAt: NOW - 60_000 });

describe('buildStatusBarModel', () => {
  it('renders each mode for the active account', () => {
    assert.equal(buildStatusBarModel(ready(), options())?.text, '$(account) #2 · 7d 40%');
    assert.equal(buildStatusBarModel(ready(), options({ mode: 'slot' }))?.text, '$(account) #2');
    assert.equal(buildStatusBarModel(ready(), options({ mode: 'nameUsage' }))?.text, '$(account) bob@example.com · 7d 40%');
    assert.equal(buildStatusBarModel(ready(), options({ mode: 'hidden' })), undefined);
  });

  it('prefers the alias, shortens long names and neutralizes icon syntax', () => {
    const json = fixture('list-v1.json').replace('"email": "bob@example.com"', '"email": "bob@example.com", "alias": "$(alert) a-very-long-alias-for-the-work-account"');
    const text = buildStatusBarModel(ready(snapshot(json)), options({ mode: 'nameUsage' }))?.text ?? '';
    assert.equal(text.includes('$(alert)'), false);
    assert.match(text, /…/);
    assert.equal(sanitizeLabel('$(x)'), '$​(x)');
  });

  it('uses warning/critical icons from the active account usage', () => {
    const critical = fixture('list-v1.json').replace('"pct": 40', '"pct": 97');
    const model = buildStatusBarModel(ready(snapshot(critical)), options());
    assert.equal(model?.level, 'critical');
    assert.match(model?.text ?? '', /^\$\(error\) #2/);
  });

  it('marks stale data and explains it in the tooltip', () => {
    const state: AccountsState = { ...ready(), lastError: cliError('timeout') };
    const model = buildStatusBarModel(state, options({ freshness: { freshness: 'stale', reason: 'refresh-failed' } }));
    assert.match(model?.text ?? '', /\$\(history\)$/);
    assert.match(model?.tooltip.notes?.join(' ') ?? '', /Stale: last refresh failed/);
    assert.match(model?.accessibilityLabel ?? '', /\(stale\)/);
  });

  it('shows loading, error, unknown-active and switching states', () => {
    assert.equal(buildStatusBarModel({ refreshing: true }, options())?.text, '$(sync~spin) Cswap');
    const failed = buildStatusBarModel({ refreshing: false, lastError: cliError('executable-not-found') }, options());
    assert.equal(failed?.text, '$(error) Cswap');
    assert.match(failed?.tooltip.notes?.[0] ?? '', /not found/);

    const unknown = snapshot(fixture('list-v1.json').replace('"activeAccountNumber": 2', '"activeAccountNumber": 1'));
    assert.equal(buildStatusBarModel(ready(unknown), options())?.text, '$(account) #?');
    assert.match(buildStatusBarModel(ready(), options({ switching: true }))?.text ?? '', /switching/);
  });

  it('summarizes at most two windows, otherwise the fullest', () => {
    const json = fixture('list-v1.json').replace(
      '"sevenDay": {\n          "pct": 40,',
      '"fiveHour": { "pct": 12 }, "spend": { "pct": 88 }, "sevenDay": {\n          "pct": 40,',
    );
    assert.equal(buildStatusBarModel(ready(snapshot(json)), options())?.text, '$(warning) #2 · Spend 88%');
  });
});

describe('buildQuickSwitchItems', () => {
  const items = buildQuickSwitchItems(snapshot(), options());

  it('offers both strategies, then accounts in slot order', () => {
    assert.deepEqual(
      items.map((item) => (item.separator ? `--${item.label}` : item.action?.kind === 'strategy' ? item.action.strategy : item.action?.kind === 'account' ? item.action.slot : '?')),
      ['--Strategies', 'best', 'next-available', '--Accounts', 1, 2],
    );
  });

  it('marks the current account and includes searchable plan and usage text', () => {
    const bob = items.find((item) => item.action?.kind === 'account' && item.action.slot === 2);
    assert.equal(bob?.action?.kind === 'account' && bob.action.active, true);
    assert.equal(bob?.iconId, 'pass-filled');
    assert.equal(bob?.label, '2 · bob@example.com');
    assert.match(bob?.description ?? '', /^current · Ultra · active · 7d 40% ↻ 4d 0h$/);
    assert.match(bob?.detail ?? '', /ModelA 1%/);
  });
});
