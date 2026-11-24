import * as vscode from 'vscode';
import type { Account } from '../core/model/types';
import { accountName } from '../core/presentation/accountTree';
import { formatPercent } from '../core/presentation/format';
import { weeklyResets, weeklyWindow } from '../core/presentation/snapshotChanges';
import { sanitizeLabel } from '../core/presentation/statusBar';
import { neutralizeLinks } from '../core/security/redact';
import type { RefreshService } from '../core/service/refreshService';
import type { ExtensionConfiguration } from './configuration';
import { t } from './presentation';
import { onFocusedSnapshotChange } from './snapshotTransitions';

/**
 * `cswapManager.notifyOnWeeklyReset` (off by default): after a refresh, says which accounts' weekly
 * limit reset, with a button to switch to one. Only the window in front speaks, so several open
 * windows do not repeat it.
 */
export function watchWeeklyResets(refreshService: RefreshService, configuration: ExtensionConfiguration): vscode.Disposable {
  return onFocusedSnapshotChange(refreshService, (previous, current) => {
    if (!configuration.notifyOnWeeklyReset()) {
      return;
    }
    for (const account of weeklyResets(previous, current)) {
      announceReset(account, current.active.slot === account.slot);
    }
  });
}

function announceReset(account: Account, isActive: boolean): void {
  const left = formatPercent(100 - (weeklyWindow(account)?.pct ?? 0));
  const name = neutralizeLinks(sanitizeLabel(accountName(account, t)));
  const text = t('{0} (slot {1}) has a fresh weekly limit: {2} left.', name, account.slot, left);
  if (isActive) {
    void vscode.window.showInformationMessage(text);
    return;
  }
  const switchTo = t('Switch');
  void vscode.window.showInformationMessage(text, switchTo).then((choice) => {
    if (choice === switchTo) {
      void vscode.commands.executeCommand('cswapManager.switchToAccount', { slot: account.slot });
    }
  });
}
