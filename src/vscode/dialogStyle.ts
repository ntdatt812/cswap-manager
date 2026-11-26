import * as vscode from 'vscode';
import { SYSTEM_DIALOGS, THEMED_DIALOGS, themedDialogsOnFirstRun } from '../core/presentation/dialogStyle';
import { t } from './presentation';
import { showSaveFailed } from './settingErrors';

/** Set once the first run has decided, so a style the user changes later is never touched again. */
const DECIDED_KEY = 'themedDialogs.decided';

const windowSettings = () => vscode.workspace.getConfiguration('window');

export function themedDialogsOn(): boolean {
  return windowSettings().get<string>('dialogStyle') === THEMED_DIALOGS;
}

/** VS Code reads the style each time it shows a dialog, so the change needs no restart. */
export async function setThemedDialogs(on: boolean): Promise<void> {
  await windowSettings().update('dialogStyle', on ? THEMED_DIALOGS : SYSTEM_DIALOGS, vscode.ConfigurationTarget.Global);
}

/**
 * Once per installation: turns on VS Code's themed dialogs, so confirmations follow the colour
 * theme instead of looking like system message boxes. An extension cannot contribute a default
 * for this application-wide setting, so it is written to the user's settings, with Undo.
 */
export async function useThemedDialogsOnce(state: vscode.Memento, platform: string = process.platform): Promise<void> {
  if (state.get(DECIDED_KEY) === true) {
    return;
  }
  await state.update(DECIDED_KEY, true);
  if (!themedDialogsOnFirstRun(platform, windowSettings().inspect('dialogStyle')?.globalValue)) {
    return;
  }
  try {
    await setThemedDialogs(true);
  } catch {
    return;
  }
  const undo = t('Undo');
  const choice = await vscode.window.showInformationMessage(t("Cswap Manager: VS Code's dialogs now follow your colour theme. Change it under Cswap Settings › Advanced › Dialogs."), undo);
  if (choice === undo) {
    try {
      await setThemedDialogs(false);
    } catch (error) {
      showSaveFailed(error);
    }
  }
}
