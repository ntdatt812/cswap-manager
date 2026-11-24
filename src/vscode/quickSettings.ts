import * as vscode from 'vscode';
import { SORT_ORDERS } from '../core/presentation/format';
import {
  LANGUAGE_SETTINGS,
  buildQuickSettingsRows,
  languageLabel,
  refreshChoices,
  refreshLabel,
  sortOrderLabel,
  statusBarModeLabel,
  type QuickSettingsValues,
  type SettingKey,
} from '../core/presentation/quickSettings';
import { STATUS_BAR_MODES } from '../core/presentation/statusBar';
import type { AutoSwitchController } from './autoSwitchController';
import type { ExtensionConfiguration, UserSettingKey } from './configuration';
import { t } from './presentation';
import { pickOne } from './quickPick';

export interface QuickSettingsDependencies {
  readonly configuration: ExtensionConfiguration;
  readonly autoSwitch: AutoSwitchController;
}

type RowItem = vscode.QuickPickItem & { readonly key?: SettingKey };
type ValueItem<T> = vscode.QuickPickItem & { readonly value: T };

function currentValues(deps: QuickSettingsDependencies): QuickSettingsValues {
  const { configuration } = deps;
  return {
    language: configuration.languageSetting(),
    confirmSwitch: configuration.confirmSwitch(),
    autoSwitchMode: configuration.autoSwitchMode(),
    autoSwitchStrategy: deps.autoSwitch.service.getState().rules?.strategy,
    statusBarMode: configuration.statusBarMode(),
    sortOrder: configuration.sortOrder(),
    refreshSeconds: configuration.refreshIntervalSeconds(),
  };
}

function rowItems(deps: QuickSettingsDependencies): RowItem[] {
  return buildQuickSettingsRows(currentValues(deps), t).map((row) =>
    row.separator === true
      ? { label: row.label, kind: vscode.QuickPickItemKind.Separator }
      : { key: row.key, label: `$(${row.iconId}) ${row.label}`, description: row.value },
  );
}

/**
 * The settings list. Toggling "Ask before switching" happens in place; every other row closes the
 * list and resolves to its key so a sub-picker can open.
 */
function pickRow(deps: QuickSettingsDependencies, focus: SettingKey | undefined): Promise<SettingKey | undefined> {
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<RowItem>();
    // Re-rendered after each change; titles follow the language setting.
    const render = (key: SettingKey | undefined) => {
      picker.title = t('Cswap Settings');
      picker.placeholder = t('Pick a setting to change it. Esc closes.');
      picker.items = rowItems(deps);
      const active = picker.items.find((item) => item.key !== undefined && item.key === key);
      if (active !== undefined) {
        picker.activeItems = [active];
      }
    };
    render(focus);
    let result: SettingKey | undefined;
    let open = true;
    if (deps.autoSwitch.service.getState().rules === undefined) {
      // Rules are only loaded once auto-switch runs; fetch them so the strategy row shows the real value.
      void deps.autoSwitch.service.reloadRules().then(() => {
        if (open && !picker.busy) {
          render(picker.activeItems[0]?.key ?? focus);
        }
      });
    }
    const toggleConfirm = async () => {
      picker.busy = true;
      try {
        await deps.configuration.setConfirmSwitch(!deps.configuration.confirmSwitch());
      } catch {
        showSaveFailed();
      } finally {
        picker.busy = false;
      }
      render('confirmSwitch');
    };
    picker.onDidAccept(() => {
      const key = picker.activeItems[0]?.key;
      if (key === undefined || picker.busy) {
        return;
      }
      if (key === 'confirmSwitch') {
        void toggleConfirm();
        return;
      }
      result = key;
      picker.hide();
    });
    picker.onDidHide(() => {
      open = false;
      picker.dispose();
      resolve(result);
    });
    picker.show();
  });
}

async function chooseValue<T>(title: string, options: ReadonlyArray<{ value: T; label: string; detail?: string }>, current: T): Promise<T | undefined> {
  const items: Array<ValueItem<T>> = options.map((option) => ({
    label: option.label,
    value: option.value,
    ...(option.value === current ? { description: t('current') } : {}),
    ...(option.detail === undefined ? {} : { detail: option.detail }),
  }));
  const picked = await pickOne(items, { title, isActive: (item) => item.value === current });
  return picked?.value;
}

async function writeUserSetting(deps: QuickSettingsDependencies, key: UserSettingKey, value: unknown): Promise<void> {
  if (await deps.configuration.setUserSetting(key, value)) {
    void vscode.window.showWarningMessage(t('This workspace overrides that setting, so this window keeps the workspace value.'));
  }
}

/**
 * Opens the sub-picker for a row. Returns false when the settings list should not reopen: the row
 * hands over to another menu, or the sub-picker was dismissed (Esc or focus moved elsewhere).
 */
async function editRow(deps: QuickSettingsDependencies, key: SettingKey): Promise<boolean> {
  const { configuration } = deps;
  switch (key) {
    case 'language': {
      const current = configuration.languageSetting();
      const value = await chooseValue(
        t('Language'),
        LANGUAGE_SETTINGS.map((language) => ({ value: language, label: languageLabel(language, t) })),
        current,
      );
      if (value !== undefined && value !== current) {
        await writeUserSetting(deps, 'language', value);
      }
      return value !== undefined;
    }
    case 'confirmSwitch':
      await configuration.setConfirmSwitch(!configuration.confirmSwitch());
      return true;
    case 'autoSwitch':
      await deps.autoSwitch.openMenu();
      return false;
    case 'autoStrategy':
      return deps.autoSwitch.chooseStrategy();
    case 'statusBar': {
      const current = configuration.statusBarMode();
      const value = await chooseValue(
        t('Status bar'),
        STATUS_BAR_MODES.map((mode) => ({ value: mode, label: statusBarModeLabel(mode, t) })),
        current,
      );
      if (value !== undefined && value !== current) {
        await writeUserSetting(deps, 'statusBar.mode', value);
      }
      return value !== undefined;
    }
    case 'sortOrder': {
      const current = configuration.sortOrder();
      const value = await chooseValue(
        t('Account order'),
        SORT_ORDERS.map((order) => ({ value: order, label: sortOrderLabel(order, t) })),
        current,
      );
      if (value !== undefined && value !== current) {
        await writeUserSetting(deps, 'sidebar.sortOrder', value);
      }
      return value !== undefined;
    }
    case 'refresh': {
      const current = configuration.refreshIntervalSeconds();
      const value = await chooseValue(
        t('Auto refresh'),
        refreshChoices(current).map((seconds) => ({ value: seconds, label: refreshLabel(seconds, t) })),
        current,
      );
      if (value !== undefined && value !== current) {
        await writeUserSetting(deps, 'refreshIntervalSeconds', value);
      }
      return value !== undefined;
    }
    case 'allSettings':
      await vscode.commands.executeCommand('cswapManager.openSettings');
      return false;
  }
}

/** **Cswap: Quick Settings…** — the common settings in the extension's own language. */
export async function openQuickSettings(deps: QuickSettingsDependencies, focus?: SettingKey): Promise<void> {
  let active = focus;
  for (;;) {
    const key = await pickRow(deps, active);
    if (key === undefined) {
      return;
    }
    active = key;
    try {
      if (!(await editRow(deps, key))) {
        return;
      }
    } catch {
      showSaveFailed();
    }
  }
}

function showSaveFailed(): void {
  void vscode.window.showWarningMessage(t('The setting could not be saved. Check your VS Code user settings file.'));
}
