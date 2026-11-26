/** VS Code's `window.dialogStyle` values: the system's message boxes, or dialogs drawn in the colour theme. */
export const SYSTEM_DIALOGS = 'native';
export const THEMED_DIALOGS = 'custom';

/**
 * Whether the first run turns on VS Code's themed dialogs. Not when the user already chose a
 * dialog style, and not on macOS, whose own dialogs already fit.
 */
export function themedDialogsOnFirstRun(platform: string, userValue: unknown): boolean {
  return platform !== 'darwin' && userValue === undefined;
}
