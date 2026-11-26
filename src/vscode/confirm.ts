import * as vscode from 'vscode';
import { t } from './presentation';

export interface ConfirmQuestion {
  readonly question: string;
  /** Paragraphs under the question. */
  readonly detail: string | readonly string[];
  /**
   * The warning icon, for a step that deletes, overwrites or exposes something or costs money;
   * other questions get the calmer information icon.
   */
  readonly risky?: boolean;
}

/**
 * Asks in a modal dialog and returns the action picked, or `undefined` for Cancel or Escape. The
 * Cancel button is the extension's own, so it follows the extension's language instead of
 * VS Code's.
 */
export async function confirm<T extends string>(ask: ConfirmQuestion, ...actions: readonly T[]): Promise<T | undefined> {
  const cancel: vscode.MessageItem = { title: t('Cancel'), isCloseAffordance: true };
  const items: vscode.MessageItem[] = [...actions.map((title) => ({ title })), cancel];
  const options: vscode.MessageOptions = { modal: true, detail: typeof ask.detail === 'string' ? ask.detail : ask.detail.join('\n\n') };
  const choice = ask.risky
    ? await vscode.window.showWarningMessage(ask.question, options, ...items)
    : await vscode.window.showInformationMessage(ask.question, options, ...items);
  return actions.find((action) => action === choice?.title);
}
