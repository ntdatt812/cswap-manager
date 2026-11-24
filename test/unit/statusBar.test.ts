import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cliError } from '../../src/core/cli/cliErrors';
import { parseListOutput } from '../../src/core/model/parsers';
import { buildSnapshot } from '../../src/core/model/reconcile';
import type { AccountsSnapshot } from '../../src/core/model/types';
import type { Translate } from '../../src/core/presentation/accountTree';
import { DEFAULT_THRESHOLDS, FIGURE_SPACE } from '../../src/core/presentation/format';
import { buildQuickSwitchItems } from '../../src/core/presentation/quickSwitch';
import { buildStatusBarModel, sanitizeLabel, statusBarParts, type StatusBarOptions, type StatusBarPart } from '../../src/core/presentation/statusBar';
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

describe('custom status bar parts', () => {
  const custom = (parts: StatusBarPart[], extra: Partial<StatusBarOptions> = {}) =>
    buildStatusBarModel(ready(), options({ mode: 'custom', parts, ...extra }))?.text;

  it('shows exactly the ticked parts, always in the same order', () => {
    assert.equal(custom(['usage', 'slot', 'icon']), '$(account) #2 · 7d 40%');
    assert.equal(custom(['icon', 'slot', 'plan', 'bar', 'usage', 'reset']), '$(account) #2 · Ultra · ███▎░░░░ 7d 40% · ↻ 4d 0h');
    // Slanted cells are the extension's icons in the status bar: 40% of 8 cells = 3 full + 2/8.
    assert.equal(
      custom(['bar', 'usage'], { barStyle: 'parallelograms' }),
      `${'$(cswap-slant-8)'.repeat(3)}$(cswap-slant-2)${'$(cswap-slant-0)'.repeat(4)} 7d 40%`,
    );
    assert.equal(custom(['icon']), '$(account)');
  });

  it('hides the item when nothing is ticked, and never shows an empty item', () => {
    assert.equal(custom([]), undefined);
    const unknownActive = snapshot(fixture('list-v1.json').replace('"activeAccountNumber": 2', '"activeAccountNumber": 1'));
    const unknown = buildStatusBarModel(ready(unknownActive), options({ mode: 'custom', parts: ['slot', 'name'] }));
    assert.equal(unknown?.text, '#?', 'an unknown account is not named twice');
    // The reset has passed, so the only ticked part has nothing to show: fall back to the slot.
    assert.equal(custom(['reset'], { now: Date.parse('2026-11-29T00:00:00Z') }), '#2');
  });

  it('keeps the old modes showing what they always showed', () => {
    assert.deepEqual(statusBarParts('slotUsage', []), ['icon', 'slot', 'usage']);
    assert.deepEqual(statusBarParts('slot', ['plan']), ['icon', 'slot']);
    assert.deepEqual(statusBarParts('nameUsage', []), ['icon', 'name', 'usage']);
    assert.deepEqual(statusBarParts('hidden', ['slot']), []);
    assert.deepEqual(statusBarParts('custom', ['reset', 'slot']), ['slot', 'reset']);
  });

});

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
  const row = (number: number, pct: number | undefined, extra: Record<string, unknown> = {}) => ({
    number,
    email: `u${number}@example.com`,
    active: number === 5,
    usageStatus: 'ok',
    usage: { sevenDay: { ...(pct === undefined ? {} : { pct }), resetsAt: `2026-11-2${(number % 5) + 4}T00:00:00Z` }, scoped: [{ name: 'ModelA', pct: 1 }] },
    plan: { label: 'Ultra', subscriptionStatus: 'active', expired: false },
    usageAgeSeconds: 0,
    ...extra,
  });
  const smart = snapshot(
    JSON.stringify({
      schemaVersion: 1,
      activeAccountNumber: 5,
      accounts: [
        row(1, 94),
        row(2, 100),
        row(3, 46),
        row(4, 0),
        row(5, 46),
        row(6, 99),
        row(7, 10, { disabled: true }),
        { number: 8, email: 'u8@example.com', active: false, usageStatus: 'relogin_required', usage: null },
      ],
    }),
  );
  const items = buildQuickSwitchItems(smart, options());
  const layout = items.map((item) => (item.separator ? `--${item.label}` : item.action?.kind === 'strategy' ? item.action.strategy : item.action?.kind === 'account' ? item.action.slot : '?'));

  it('groups accounts by usefulness: strategies, current, headroom first, soonest reset first, then the rest', () => {
    assert.deepEqual(layout, [
      '--Pick automatically',
      'best',
      'next-available',
      '--Current account',
      5,
      '--Available',
      4,
      3,
      1,
      '--At limit',
      6,
      2,
      '--Disabled or unknown',
      7,
      8,
    ]);
  });

  it('shows a usage bar with the next reset and keeps details on the second line', () => {
    const four = items.find((item) => item.action?.kind === 'account' && item.action.slot === 4);
    // Same columns as the sidebar: slot, usage (padded with figure spaces) and reset first, the name last.
    assert.equal(four?.label, `4 · 7d ░░░░░░░░░░ ${FIGURE_SPACE.repeat(2)}0% · ↻ 3d 20h · u4@example.com`);
    assert.equal(four?.description, undefined);
    assert.equal(four?.detail, 'Ultra · ModelA 1% · updated 1m ago');
    assert.equal(four?.iconId, 'account');
    const current = items.find((item) => item.action?.kind === 'account' && item.action.active);
    assert.match(current?.detail ?? '', /^Current · Ultra/);
    assert.equal(current?.iconId, 'pass-filled');
  });

  it('flags limits with icons and does not repeat the subscription status', () => {
    const icon = (slot: number) => items.find((item) => item.action?.kind === 'account' && item.action.slot === slot)?.iconId;
    assert.equal(icon(1), 'warning');
    assert.equal(icon(2), 'error');
    assert.equal(icon(8), 'circle-slash');
    assert.equal(items.some((item) => item.description?.includes('active') || item.detail?.includes('· active')), false);
    const eight = items.find((item) => item.action?.kind === 'account' && item.action.slot === 8);
    assert.match(eight?.label ?? '', /^8 · re-login required · /);
  });

  it('uses shorter bars when an account has several windows', () => {
    const multi = snapshot(
      JSON.stringify({
        schemaVersion: 1,
        activeAccountNumber: 1,
        accounts: [{ number: 1, email: 'a@example.com', active: true, usageStatus: 'ok', usage: { fiveHour: { pct: 50 }, sevenDay: { pct: 20 } } }],
      }),
    );
    const item = buildQuickSwitchItems(multi, options()).find((candidate) => candidate.action?.kind === 'account');
    assert.equal(item?.label, '1 · 5h ███░░░ 50% · 7d █▎░░░░ 20% · a@example.com');
    // The label is display-ready: slanted cells stay icons, since the switcher does not re-sanitise it.
    const slanted = buildQuickSwitchItems(multi, options({ barStyle: 'parallelograms' })).find((candidate) => candidate.action?.kind === 'account');
    assert.match(slanted?.label ?? '', /^1 · 5h (\$\(cswap-slant-[0-8]\)){6} 50%/);
  });
});
