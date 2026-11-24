import * as vscode from 'vscode';
import type { AccountsSnapshot } from '../core/model/types';
import { accountName } from '../core/presentation/accountTree';
import { formatPercent } from '../core/presentation/format';
import { sanitizeLabel } from '../core/presentation/statusBar';
import { weeklyResets, weeklyWindow } from '../core/presentation/weeklyResets';
import { neutralizeLinks } from '../core/security/redact';
import type { RefreshService } from '../core/service/refreshService';
import type { ExtensionConfiguration } from './configuration';
import { t } from './presentation';

/**
 * `cswapManager.notifyOnWeeklyReset` (off by default): after a refresh, says which accounts' weekly
 * limit reset, with a button to switch to one. Only the window in front speaks, so several open
 * windows do not repeat it.
 */
export class WeeklyResetNotifier implements vscode.Disposable {
  private previous: AccountsSnapshot | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly refreshService: RefreshService,
    private readonly configuration: ExtensionConfiguration,
  ) {
    this.previous = refreshService.getState().snapshot;
    this.subscription = refreshService.onDidChange(() => this.check());
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private check(): void {
    const snapshot = this.refreshService.getState().snapshot;
    if (snapshot === undefined || snapshot === this.previous) {
      return;
    }
    const previous = this.previous;
    this.previous = snapshot;
    if (!this.configuration.notifyOnWeeklyReset() || !vscode.window.state.focused) {
      return;
    }
    for (const account of weeklyResets(previous, snapshot)) {
      const left = formatPercent(100 - (weeklyWindow(account)?.pct ?? 0));
      const name = neutralizeLinks(sanitizeLabel(accountName(account, t)));
      const text = t('{0} (slot {1}) has a fresh weekly limit: {2} left.', name, account.slot, left);
      if (snapshot.active.slot === account.slot) {
        void vscode.window.showInformationMessage(text);
        continue;
      }
      const switchTo = t('Switch');
      void vscode.window.showInformationMessage(text, switchTo).then((choice) => {
        if (choice === switchTo) {
          void vscode.commands.executeCommand('cswapManager.switchToAccount', { slot: account.slot });
        }
      });
    }
  }
}
