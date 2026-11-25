import * as vscode from 'vscode';
import type { Account } from '../core/model/types';
import { accountName } from '../core/presentation/accountTree';
import { compactDuration, formatPercent, windowLabel } from '../core/presentation/format';
import {
  loginReminders,
  noticeShown,
  readNoticeRecords,
  rememberNotice,
  usageAlert,
  type LoginReminder,
  type NoticeRecord,
  type UsageAlert,
} from '../core/presentation/notifications';
import { weeklyResets, weeklyWindow } from '../core/presentation/snapshotChanges';
import { sanitizeLabel } from '../core/presentation/statusBar';
import { neutralizeLinks } from '../core/security/redact';
import type { RefreshService } from '../core/service/refreshService';
import type { ExtensionConfiguration } from './configuration';
import { formatDateTime, t } from './presentation';
import { onFocusedSnapshotChange } from './snapshotTransitions';

/** Notices already shown (no emails: accounts are named by a short hash). */
const SHOWN_KEY = 'cswapManager.notifications.shown';

/**
 * The notifications that follow a refresh. Only the window in front speaks, so several open windows
 * do not repeat them:
 * - `cswapManager.notifyOnWeeklyReset` (off by default): which accounts' weekly limit reset, with a
 *   button to switch to one.
 * - `cswapManager.notifyAtUsage` (90% by default): the active account's limiting window reached the
 *   level, while automatic switching is not on.
 * - `cswapManager.notifyLoginExpiry` (on by default): a stored login expires within three days, or
 *   has expired.
 * The last two are shown once (per account, window or phase, and time), remembered across reloads.
 */
export function watchNotifications(context: vscode.ExtensionContext, refreshService: RefreshService, configuration: ExtensionConfiguration): vscode.Disposable {
  const shown = new ShownNotices(context.globalState);
  return onFocusedSnapshotChange(refreshService, (previous, current) => {
    const now = Date.now();
    if (configuration.notifyOnWeeklyReset()) {
      for (const account of weeklyResets(previous, current)) {
        announceReset(account, current.active.slot === account.slot);
      }
    }
    if (configuration.autoSwitchMode() !== 'switch') {
      const alert = usageAlert(current, configuration.notifyAtUsage(), now);
      if (alert !== undefined && shown.once(alert.notice, now)) {
        announceUsage(alert, configuration);
      }
    }
    if (configuration.notifyLoginExpiry()) {
      for (const reminder of loginReminders(current, now)) {
        if (shown.once(reminder.notice, now)) {
          announceLogin(reminder, now);
        }
      }
    }
  });
}

/** Remembers shown notices in globalState, which every window shares and which survives reloads. */
class ShownNotices {
  constructor(private readonly state: vscode.Memento) {}

  /** True the first time a notice comes up (it is then remembered); false once it has been shown. */
  once(notice: NoticeRecord, now: number): boolean {
    const records = readNoticeRecords(this.state.get<unknown>(SHOWN_KEY));
    if (noticeShown(records, notice)) {
      return false;
    }
    void this.state.update(SHOWN_KEY, rememberNotice(records, notice, now)).then(undefined, () => undefined);
    return true;
  }
}

/** Account data cannot add icons or links to a notification. */
function shownName(account: Account): string {
  return neutralizeLinks(sanitizeLabel(accountName(account, t)));
}

function announceReset(account: Account, isActive: boolean): void {
  const left = formatPercent(100 - (weeklyWindow(account)?.pct ?? 0));
  const text = t('{0} (slot {1}) has a fresh weekly limit: {2} left.', shownName(account), account.slot, left);
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

function announceUsage(alert: UsageAlert, configuration: ExtensionConfiguration): void {
  const limit = neutralizeLinks(sanitizeLabel(windowLabel(alert.window.key)));
  const text = t('{0} (slot {1}) is at {2} of its {3} limit.', shownName(alert.account), alert.account.slot, formatPercent(alert.pct), limit);
  const switchBest = t('Switch to most quota left');
  const switchAtLimit = t('Switch automatically when used up');
  void vscode.window.showWarningMessage(text, switchBest, switchAtLimit).then((choice) => {
    if (choice === switchBest) {
      void vscode.commands.executeCommand('cswapManager.switchBest');
    } else if (choice === switchAtLimit && configuration.autoSwitchMode() !== 'switch') {
      // The command is a toggle: once switching is on (turned on elsewhere meanwhile) it would undo it.
      void vscode.commands.executeCommand('cswapManager.toggleSwitchAtLimit');
    }
  });
}

function announceLogin(reminder: LoginReminder, now: number): void {
  const name = shownName(reminder.account);
  const slot = reminder.account.slot;
  if (reminder.phase === 'expired') {
    void vscode.window.showWarningMessage(
      t('The login of {0} (slot {1}) has expired. Log in to it again with /login in Claude Code; the extension then stores the new login.', name, slot),
    );
    return;
  }
  const when = t('in {0} ({1})', compactDuration(reminder.expiresAt - now), formatDateTime(reminder.expiresAt));
  void vscode.window.showInformationMessage(
    t('The login of {0} (slot {1}) expires {2}. Log in to it again with /login in Claude Code; the extension then stores the new login.', name, slot, when),
  );
}
