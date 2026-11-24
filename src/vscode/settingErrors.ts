import * as os from 'node:os';
import * as vscode from 'vscode';
import { neutralizeLinks } from '../core/security/redact';
import { SettingNotLoadedError } from './configuration';
import { errorReason } from './messages';
import { t } from './presentation';

/** After an auto-update, settings the update added are unknown until the window reloads. */
export async function offerReload(): Promise<void> {
  const reload = t('Reload Window');
  const choice = await vscode.window.showWarningMessage(
    t('Cswap Manager was just updated, but this window has not loaded its new settings yet, so they cannot be saved. Reload the window, then try again.'),
    reload,
  );
  if (choice === reload) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/** Shows why a setting was not saved, in VS Code's own words (redacted), never a guess. */
export function showSaveFailed(error: unknown): void {
  if (error instanceof SettingNotLoadedError) {
    void offerReload();
    return;
  }
  void vscode.window.showWarningMessage(neutralizeLinks(t('The setting could not be saved: {0}', errorReason(error, os.homedir()))));
}
