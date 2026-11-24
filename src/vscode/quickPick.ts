import * as vscode from 'vscode';

/** Returned when the user pressed the title-bar ← Back button. */
export const BACK = Symbol('back');
export type Back = typeof BACK;

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
  /** Called as the highlighted item changes (e.g. to preview it). */
  readonly onActive?: (item: T | undefined) => void;
  /** Shows VS Code's ← Back button; pressing it resolves to {@link BACK}. */
  readonly back?: boolean;
}

type ButtonWithAction = vscode.QuickInputButton & { readonly run: () => unknown };

/** `showQuickPick` plus a pre-selected item, title-bar buttons and an optional Back button. */
export function pickOne<T extends vscode.QuickPickItem>(items: readonly T[], options: PickOptions<T> & { readonly back: boolean }): Promise<T | Back | undefined>;
export function pickOne<T extends vscode.QuickPickItem>(items: readonly T[], options: PickOptions<T> & { readonly back?: false }): Promise<T | undefined>;
export function pickOne<T extends vscode.QuickPickItem>(items: readonly T[], options: PickOptions<T>): Promise<T | Back | undefined> {
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
    picker.buttons = [...(options.back === true ? [vscode.QuickInputButtons.Back] : []), ...buttons];
    if (options.onActive !== undefined) {
      const onActive = options.onActive;
      picker.onDidChangeActive((current) => onActive(current[0]));
    }
    let picked: T | Back | undefined;
    let after: (() => unknown) | undefined;
    picker.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        picked = BACK;
      } else {
        after = buttons.find((candidate) => candidate === button)?.run;
      }
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

export interface PickManyOptions<T extends vscode.QuickPickItem> {
  readonly title: string;
  readonly placeholder?: string;
  readonly isSelected: (item: T) => boolean;
  /** Called on every tick/untick (e.g. to preview the selection). */
  readonly onChange?: (selected: readonly T[]) => void;
  /** Shows VS Code's ← Back button; pressing it resolves to {@link BACK} without saving. */
  readonly back?: boolean;
}

/** A checkbox list. Resolves to the ticked items on Enter/OK, {@link BACK}, or undefined when dismissed. */
export function pickMany<T extends vscode.QuickPickItem>(items: readonly T[], options: PickManyOptions<T>): Promise<T[] | Back | undefined> {
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<T>();
    picker.title = options.title;
    picker.placeholder = options.placeholder;
    picker.canSelectMany = true;
    picker.items = items;
    picker.selectedItems = items.filter(options.isSelected);
    if (options.back === true) {
      picker.buttons = [vscode.QuickInputButtons.Back];
    }
    if (options.onChange !== undefined) {
      const onChange = options.onChange;
      picker.onDidChangeSelection((selected) => onChange(selected));
    }
    let picked: T[] | Back | undefined;
    picker.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        picked = BACK;
        picker.hide();
      }
    });
    picker.onDidAccept(() => {
      picked = [...picker.selectedItems];
      picker.hide();
    });
    picker.onDidHide(() => {
      picker.dispose();
      resolve(picked);
    });
    picker.show();
  });
}

export interface AskOptions {
  readonly title: string;
  readonly prompt: string;
  readonly value: string;
  readonly validate: (text: string) => string | undefined;
  readonly step?: number;
  readonly totalSteps?: number;
}

/** An input box with VS Code's ← Back button. Resolves to the text, {@link BACK}, or undefined when dismissed. */
export function askWithBack(options: AskOptions): Promise<string | Back | undefined> {
  return new Promise((resolve) => {
    const input = vscode.window.createInputBox();
    input.title = options.title;
    input.prompt = options.prompt;
    input.value = options.value;
    input.step = options.step;
    input.totalSteps = options.totalSteps;
    input.buttons = [vscode.QuickInputButtons.Back];
    let result: string | Back | undefined;
    input.onDidChangeValue((text) => {
      input.validationMessage = options.validate(text);
    });
    input.onDidTriggerButton(() => {
      result = BACK;
      input.hide();
    });
    input.onDidAccept(() => {
      const message = options.validate(input.value);
      if (message !== undefined) {
        input.validationMessage = message;
        return;
      }
      result = input.value;
      input.hide();
    });
    input.onDidHide(() => {
      input.dispose();
      resolve(result);
    });
    input.show();
  });
}
