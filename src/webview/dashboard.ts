import type {
  AccountDetail,
  DashboardModel,
  DashboardRow,
  DetailSection,
  Fact,
  Meter,
  SummaryCard,
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
}

const vscode = acquireVsCodeApi();
const COLUMNS: ReadonlyArray<{ key: TableSortKey; label: (model: DashboardModel) => string }> = [
  { key: 'slot', label: (m) => m.strings.columnSlot },
  { key: 'name', label: (m) => m.strings.columnName },
  { key: 'plan', label: (m) => m.strings.columnPlan },
  { key: 'usage', label: (m) => m.strings.columnUsage },
  { key: 'reset', label: (m) => m.strings.columnReset },
  { key: 'status', label: (m) => m.strings.columnStatus },
];

let model: DashboardModel | undefined;
let ui: UiState = restoreUiState(vscode.getState());

function restoreUiState(raw: unknown): UiState {
  const fallback: UiState = { query: '', sortKey: 'slot', sortDirection: 'asc' };
  if (typeof raw !== 'object' || raw === null) {
    return fallback;
  }
  const value = raw as Record<string, unknown>;
  return {
    ...(typeof value['selectedSlot'] === 'number' ? { selectedSlot: value['selectedSlot'] } : {}),
    query: typeof value['query'] === 'string' ? value['query'] : '',
    sortKey: isTableSortKey(value['sortKey']) ? value['sortKey'] : 'slot',
    sortDirection: value['sortDirection'] === 'desc' ? 'desc' : 'asc',
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

function button(text: string, onClick: () => void, options: { className?: string; disabled?: boolean; focusKey?: string } = {}): HTMLButtonElement {
  const node = el('button', { className: options.className ?? 'button', text, attrs: { type: 'button' } });
  if (options.disabled) {
    node.disabled = true;
  }
  if (options.focusKey) {
    node.dataset['focusKey'] = options.focusKey;
  }
  node.addEventListener('click', onClick);
  return node;
}

function bar(label: string, pct: number | undefined, level: string, valueText: string): HTMLElement {
  const fill = el('span', { className: 'bar-fill' });
  const clamped = pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
  fill.style.width = `${clamped}%`;
  const attrs: Record<string, string> = { role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuetext': valueText };
  if (pct !== undefined) {
    attrs['aria-valuenow'] = String(clamped);
  }
  return el('div', { className: `bar level-${level}`, attrs }, [fill]);
}

// ---- Static skeleton (built once so the search box keeps focus across updates) ----

const app = document.getElementById('app') ?? document.body;
const title = el('h1', { className: 'title' });
const busyText = el('span', { className: 'busy', attrs: { role: 'status', 'aria-live': 'polite' } });
const actions = el('div', { className: 'actions' });
const message = el('p', { className: 'message', attrs: { role: 'status', 'aria-live': 'polite' } });
const summary = el('section', { className: 'summary' });
const accountsHeading = el('h2', { attrs: { id: 'accounts-heading' } });
const searchLabel = el('label', { attrs: { for: 'search' } });
const search = el('input', { className: 'search', attrs: { id: 'search', type: 'search', autocomplete: 'off', spellcheck: 'false' } });
const matchCount = el('span', { className: 'match-count', attrs: { 'aria-live': 'polite' } });
const table = el('table', { className: 'accounts', attrs: { 'aria-labelledby': 'accounts-heading' } });
const detailHeading = el('h2', { attrs: { id: 'detail-heading' } });
const detail = el('div', { className: 'detail-body' });

search.value = ui.query;
search.addEventListener('input', () => {
  ui = { ...ui, query: search.value };
  saveUiState();
  renderTable();
});

app.replaceChildren(
  el('header', { className: 'toolbar' }, [title, busyText, actions]),
  message,
  summary,
  el('div', { className: 'layout' }, [
    el('section', { className: 'panel accounts-panel', attrs: { 'aria-labelledby': 'accounts-heading' } }, [
      accountsHeading,
      el('div', { className: 'search-row' }, [searchLabel, search, matchCount]),
      el('div', { className: 'table-scroll' }, [table]),
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

// ---- Rendering ----

function renderHeader(current: DashboardModel): void {
  const s = current.strings;
  title.textContent = s.title;
  summary.setAttribute('aria-label', s.summary);
  busyText.textContent = current.busy ? s.busy : '';
  const canSwitch = current.canSwitch && !current.busy;
  actions.replaceChildren(
    button(s.refresh, () => post({ type: 'refresh' }), { disabled: current.busy, focusKey: 'action:refresh' }),
    button(s.switchBest, () => post({ type: 'switchStrategy', strategy: 'best' }), { disabled: !canSwitch, focusKey: 'action:best', className: 'button secondary' }),
    button(s.switchNext, () => post({ type: 'switchStrategy', strategy: 'next-available' }), {
      disabled: !canSwitch,
      focusKey: 'action:next',
      className: 'button secondary',
    }),
    button(s.settings, () => post({ type: 'openSettings' }), { focusKey: 'action:settings', className: 'button secondary' }),
    button(s.diagnostics, () => post({ type: 'showDiagnostics' }), { focusKey: 'action:diagnostics', className: 'button secondary' }),
  );
  message.textContent = current.message ?? '';
  message.className = `message tone-${current.messageTone ?? 'neutral'}`;
  message.hidden = current.message === undefined;
  accountsHeading.textContent = s.accountsHeading;
  searchLabel.textContent = s.searchLabel;
  search.placeholder = s.searchPlaceholder;
  detailHeading.textContent = s.detailHeading;
}

function renderSummary(cards: readonly SummaryCard[]): void {
  summary.replaceChildren(
    ...cards.map((card) =>
      el('div', { className: `card tone-${card.tone}` }, [
        el('div', { className: 'card-label', text: card.label }),
        el('div', { className: 'card-value', text: card.value }),
        card.detail !== undefined && el('div', { className: 'card-detail', text: card.detail }),
      ]),
    ),
  );
}

function sortHeader(current: DashboardModel, key: TableSortKey, label: string): HTMLTableCellElement {
  const activeSort = ui.sortKey === key;
  const indicator = activeSort ? (ui.sortDirection === 'asc' ? ' ▲' : ' ▼') : '';
  const th = el('th', { attrs: { scope: 'col', 'aria-sort': activeSort ? (ui.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none' } });
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
    { className: 'usage-cell' },
    row.usage.map((cell) =>
      el('div', { className: 'usage-item' }, [
        el('span', { className: 'usage-label', text: `${cell.label} ${cell.pctText}` }),
        bar(cell.label, cell.pct, cell.level, cell.pctText),
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

  const head = el('thead', {}, [el('tr', {}, COLUMNS.map((column) => sortHeader(current, column.key, column.label(current))))]);
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
      el('td', { className: 'slot', text: `${row.active ? '● ' : ''}${row.slot}` }),
      el('td', {}, [nameButton, row.secondary !== undefined && el('div', { className: 'secondary', text: row.secondary })]),
      el('td', { text: row.plan ?? '—' }),
      usageCell(row),
      el('td', { text: row.resetText ?? '—' }),
      el('td', {}, [el('span', { className: `status tone-${row.statusTone}`, text: row.statusText })]),
    ]);
    tr.addEventListener('click', (event) => {
      if (!(event.target instanceof HTMLButtonElement)) {
        selectRow(row.slot);
      }
    });
    body.append(tr);
  }
  table.replaceChildren(head, body);
}

function renderFacts(facts: readonly Fact[]): HTMLElement | undefined {
  if (facts.length === 0) {
    return undefined;
  }
  return el('dl', { className: 'facts' }, facts.flatMap((fact) => [el('dt', { text: fact.label }), el('dd', { text: fact.value })]));
}

function renderMeter(meter: Meter): HTMLElement {
  return el('div', { className: `meter level-${meter.level}` }, [
    el('div', { className: 'meter-head' }, [el('span', { className: 'meter-label', text: meter.label }), el('span', { className: 'meter-value', text: meter.pctText })]),
    bar(meter.label, meter.pct, meter.level, meter.caption ? `${meter.pctText}, ${meter.caption}` : meter.pctText),
    meter.caption !== undefined && el('div', { className: 'meter-caption', text: meter.caption }),
    renderFacts(meter.facts),
  ]);
}

function renderSection(section: DetailSection): HTMLElement {
  return el('section', { className: 'detail-section' }, [
    el('h4', { text: section.title }),
    section.note !== undefined && el('p', { className: `note tone-${section.noteTone ?? 'neutral'}`, text: section.note }),
    section.meters.length > 0 && el('div', { className: 'meters' }, section.meters.map(renderMeter)),
    renderFacts(section.facts),
  ]);
}

function renderAccountDetail(current: DashboardModel, account: AccountDetail): HTMLElement[] {
  return [
    el('div', { className: 'detail-header' }, [
      el('h3', { text: account.title }),
      account.subtitle !== undefined && el('div', { className: 'secondary', text: account.subtitle }),
      el('div', { className: 'badges' }, account.badges.map((badge) => el('span', { className: `badge tone-${badge.tone}`, text: badge.text }))),
      account.canSwitch &&
        button(current.strings.switchToAccount, () => post({ type: 'switchToAccount', slot: account.slot }), {
          disabled: current.busy,
          focusKey: `switch:${account.slot}`,
        }),
      account.actions.length > 0 &&
        el(
          'div',
          { className: 'account-actions' },
          account.actions.map((action) =>
            button(action.label, () => post({ type: 'manageAccount', action: action.id, slot: account.slot }), {
              className: 'button secondary',
              disabled: current.busy,
              focusKey: `action:${action.id}:${account.slot}`,
            }),
          ),
        ),
    ]),
    ...account.sections.map(renderSection),
  ];
}

function renderDetail(): void {
  if (model === undefined) {
    return;
  }
  const row = model.rows.find((candidate) => candidate.slot === ui.selectedSlot);
  detail.replaceChildren(...(row === undefined ? [el('p', { className: 'placeholder', text: model.strings.noSelection })] : renderAccountDetail(model, row.detail)));
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
    renderSummary(current.summary);
    renderTable();
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
    detailHeading.scrollIntoView({ block: 'nearest' });
  }
});

post({ type: 'ready' });
