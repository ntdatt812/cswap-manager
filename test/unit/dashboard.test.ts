import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cliError } from '../../src/core/cli/cliErrors';
import { parseListOutput } from '../../src/core/model/parsers';
import { buildSnapshot } from '../../src/core/model/reconcile';
import type { AccountsSnapshot } from '../../src/core/model/types';
import type { Translate } from '../../src/core/presentation/accountTree';
import { buildDashboardModel, type DashboardOptions } from '../../src/core/presentation/dashboard';
import { DEFAULT_THRESHOLDS } from '../../src/core/presentation/format';
import type { AccountsState } from '../../src/core/service/refreshService';
import { parseWebviewMessage } from '../../src/core/webview/messages';
import type { DashboardRow, DetailSection } from '../../src/shared/dashboardProtocol';
import { filterRows, sortRows } from '../../src/shared/dashboardTable';
import { fixture } from '../helpers/fixtures';

const t: Translate = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
const NOW = Date.parse('2026-11-24T04:00:00Z');

function snapshot(json = fixture('list-extended.json')): AccountsSnapshot {
  const list = parseListOutput(json);
  assert.ok(list.ok);
  return buildSnapshot(list.value, undefined, NOW - 30_000);
}

const options = (overrides: Partial<DashboardOptions> = {}): DashboardOptions => ({
  now: NOW,
  thresholds: DEFAULT_THRESHOLDS,
  t,
  formatDateTime: (epoch) => new Date(epoch).toISOString().slice(0, 16),
  freshness: { freshness: 'fresh' },
  switching: false,
  describeError: (error) => error.message,
  ...overrides,
});

const ready = (snap = snapshot()): AccountsState => ({ refreshing: false, snapshot: snap, lastSuccessAt: NOW - 30_000 });

function section(row: DashboardRow | undefined, title: string): DetailSection | undefined {
  return row?.detail.sections.find((candidate) => candidate.title === title);
}

describe('parser: fields verified from the CLI source', () => {
  const list = parseListOutput(fixture('list-extended.json'));
  assert.ok(list.ok);
  const [alice, bob] = list.value.accounts;

  it('reads spend money fields and keeps "rejected" out of the windows', () => {
    assert.deepEqual(
      alice?.usage?.windows.map((window) => window.key),
      ['fiveHour', 'sevenDay', 'spend'],
    );
    const spend = alice?.usage?.windows[2];
    assert.deepEqual([spend?.used, spend?.limit, spend?.currency], [12.5, 50, 'USD']);
    assert.deepEqual(alice?.usage?.rejected, { resetsAt: '2026-11-24T05:00:00.000Z', retryAfterSeconds: 120 });
    assert.equal(alice?.threshold, 85);
  });

  it('reads last-good usage and fetch errors for unavailable rows', () => {
    assert.equal(bob?.usage, undefined);
    assert.equal(bob?.lastGoodUsage?.windows[0]?.pct, 97);
    assert.equal(bob?.lastGoodAgeSeconds, 21600);
    assert.equal(bob?.usageError, 'http-429');
    assert.equal(bob?.usageRetryAt, '2026-11-24T04:10:00.000Z');
    assert.deepEqual(list.value.warnings, []);
  });
});

describe('buildDashboardModel', () => {
  const model = buildDashboardModel(ready(), options());
  const [alice, bob, carol] = model.rows;

  it('builds the overview: freshness, active account, quota left and suggestions', () => {
    assert.equal(model.state, 'ready');
    assert.equal(model.freshnessTone, 'ok');
    assert.equal(model.activeOverview?.slot, 1);
    assert.equal(model.activeOverview?.name, 'work');
    assert.equal(model.activeOverview?.level, 'warning');
    assert.deepEqual(
      model.activeOverview?.meters.map((meter) => meter.label),
      ['5h', '7d', 'Spend', 'ModelA'],
    );
    // Only alice counts: bob is disabled and carol has no current usage.
    assert.equal(model.capacity?.value, '0.2 / 1');
    assert.equal(model.capacity?.detail, '2 not counted (disabled or usage unknown)');
    assert.deepEqual(
      model.insights.map((insight) => insight.id),
      ['all-limited', 'relogin'],
    );
    assert.equal(model.insights[1]?.tone, 'error');
  });

  it('shows the auto-switch mode and strategy when known', () => {
    const auto = buildDashboardModel(ready(), options({ autoSwitch: { mode: 'switch', strategy: 'consume-first' } })).autoSwitch;
    assert.deepEqual(auto, { value: 'Switch automatically', detail: 'Use quota that resets soonest first', tone: 'ok' });
    assert.equal(buildDashboardModel(ready(), options({ autoSwitch: { mode: 'off', strategy: undefined } })).autoSwitch?.tone, 'neutral');
  });

  it('flags only problems next to a name, never plain "Active"', () => {
    assert.equal(model.rows[0]?.flag, undefined);
    assert.deepEqual(model.rows[1]?.flag, { text: 'Disabled · usage unavailable', tone: 'warning' });
  });

  it('builds rows in slot order with dynamic usage cells and status tones', () => {
    assert.deepEqual(
      model.rows.map((row) => row.slot),
      [1, 2, 3],
    );
    // Plans differ (or are missing) here, so the plan column stays.
    assert.equal(model.commonPlan, undefined);
    const samePlan = new Set(model.rows.map((row) => row.plan));
    assert.ok(samePlan.size > 1);
    assert.equal(alice?.name, 'work');
    assert.equal(alice?.secondary, 'alice@example.com');
    assert.deepEqual(
      alice?.usage.map((cell) => `${cell.label} ${cell.pctText} ${cell.level}`),
      ['5h 25% normal', '7d 82% warning', 'Spend 25% normal'],
    );
    assert.equal(alice?.resetText, 'in 2h 0m');
    assert.equal(alice?.statusText, 'Active');
    assert.equal(bob?.statusText, 'Disabled · usage unavailable');
    assert.equal(bob?.statusTone, 'warning');
    assert.equal(carol?.statusText, 're-login required');
    assert.equal(carol?.statusTone, 'error');
    assert.ok(alice?.searchText.includes('alice@example.com') && alice.searchText.includes('work') && alice.searchText.includes('max'));
  });

  it('shows pace, spend and quota-refusal facts only when supplied', () => {
    const usage = section(alice, 'Usage');
    const sevenDay = usage?.meters.find((meter) => meter.id === 'window:sevenDay');
    assert.deepEqual(
      sevenDay?.facts.map((fact) => fact.label),
      ['Even pace by now', 'Ahead of pace', 'Lasts until reset'],
    );
    // The even-pace mark is drawn on the bar only when cswap supplies it.
    assert.equal(typeof sevenDay?.pace?.pct, 'number');
    assert.match(sevenDay?.pace?.text ?? '', /^Even pace by now: /);
    const fiveHour = usage?.meters.find((meter) => meter.id === 'window:fiveHour');
    // Alice is the active account: her bars are on the card above, so her detail keeps only the
    // bars with more to say (pace, spend); the 5-hour bar is left to the card.
    assert.equal(fiveHour, undefined);
    const cardFiveHour = model.activeOverview?.meters.find((meter) => meter.id === 'active:window:fiveHour');
    // The reset date sits on the bar's title line, not in a row of its own.
    assert.deepEqual(cardFiveHour?.facts, []);
    assert.match(cardFiveHour?.caption ?? '', /^resets in 2h 0m \(.+\)$/);
    assert.equal(cardFiveHour?.pace, undefined);
    const spend = usage?.meters.find((meter) => meter.id === 'window:spend');
    assert.equal(spend?.facts[0]?.value, '12.5 / 50 USD');
    assert.match(usage?.note ?? '', /refused this account for quota until/);
    assert.equal(usage?.meters.find((meter) => meter.id === 'scope:0'), undefined, 'on the active card instead');
    assert.equal(model.activeOverview?.meters.find((meter) => meter.id === 'active:scope:0')?.label, 'ModelA');
  });

  it('marks last-known usage as not current and explains the fetch error', () => {
    const usage = section(bob, 'Usage');
    assert.equal(usage?.meters.length, 0);
    assert.match(usage?.note ?? '', /Usage status: usage unavailable\. Last fetch error: http-429\. Next fetch attempt: 2026-11-24T04:10/);
    const lastKnown = section(bob, 'Last known usage');
    assert.equal(lastKnown?.noteTone, 'warning');
    assert.match(lastKnown?.note ?? '', /6h ago; this is not current data/);
    assert.equal(lastKnown?.meters[0]?.id, 'lastGood:window:sevenDay');
    assert.equal(section(carol, 'Last known usage'), undefined);
  });

  it('builds header, account, plan and freshness details', () => {
    assert.deepEqual(alice?.detail.badges.map((badge) => badge.text), ['Active', 'Max']);
    assert.equal(alice?.detail.subtitle, 'Slot 1 · alice@example.com · Example Org A');
    assert.equal(alice?.detail.canSwitch, false, 'already active');
    assert.equal(bob?.detail.canSwitch, true);
    const manage = section(alice, 'Manage account');
    assert.deepEqual(
      manage?.facts.map((fact) => fact.label),
      ['Email', 'Organization'],
    );
    assert.deepEqual(
      manage?.manage?.map((row) => `${row.label}=${row.value}:${row.actions.map((action) => action.id).join('+')}`),
      ['Display name=not set:setDisplayName', 'Auto-rotation=included:disable', 'Switch threshold=85%:setThreshold+clearThreshold', 'Priority=unknown:setPriority', 'Slot=1:move'],
    );
    assert.equal(section(bob, 'Manage account')?.manage?.find((row) => row.label === 'Auto-rotation')?.value, 'held out');
    // Every action offered in the list is one the manage flow accepts for that account.
    for (const row of [alice, bob]) {
      const offered = (section(row, 'Manage account')?.manage ?? []).flatMap((entry) => entry.actions.map((action) => action.id));
      assert.deepEqual([...offered].sort(), row?.detail.actions.map((action) => action.id).sort());
    }
    assert.ok(section(alice, 'Plan')?.facts.some((fact) => fact.label === 'Tier' && fact.value === 'max_5x'));
    const freshness = section(alice, 'Freshness')?.facts.map((fact) => fact.label);
    assert.deepEqual(freshness, ['Usage fetched', 'Login expires', 'Read from cswap']);
  });

  it('disables switching while a switch runs', () => {
    const busy = buildDashboardModel(ready(), options({ switching: true }));
    assert.equal(busy.busy, true);
    assert.equal(busy.canSwitch, false);
    assert.equal(busy.rows[1]?.detail.canSwitch, false);
  });

  it('carries the next refresh time only while a countdown should show', () => {
    const due = NOW + 42_000;
    assert.equal(buildDashboardModel(ready(), options({ nextRefreshAt: due })).nextRefreshAt, due);
    assert.equal(buildDashboardModel(ready(), options({ nextRefreshAt: due, freshness: { freshness: 'stale', reason: 'too-old' } })).nextRefreshAt, undefined, 'stale');
    assert.equal(buildDashboardModel(ready(), options({ nextRefreshAt: due, switching: true })).nextRefreshAt, undefined, 'busy');
    assert.equal(buildDashboardModel({ refreshing: false, lastError: cliError('timeout') }, options({ nextRefreshAt: due })).nextRefreshAt, undefined, 'no data');
  });

  it('reports loading, error, empty and stale states', () => {
    assert.equal(buildDashboardModel({ refreshing: true }, options()).state, 'loading');
    const error = buildDashboardModel({ refreshing: false, lastError: cliError('executable-not-found') }, options());
    assert.equal(error.state, 'error');
    assert.equal(error.messageTone, 'error');
    assert.equal(buildDashboardModel(ready(snapshot('{"schemaVersion":1,"accounts":[]}')), options()).state, 'empty');
    const stale = buildDashboardModel({ ...ready(), lastError: cliError('timeout') }, options({ freshness: { freshness: 'stale', reason: 'refresh-failed' } }));
    assert.ok(stale.freshnessText.startsWith('Stale'), stale.freshnessText);
    assert.equal(stale.freshnessTone, 'warning');
    assert.equal(stale.messageTone, 'warning');
    assert.match(stale.message ?? '', /Last refresh failed/);
  });
});

describe('dashboard table helpers', () => {
  const rows = buildDashboardModel(ready(), options()).rows;

  it('filters on every term', () => {
    assert.deepEqual(filterRows(rows, 'example.com').map((row) => row.slot), [1, 2, 3]);
    assert.deepEqual(filterRows(rows, 'work max').map((row) => row.slot), [1]);
    assert.deepEqual(filterRows(rows, 're-login').map((row) => row.slot), [3]);
    assert.deepEqual(filterRows(rows, 'nobody').map((row) => row.slot), []);
  });

  it('sorts with missing values last in both directions', () => {
    assert.deepEqual(sortRows(rows, 'usage', 'desc').map((row) => row.slot), [1, 2, 3]);
    assert.deepEqual(sortRows(rows, 'usage', 'asc').map((row) => row.slot), [1, 2, 3]);
    assert.deepEqual(sortRows(rows, 'slot', 'desc').map((row) => row.slot), [3, 2, 1]);
    assert.deepEqual(sortRows(rows, 'name', 'asc').map((row) => row.slot), [2, 3, 1]);
  });
});

describe('parseWebviewMessage', () => {
  it('accepts only allow-listed messages', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
    assert.deepEqual(parseWebviewMessage({ type: 'refresh', extra: 'ignored' }), { type: 'refresh' });
    assert.deepEqual(parseWebviewMessage({ type: 'openAutoSwitch' }), { type: 'openAutoSwitch' });
    assert.deepEqual(parseWebviewMessage({ type: 'switchToAccount', slot: 2 }), { type: 'switchToAccount', slot: 2 });
    assert.deepEqual(parseWebviewMessage({ type: 'switchStrategy', strategy: 'next-available' }), { type: 'switchStrategy', strategy: 'next-available' });
  });

  it('rejects unknown types, commands and malformed fields', () => {
    const rejected: unknown[] = [
      undefined,
      null,
      'refresh',
      [],
      { type: 'executeCommand', command: 'workbench.action.terminal.new' },
      { type: 'openExternal', url: 'https://example.com' },
      { type: 'switchToAccount', slot: '2' },
      { type: 'switchToAccount', slot: 1.5 },
      { type: 'switchToAccount', slot: -1 },
      { type: 'switchToAccount' },
      { type: 'switchStrategy', strategy: '--force' },
      { type: 'switchStrategy', strategy: 'best --force' },
      { type: 'purge' },
    ];
    for (const message of rejected) {
      assert.equal(parseWebviewMessage(message), undefined, JSON.stringify(message));
    }
  });
});
