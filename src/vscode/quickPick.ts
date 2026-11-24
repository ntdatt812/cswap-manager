import * as vscode from 'vscode';

export interface PickButton {
  readonly iconId: string;
  readonly tooltip: string;
  /** Runs after the picker has closed. */
  readonly run: () => unknown;
}

export interface PickOptions<T extends vscode.QuickPickItem> {
  readonly title: string;
  readonly placeholder?: string;
  readonly matchOnDescription?: boolean;
  readonly matchOnDetail?: boolean;
  /** The item highlighted when the picker opens (e.g. the current value). */
  readonly isActive?: (item: T) => boolean;
  readonly buttons?: readonly PickButton[];
}

type ButtonWithAction = vscode.QuickInputButton & { readonly run: () => unknown };

/** `showQuickPick` plus a pre-selected item and title-bar buttons. Resolves to undefined when dismissed. */
export function pickOne<T extends vscode.QuickPickItem>(items: readonly T[], options: PickOptions<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<T>();
    picker.title = options.title;
    picker.placeholder = options.placeholder;
    picker.matchOnDescription = options.matchOnDescription ?? false;
    picker.matchOnDetail = options.matchOnDetail ?? false;
    picker.items = items;
    const active = options.isActive === undefined ? undefined : items.find(options.isActive);
    if (active !== undefined) {
      picker.activeItems = [active];
    }
    const buttons: ButtonWithAction[] = (options.buttons ?? []).map((button) => ({
      iconPath: new vscode.ThemeIcon(button.iconId),
      tooltip: button.tooltip,
      run: button.run,
    }));
    picker.buttons = buttons;
    let picked: T | undefined;
    let after: (() => unknown) | undefined;
    picker.onDidTriggerButton((button) => {
      after = buttons.find((candidate) => candidate === button)?.run;
      picker.hide();
    });
    picker.onDidAccept(() => {
      picked = picker.selectedItems[0] ?? picker.activeItems[0];
      picker.hide();
    });
    picker.onDidHide(() => {
      picker.dispose();
      resolve(picked);
      if (after !== undefined) {
        void Promise.resolve().then(after).catch(() => undefined);
      }
    });
    picker.show();
  });
}
