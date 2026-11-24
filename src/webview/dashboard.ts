import type {
  AccountDetail,
  ActiveOverview,
  AutoSwitchOverview,
  CapacityOverview,
  DashboardModel,
  DashboardRow,
  DetailSection,
  Fact,
  Insight,
  Meter,
  TimelineItem,
  WebviewToHost,
} from '../shared/dashboardProtocol';
import { filterRows, isTableSortKey, sortRows, type SortDirection, type TableSortKey } from '../shared/dashboardTable';

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface UiState {
  selectedSlot?: number;
  query: string;
  sortKey: TableSortKey;
  sortDirection: SortDirection;
  /** Keys of folded sections the user opened (kept across the 30-second re-renders). */
  open: string[];
}

const vscode = acquireVsCodeApi();
const COLUMNS: ReadonlyArray<{ key: TableSortKey; label: (model: DashboardModel) => string; className: string }> = [
  { key: 'slot', label: (m) => m.strings.columnSlot, className: 'col-slot' },
  { key: 'name', label: (m) => m.strings.columnName, className: 'col-name' },
  { key: 'plan', label: (m) => m.strings.columnPlan, className: 'col-plan' },
  { key: 'usage', label: (m) => m.strings.columnUsage, className: 'col-usage' },
  { key: 'reset', label: (m) => m.strings.columnReset, className: 'col-reset' },
];

let model: DashboardModel | undefined;
let ui: UiState = restoreUiState(vscode.getState());

function restoreUiState(raw: unknown): UiState {
  const fallback: UiState = { query: '', sortKey: 'slot', sortDirection: 'asc', open: [] };
  if (typeof raw !== 'object' || raw === null) {
    return fallback;
  }
  const value = raw as Record<string, unknown>;
  const open = Array.isArray(value['open']) ? value['open'].filter((key): key is string => typeof key === 'string').slice(0, 20) : [];
  return {
    ...(typeof value['selectedSlot'] === 'number' ? { selectedSlot: value['selectedSlot'] } : {}),
    query: typeof value['query'] === 'string' ? value['query'] : '',
    // Only columns still shown (an old saved "status" sort falls back to slot).
    sortKey: isTableSortKey(value['sortKey']) && COLUMNS.some((column) => column.key === value['sortKey']) ? value['sortKey'] : 'slot',
    sortDirection: value['sortDirection'] === 'desc' ? 'desc' : 'asc',
    open,
  };
}

function saveUiState(): void {
  vscode.setState(ui);
}

type Child = Node | string | undefined | false;

/** DOM helper: text goes through text nodes only, never through HTML parsing. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string> } = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) {
    node.className = props.className;
  }
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  if (props.text !== undefined) {
    node.textContent = props.text;
  }
  for (const child of children) {
    if (child !== undefined && child !== false) {
      node.append(child);
    }
  }
  return node;
}

function button(text: string, onClick: () => void, options: { className?: string; disabled?: boolean; focusKey?: string; title?: string } = {}): HTMLButtonElement {
  const node = el('button', { className: options.className ?? 'button', text, attrs: { type: 'button' } });
  if (options.disabled) {
    node.disabled = true;
  }
  if (options.focusKey) {
    node.dataset['focusKey'] = options.focusKey;
  }
  if (options.title) {
    node.title = options.title;
  }
  node.addEventListener('click', onClick);
  return node;
}

function bar(label: string, pct: number | undefined, level: string, valueText: string, className = 'bar'): HTMLElement {
  const fill = el('span', { className: 'bar-fill' });
  const clamped = pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
  fill.style.width = `${clamped}%`;
  const attrs: Record<string, string> = { role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuetext': valueText };
  if (pct !== undefined) {
    attrs['aria-valuenow'] = String(clamped);
  }
  return el('div', { className: `${className} level-${level}`, attrs }, [fill]);
}

/** A folded section that remembers being opened across re-renders. */
function foldable(key: string, summaryText: string, content: Child[], className = 'fold'): HTMLDetailsElement {
  const summary = el('summary', { text: summaryText });
  // Keeps keyboard focus on the same fold header across the 30-second re-render.
  summary.dataset['focusKey'] = `fold:${key}`;
  const details = el('details', { className }, [summary, ...content]);
  details.open = ui.open.includes(key);
  details.addEventListener('toggle', () => {
    const others = ui.open.filter((candidate) => candidate !== key);
    ui = { ...ui, open: details.open ? [...others, key] : others };
    saveUiState();
  });
  return details;
}

// ---- Static skeleton (built once so the search box keeps focus across updates) ----

const app = document.getElementById('app') ?? document.body;
const title = el('h1', { className: 'title' });
const freshness = el('span', { className: 'pill', attrs: { role: 'status', 'aria-live': 'polite' } });
const actions = el('div', { className: 'actions' });
const message = el('p', { className: 'message', attrs: { role: 'status', 'aria-live': 'polite' } });
const insights = el('section', { className: 'insights' });
const overview = el('section', { className: 'overview' });
const accountsHeading = el('h2', { attrs: { id: 'accounts-heading' } });
const accountCount = el('span', { className: 'count' });
const searchLabel = el('label', { className: 'visually-hidden', attrs: { for: 'search' } });
const search = el('input', { className: 'search', attrs: { id: 'search', type: 'search', autocomplete: 'off', spellcheck: 'false' } });
const matchCount = el('span', { className: 'match-count', attrs: { 'aria-live': 'polite' } });
const table = el('table', { className: 'accounts', attrs: { 'aria-labelledby': 'accounts-heading' } });
const timelineHeading = el('h2', { attrs: { id: 'timeline-heading' } });
const timeline = el('div', { className: 'timeline' });
const detailHeading = el('h2', { className: 'visually-hidden', attrs: { id: 'detail-heading' } });
const detail = el('div', { className: 'detail-body' });

search.value = ui.query;
search.addEventListener('input', () => {
  ui = { ...ui, query: search.value };
  saveUiState();
  renderTable();
});

app.replaceChildren(
  el('header', { className: 'topbar' }, [el('div', { className: 'title-block' }, [title, freshness]), actions]),
  message,
  insights,
  overview,
  el('div', { className: 'layout' }, [
    el('div', { className: 'main-column' }, [
      el('section', { className: 'panel accounts-panel', attrs: { 'aria-labelledby': 'accounts-heading' } }, [
        el('div', { className: 'panel-head' }, [el('div', { className: 'heading-row' }, [accountsHeading, accountCount]), el('div', { className: 'search-row' }, [searchLabel, search, matchCount])]),
        el('div', { className: 'table-scroll' }, [table]),
      ]),
      el('section', { className: 'panel timeline-panel', attrs: { 'aria-labelledby': 'timeline-heading' } }, [timelineHeading, timeline]),
    ]),
    el('section', { className: 'panel detail-panel', attrs: { 'aria-labelledby': 'detail-heading' } }, [detailHeading, detail]),
  ]),
);

/** Re-renders while keeping keyboard focus on the equivalent control (matched by data-focus-key). */
function preservingFocus(update: () => void): void {
  const focusKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset['focusKey'] : undefined;
  update();
  if (focusKey !== undefined) {
    app.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }
}

function post(messageToHost: WebviewToHost): void {
  vscode.postMessage(messageToHost);
}

// ---- Header, suggestions, overview ----

function renderHeader(current: DashboardModel): void {
  const s = current.strings;
  title.textContent = s.title;
  freshness.textContent = current.busy ? s.busy : current.freshnessText;
  freshness.className = `pill tone-${current.busy ? 'neutral' : current.freshnessTone}${current.busy ? ' busy' : ''}`;
  actions.replaceChildren(
    button(s.refresh, () => post({ type: 'refresh' }), { disabled: current.busy, focusKey: 'action:refresh', className: 'button' }),
    button(s.settings, () => post({ type: 'openSettings' }), { focusKey: 'action:settings', className: 'button secondary' }),
    button(s.diagnostics, () => post({ type: 'showDiagnostics' }), { focusKey: 'action:diagnostics', className: 'button ghost' }),
  );
  message.textContent = current.message ?? '';
  message.className = `message tone-${current.messageTone ?? 'neutral'}`;
  message.hidden = current.message === undefined;
  accountsHeading.textContent = s.accountsHeading;
  accountCount.textContent = current.rows.length > 0 ? String(current.rows.length) : '';
  searchLabel.textContent = s.searchLabel;
  search.placeholder = s.searchPlaceholder;
  detailHeading.textContent = s.detailHeading;
  timelineHeading.textContent = s.timelineHeading;
  insights.setAttribute('aria-label', s.suggestions);
  overview.setAttribute('aria-label', s.summary);
}

function renderInsights(current: DashboardModel): void {
  const canSwitch = current.canSwitch && !current.busy;
  insights.hidden = current.insights.length === 0;
  insights.replaceChildren(
    ...current.insights.map((insight: Insight) =>
      el('div', { className: `insight tone-${insight.tone}` }, [
        el('div', { className: 'insight-text' }, [el('strong', { text: insight.title }), el('span', { text: insight.text })]),
        insight.switchSlot !== undefined &&
          insight.actionLabel !== undefined &&
          button(insight.actionLabel, () => post({ type: 'switchToAccount', slot: insight.switchSlot ?? 0 }), {
            disabled: !canSwitch,
            focusKey: `insight:${insight.id}`,
            className: 'button',
          }),
      ]),
    ),
  );
}

function meterBlock(meter: Meter, compact = false): HTMLElement {
  return el('div', { className: `meter level-${meter.level}${compact ? ' compact' : ''}` }, [
    el('div', { className: 'meter-head' }, [el('span', { className: 'meter-label', text: meter.label }), el('span', { className: 'meter-value', text: meter.pctText })]),
    bar(meter.label, meter.pct, meter.level, meter.caption ? `${meter.pctText}, ${meter.caption}` : meter.pctText),
    meter.caption !== undefined && el('div', { className: 'meter-caption', text: meter.caption }),
  ]);
}

function activeCard(current: DashboardModel, active: ActiveOverview | undefined): HTMLElement {
  const s = current.strings;
  const canSwitch = current.canSwitch && !current.busy;
  if (active === undefined) {
    return el('div', { className: 'card active-card' }, [el('div', { className: 'card-label', text: s.activeHeading }), el('p', { className: 'muted', text: s.noActive })]);
  }
  return el('div', { className: `card active-card level-${active.level}` }, [
    el('div', { className: 'card-label', text: s.activeHeading }),
    el('div', { className: 'active-name' }, [
      el('span', { className: 'slot-badge filled', text: String(active.slot) }),
      el('div', { className: 'name-stack' }, [
        el('span', { className: 'strong', text: active.name }),
        active.secondary !== undefined && el('span', { className: 'muted ellipsis', text: active.secondary, attrs: { title: active.secondary } }),
      ]),
      active.plan !== undefined && el('span', { className: 'chip', text: active.plan }),
    ]),
    active.flag !== undefined && el('span', { className: `flag tone-${active.flag.tone}`, text: active.flag.text }),
    el('div', { className: 'active-meters' }, active.meters.map((meter) => meterBlock(meter, true))),
    el('div', { className: 'card-actions' }, [
      button(s.switchBest, () => post({ type: 'switchStrategy', strategy: 'best' }), { disabled: !canSwitch, focusKey: 'action:best', className: 'button secondary small' }),
      button(s.switchNext, () => post({ type: 'switchStrategy', strategy: 'next-available' }), { disabled: !canSwitch, focusKey: 'action:next', className: 'button ghost small' }),
    ]),
  ]);
}

function capacityCard(current: DashboardModel, capacity: CapacityOverview | undefined): HTMLElement | undefined {
  if (capacity === undefined) {
    return undefined;
  }
  // The bar shows what is left, so its colour follows how little remains.
  return el('div', { className: 'card capacity-card' }, [
    el('div', { className: 'card-label', text: current.strings.capacityHeading }),
    el('div', { className: 'big-value', text: capacity.value }),
    el('div', { className: 'muted', text: capacity.caption }),
    bar(current.strings.capacityHeading, capacity.pct, capacity.level, `${Math.round(capacity.pct)}%`, 'bar thick remaining'),
    capacity.detail !== undefined && el('div', { className: 'muted small', text: capacity.detail }),
  ]);
}

function autoSwitchCard(current: DashboardModel, auto: AutoSwitchOverview | undefined): HTMLElement | undefined {
  if (auto === undefined) {
    return undefined;
  }
  return el('div', { className: `card auto-card tone-${auto.tone}` }, [
    el('div', { className: 'card-label', text: current.strings.autoSwitchHeading }),
    el('div', { className: 'big-value', text: auto.value }),
    auto.detail !== undefined && el('div', { className: 'muted', text: auto.detail }),
    el('div', { className: 'card-actions' }, [
      button(current.strings.configureAutoSwitch, () => post({ type: 'openAutoSwitch' }), { focusKey: 'action:auto', className: 'button secondary small' }),
    ]),
  ]);
}

function renderOverview(current: DashboardModel): void {
  overview.hidden = current.state !== 'ready';
  overview.replaceChildren(
    ...[activeCard(current, current.activeOverview), capacityCard(current, current.capacity), autoSwitchCard(current, current.autoSwitch)].filter(
      (card): card is HTMLElement => card !== undefined,
    ),
  );
}

// ---- Accounts table ----

function sortHeader(current: DashboardModel, key: TableSortKey, label: string, className: string): HTMLTableCellElement {
  const activeSort = ui.sortKey === key;
  const indicator = activeSort ? (ui.sortDirection === 'asc' ? ' ↑' : ' ↓') : '';
  const th = el('th', { className, attrs: { scope: 'col', 'aria-sort': activeSort ? (ui.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none' } });
  th.append(
    button(
      `${label}${indicator}`,
      () => {
        const direction: SortDirection = activeSort ? (ui.sortDirection === 'asc' ? 'desc' : 'asc') : key === 'usage' ? 'desc' : 'asc';
        ui = { ...ui, sortKey: key, sortDirection: direction };
        saveUiState();
        preservingFocus(renderTable);
      },
      { className: 'sort-button', focusKey: `sort:${key}` },
    ),
  );
  th.querySelector('button')?.setAttribute('aria-label', current.strings.sortBy.replace('{0}', label));
  return th;
}

function selectRow(slot: number): void {
  ui = { ...ui, selectedSlot: slot };
  saveUiState();
  preservingFocus(() => {
    renderTable();
    renderDetail();
  });
}

function usageCell(row: DashboardRow): HTMLTableCellElement {
  return el(
    'td',
    { className: 'col-usage' },
    row.usage.map((cell) =>
      el('div', { className: 'usage-line' }, [
        el('span', { className: 'usage-label', text: cell.label }),
        bar(cell.label, cell.pct, cell.level, cell.pctText),
        el('span', { className: `usage-pct level-${cell.level}`, text: cell.pctText }),
      ]),
    ),
  );
}

function renderTable(): void {
  if (model === undefined) {
    return;
  }
  const current = model;
  const rows = sortRows(filterRows(current.rows, ui.query), ui.sortKey, ui.sortDirection);
  matchCount.textContent = ui.query.trim() ? current.strings.matchCount.replace('{0}', String(rows.length)).replace('{1}', String(current.rows.length)) : '';

  const head = el('thead', {}, [el('tr', {}, COLUMNS.map((column) => sortHeader(current, column.key, column.label(current), column.className)))]);
  const body = el('tbody');
  if (rows.length === 0) {
    body.append(el('tr', {}, [el('td', { className: 'empty', text: current.rows.length === 0 ? '' : current.strings.noMatches, attrs: { colspan: String(COLUMNS.length) } })]));
  }
  for (const row of rows) {
    const selected = row.slot === ui.selectedSlot;
    const nameButton = button(row.name, () => selectRow(row.slot), { className: 'link-button', focusKey: `row:${row.slot}` });
    if (selected) {
      nameButton.setAttribute('aria-current', 'true');
    }
    const tr = el('tr', { className: `${selected ? 'selected' : ''} ${row.active ? 'active' : ''}`.trim() }, [
      el('td', { className: 'col-slot' }, [
        el('span', { className: `slot-badge${row.active ? ' filled' : ''}`, text: String(row.slot), attrs: row.active ? { title: current.strings.activeBadge } : {} }),
      ]),
      el('td', { className: 'col-name' }, [
        el('div', { className: 'name-line' }, [nameButton, row.active && el('span', { className: 'chip active', text: current.strings.activeBadge }), row.flag !== undefined && el('span', { className: `flag tone-${row.flag.tone}`, text: row.flag.text })]),
        row.secondary !== undefined && el('div', { className: 'muted ellipsis', text: row.secondary, attrs: { title: row.secondary } }),
      ]),
      el('td', { className: 'col-plan' }, [row.plan === undefined ? el('span', { className: 'muted', text: '—' }) : el('span', { className: 'chip', text: row.plan })]),
      usageCell(row),
      el('td', { className: 'col-reset muted', text: row.resetText ?? '—' }),
    ]);
    tr.addEventListener('click', (event) => {
      if (!(event.target instanceof HTMLButtonElement)) {
        selectRow(row.slot);
      }
    });
    body.append(tr);
  }
  const colgroup = el('colgroup', {}, COLUMNS.map((column) => el('col', { className: column.className })));
  table.replaceChildren(colgroup, head, body);
}

// ---- Reset timeline ----

function renderTimeline(current: DashboardModel): void {
  const s = current.strings;
  if (current.timeline.length === 0) {
    timeline.replaceChildren(el('p', { className: 'muted', text: current.state === 'ready' ? s.timelineEmpty : '' }));
    return;
  }
  const axis = el('div', { className: 'timeline-row axis', attrs: { 'aria-hidden': 'true' } }, [
    el('span'),
    el('div', { className: 'axis-labels' }, [el('span', { text: s.timelineStart }), el('span', { text: s.timelineEnd })]),
    el('span'),
  ]);
  const items = current.timeline.map((item: TimelineItem) => {
    const dot = el('span', { className: `timeline-dot level-${item.level}${item.active ? ' active' : ''}` });
    dot.style.left = `${item.position}%`;
    return el('li', { className: `timeline-row${item.active ? ' active' : ''}` }, [
      el('span', { className: 'timeline-when', text: item.whenText }),
      el('div', { className: 'timeline-track', attrs: { 'aria-hidden': 'true' } }, [dot]),
      el('span', { className: 'timeline-label' }, [
        el('span', { className: `slot-badge small${item.active ? ' filled' : ''}`, text: String(item.slot) }),
        el('span', { className: 'ellipsis', text: item.name }),
        el('span', { className: `muted level-text level-${item.level}`, text: item.remainingText }),
      ]),
    ]);
  });
  timeline.replaceChildren(axis, el('ul', { className: 'timeline-list' }, items));
}

// ---- Detail panel ----

function renderFacts(facts: readonly Fact[]): HTMLElement | undefined {
  if (facts.length === 0) {
    return undefined;
  }
  return el('dl', { className: 'facts' }, facts.flatMap((fact) => [el('dt', { text: fact.label }), el('dd', { text: fact.value })]));
}

function sectionContent(section: DetailSection): Child[] {
  return [
    section.note !== undefined && el('p', { className: `note tone-${section.noteTone ?? 'neutral'}`, text: section.note }),
    section.meters.length > 0 &&
      el(
        'div',
        { className: 'meters' },
        section.meters.map((meter) => el('div', {}, [meterBlock(meter), renderFacts(meter.facts)])),
      ),
    renderFacts(section.facts),
  ];
}

function renderSection(section: DetailSection): HTMLElement {
  if (section.collapsible === true) {
    return foldable(`section:${section.key}`, section.title, sectionContent(section));
  }
  return el('section', { className: 'detail-section' }, [el('h4', { text: section.title }), ...sectionContent(section)]);
}

function renderAccountDetail(current: DashboardModel, account: AccountDetail, active: boolean): HTMLElement[] {
  const s = current.strings;
  return [
    el('div', { className: 'detail-header' }, [
      el('div', { className: 'active-name' }, [
        el('span', { className: `slot-badge${active ? ' filled' : ''}`, text: String(account.slot) }),
        el('div', { className: 'name-stack' }, [
          el('h3', { text: account.title }),
          account.subtitle !== undefined && el('span', { className: 'muted', text: account.subtitle }),
        ]),
      ]),
      el('div', { className: 'badges' }, account.badges.map((badge) => el('span', { className: `chip tone-${badge.tone}`, text: badge.text }))),
      account.canSwitch &&
        button(s.switchToAccount, () => post({ type: 'switchToAccount', slot: account.slot }), {
          disabled: current.busy,
          focusKey: `switch:${account.slot}`,
          className: 'button wide',
        }),
    ]),
    ...account.sections.map(renderSection),
    account.actions.length > 0 &&
      foldable(
        'manage',
        s.manageHeading,
        [
          el(
            'div',
            { className: 'account-actions' },
            account.actions.map((action) =>
              button(action.label, () => post({ type: 'manageAccount', action: action.id, slot: account.slot }), {
                className: 'button secondary small',
                disabled: current.busy,
                focusKey: `action:${action.id}:${account.slot}`,
              }),
            ),
          ),
        ],
        'fold manage',
      ),
  ].filter((node): node is HTMLElement => node !== false);
}

function renderDetail(): void {
  if (model === undefined) {
    return;
  }
  const row = model.rows.find((candidate) => candidate.slot === ui.selectedSlot);
  detail.replaceChildren(...(row === undefined ? [el('p', { className: 'muted placeholder', text: model.strings.noSelection })] : renderAccountDetail(model, row.detail, row.active)));
}

function render(): void {
  const current = model;
  if (current === undefined) {
    return;
  }
  if (ui.selectedSlot === undefined || !current.rows.some((row) => row.slot === ui.selectedSlot)) {
    const active = current.rows.find((row) => row.active);
    ui = { ...ui, ...(active === undefined ? { selectedSlot: undefined } : { selectedSlot: active.slot }) };
  }
  preservingFocus(() => {
    renderHeader(current);
    renderInsights(current);
    renderOverview(current);
    renderTable();
    renderTimeline(current);
    renderDetail();
  });
  app.setAttribute('aria-busy', String(current.busy));
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null) {
    return;
  }
  const incoming = data as { type?: unknown; model?: unknown; slot?: unknown };
  if (incoming.type === 'state' && typeof incoming.model === 'object' && incoming.model !== null && Array.isArray((incoming.model as DashboardModel).rows)) {
    model = incoming.model as DashboardModel;
    render();
  } else if (incoming.type === 'select' && typeof incoming.slot === 'number') {
    selectRow(incoming.slot);
    detail.scrollIntoView({ block: 'nearest' });
  }
});

post({ type: 'ready' });
