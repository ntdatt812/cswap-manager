import * as vscode from 'vscode';
import type { AccountsSnapshot } from '../core/model/types';
import type { RefreshService } from '../core/service/refreshService';

/**
 * Calls `listener` with the previous and the new snapshot each time a refresh brings new data.
 * Every open window refreshes; only the one in front is told, so nothing runs or asks twice.
 */
export function onFocusedSnapshotChange(
  refreshService: RefreshService,
  listener: (previous: AccountsSnapshot | undefined, current: AccountsSnapshot) => void,
): vscode.Disposable {
  let previous = refreshService.getState().snapshot;
  return refreshService.onDidChange((state) => {
    const current = state.snapshot;
    if (current === undefined || current === previous) {
      return;
    }
    const before = previous;
    previous = current;
    if (vscode.window.state.focused) {
      listener(before, current);
    }
  });
}
