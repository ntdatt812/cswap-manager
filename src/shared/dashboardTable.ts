import type { DashboardRow } from './dashboardProtocol';

export type TableSortKey = 'slot' | 'name' | 'plan' | 'usage' | 'reset' | 'status';
export type SortDirection = 'asc' | 'desc';
export const TABLE_SORT_KEYS: readonly TableSortKey[] = ['slot', 'name', 'plan', 'usage', 'reset', 'status'];

export function isTableSortKey(value: unknown): value is TableSortKey {
  return typeof value === 'string' && (TABLE_SORT_KEYS as readonly string[]).includes(value);
}

/** Every whitespace-separated term must appear in the row's search text. */
export function filterRows(rows: readonly DashboardRow[], query: string): DashboardRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  return rows.filter((row) => terms.every((term) => row.searchText.includes(term)));
}

function sortValue(row: DashboardRow, key: TableSortKey): number | string | undefined {
  switch (key) {
    case 'slot':
      return row.slot;
    case 'name':
      return row.name.toLowerCase();
    case 'plan':
      return row.plan?.toLowerCase();
    case 'usage':
      return row.maxPct;
    case 'reset':
      return row.resetEpoch;
    case 'status':
      return row.statusText.toLowerCase();
  }
}

/** Stable sort; missing values always go last, ties keep slot order. */
export function sortRows(rows: readonly DashboardRow[], key: TableSortKey, direction: SortDirection): DashboardRow[] {
  const factor = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left === undefined || right === undefined) {
      if (left === right) {
        return a.slot - b.slot;
      }
      return left === undefined ? 1 : -1;
    }
    const compared = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
    return compared * factor || a.slot - b.slot;
  });
}
