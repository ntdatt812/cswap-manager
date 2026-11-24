import * as os from 'node:os';
import * as vscode from 'vscode';
import { SORT_ORDERS } from '../core/presentation/format';
import {
  LANGUAGE_SETTINGS,
  STATUS_BAR_LOOKS,
  STATUS_BAR_LOOK_PARTS,
  barStyleLabel,
  barStyleSample,
  buildQuickSettingsRows,
  languageLabel,
  matchingLook,
  refreshChoices,
  refreshLabel,
  sortOrderLabel,
  statusBarButtonLabel,
  statusBarColorsLabel,
  statusBarLookLabel,
  statusBarPartLabel,
  timeoutChoices,
  type QuickSettingsValues,
  type SettingKey,
  type StatusBarLook,
} from '../core/presentation/quickSettings';
import { BAR_STYLES } from '../core/presentation/format';
import {
  DEFAULT_STATUS_BAR_PARTS,
  STATUS_BAR_BUTTONS,
  STATUS_BAR_COLORS,
  STATUS_BAR_PARTS,
  type StatusBarButton,
  type StatusBarPart,
} from '../core/presentation/statusBar';
import type { AutoSwitchController, MenuResult } from './autoSwitchController';
import { neutralizeLinks, redactText } from '../core/security/redact';
import { SettingNotLoadedError, type ExtensionConfiguration, type UserSettingKey } from './configuration';
import { t } from './presentation';
import { askWithBack, BACK, pickMany, pickOne, type Back } from './quickPick';
import { statusBarButtonIcon, type StatusBarController } from './statusBarController';

export interface QuickSettingsDependencies {
  readonly configuration: ExtensionConfiguration;
  readonly autoSwitch: AutoSwitchController;
  readonly statusBar: StatusBarController;
}

/**
 * Every screen below the settings list ends in one of these: go back to the list (← Back, or a
 * change was made), or close everything (Esc, focus moved elsewhere, or other UI took over).
 */
type Outcome = 'list' | 'close';

const fromMenu = (result: MenuResult): Outcome => (result === 'closed' ? 'close' : 'list');

type RowItem = vscode.QuickPickItem & { readonly key?: SettingKey };
type ValueItem<T> = vscode.QuickPickItem & { readonly value: T };

function displayPath(path: string): string {
  const home = os.homedir();
  return home !== '' && path.toLowerCase().startsWith(home.toLowerCase()) ? `~${path.slice(home.length)}` : path;
}

function currentValues(deps: QuickSettingsDependencies): QuickSettingsValues {
  const { configuration } = deps;
  return {
    language: configuration.languageSetting(),
    confirmSwitch: configuration.confirmSwitch(),
    autoSwitchMode: configuration.autoSwitchMode(),
    autoSwitchStrategy: deps.autoSwitch.service.getState().rules?.strategy,
    autoSwitchRules: deps.autoSwitch.rulesText(),
    statusBarParts: configuration.statusBarParts(),
    statusBarButtons: configuration.statusBarButtons(),
    barStyle: configuration.barStyle(),
    thresholds: configuration.thresholds(),
    sortOrder: configuration.sortOrder(),
    refreshSeconds: configuration.refreshIntervalSeconds(),
    cliPath: displayPath(configuration.cliPath()),
    timeoutSeconds: Math.round(configuration.cliRunSettings().timeoutMs / 1000),
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
 * list and resolves to its key so its own screen can open.
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
      // Rules are only loaded once auto-switch runs; fetch them so the auto-switch rows show real values.
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
      } catch (error) {
        showSaveFailed(error);
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

/** A one-of-many screen with the current value highlighted and a ← Back button. */
async function chooseValue<T>(
  title: string,
  options: ReadonlyArray<{ value: T; label: string; detail?: string; description?: string }>,
  current: T,
  onActive?: (value: T | undefined) => void,
): Promise<T | Back | undefined> {
  const items: Array<ValueItem<T>> = options.map((option) => {
    const description = [option.description, option.value === current ? t('current') : undefined].filter((part) => part !== undefined).join(' · ');
    return {
      label: option.label,
      value: option.value,
      ...(description === '' ? {} : { description }),
      ...(option.detail === undefined ? {} : { detail: option.detail }),
    };
  });
  const picked = await pickOne(items, {
    title,
    back: true,
    isActive: (item) => item.value === current,
    ...(onActive === undefined ? {} : { onActive: (item: ValueItem<T> | undefined) => onActive(item?.value) }),
  });
  return picked === BACK || picked === undefined ? picked : picked.value;
}

async function writeUserSetting(deps: QuickSettingsDependencies, key: UserSettingKey, value: unknown): Promise<void> {
  if (await deps.configuration.setUserSetting(key, value)) {
    void vscode.window.showWarningMessage(t('This workspace overrides that setting, so this window keeps the workspace value.'));
  }
}

/** Shows a one-of-many screen for a user setting and saves the choice. */
async function editValue<T>(
  deps: QuickSettingsDependencies,
  key: UserSettingKey,
  title: string,
  options: ReadonlyArray<{ value: T; label: string; description?: string }>,
  current: T,
): Promise<Outcome> {
  const value = await chooseValue(title, options, current);
  if (value === undefined) {
    return 'close';
  }
  if (value !== BACK && value !== current) {
    await writeUserSetting(deps, key, value);
  }
  return 'list';
}

// ---- Status bar screen --------------------------------------------------------------------------

/** Saves what the account item shows; nothing ticked hides it. */
async function saveParts(deps: QuickSettingsDependencies, parts: readonly StatusBarPart[]): Promise<void> {
  if (parts.length === 0) {
    await writeUserSetting(deps, 'statusBar.mode', 'hidden');
    return;
  }
  // Parts first, then the mode, so the item never flashes an old custom selection.
  await writeUserSetting(deps, 'statusBar.parts', STATUS_BAR_PARTS.filter((part) => parts.includes(part)));
  await writeUserSetting(deps, 'statusBar.mode', 'custom');
}

const PART_SAMPLES: Record<StatusBarPart, (deps: QuickSettingsDependencies) => string> = {
  icon: () => '$(account) $(warning) $(error)',
  slot: () => '#1',
  name: () => t('alias or email'),
  plan: () => 'Max · Ultra',
  bar: (deps) => barStyleSample(deps.configuration.barStyle()),
  usage: () => '7d 40%',
  reset: () => '↻ 2d 3h',
};

async function chooseParts(deps: QuickSettingsDependencies): Promise<Outcome> {
  const { statusBar, configuration } = deps;
  const current = configuration.statusBarParts();
  type PartItem = vscode.QuickPickItem & { readonly part: StatusBarPart };
  const items: PartItem[] = STATUS_BAR_PARTS.map((part) => ({ label: statusBarPartLabel(part, t), description: PART_SAMPLES[part](deps), part }));
  const picked = await pickMany(items, {
    title: t('Status bar: what to show'),
    placeholder: t('Tick what to show; the status bar previews it. Enter saves, Esc cancels.'),
    back: true,
    isSelected: (item) => current.includes(item.part),
    onChange: (selected) => statusBar.preview({ parts: selected.map((item) => item.part) }),
  });
  statusBar.preview(undefined);
  if (picked === undefined) {
    return 'close';
  }
  if (picked !== BACK) {
    await saveParts(
      deps,
      picked.map((item) => item.part),
    );
  }
  return 'list';
}

/** One style for every progress bar: sidebar, switch picker and status bar. */
async function chooseBarStyle(deps: QuickSettingsDependencies): Promise<Outcome> {
  const { statusBar, configuration } = deps;
  const current = configuration.barStyle();
  const value = await chooseValue(
    t('Progress bar style'),
    BAR_STYLES.map((style) => ({ value: style, label: barStyleLabel(style, t), description: barStyleSample(style) })),
    current,
    // The status bar previews the style when it shows a bar; the samples show it either way.
    (style) => statusBar.preview(style === undefined ? undefined : { barStyle: style }),
  );
  statusBar.preview(undefined);
  if (value === undefined) {
    return 'close';
  }
  if (value !== BACK && value !== current) {
    await writeUserSetting(deps, 'display.barStyle', value);
  }
  return 'list';
}

async function chooseColors(deps: QuickSettingsDependencies): Promise<Outcome> {
  const { statusBar, configuration } = deps;
  const current = configuration.statusBarColors();
  const value = await chooseValue(
    t('Warning colours'),
    STATUS_BAR_COLORS.map((colors) => ({ value: colors, label: statusBarColorsLabel(colors, t) })),
    current,
    (colors) => statusBar.preview(colors === undefined ? undefined : { colors }),
  );
  statusBar.preview(undefined);
  if (value === undefined) {
    return 'close';
  }
  if (value !== BACK && value !== current) {
    await writeUserSetting(deps, 'statusBar.colors', value);
  }
  return 'list';
}

async function chooseButtons(deps: QuickSettingsDependencies): Promise<Outcome> {
  const { statusBar, configuration } = deps;
  const current = configuration.statusBarButtons();
  type ButtonItem = vscode.QuickPickItem & { readonly button: StatusBarButton };
  const items: ButtonItem[] = STATUS_BAR_BUTTONS.map((button) => ({
    label: `$(${statusBarButtonIcon(button)}) ${statusBarButtonLabel(button, t)}`,
    button,
  }));
  const picked = await pickMany(items, {
    title: t('Status bar buttons'),
    placeholder: t('Tick the buttons to show next to the account; the status bar previews them. Enter saves, Esc cancels.'),
    back: true,
    isSelected: (item) => current.includes(item.button),
    onChange: (selected) => statusBar.preview({ buttons: selected.map((item) => item.button) }),
  });
  statusBar.preview(undefined);
  if (picked === undefined) {
    return 'close';
  }
  if (picked !== BACK) {
    await writeUserSetting(
      deps,
      'statusBar.buttons',
      picked.map((item) => item.button),
    );
  }
  return 'list';
}

type PageAction = 'parts' | 'colors' | 'buttons' | 'visibility';
type PageItem = vscode.QuickPickItem & { readonly look?: StatusBarLook; readonly action?: PageAction };

/**
 * The status bar screen: ready-made looks drawn with the user's own data (highlighting one previews
 * it on the real status bar), then the individual options. Each option's ← Back returns here.
 */
async function openStatusBarPage(deps: QuickSettingsDependencies): Promise<Outcome> {
  const { statusBar, configuration } = deps;
  let focus: StatusBarLook | PageAction | undefined;
  for (;;) {
    const parts = configuration.statusBarParts();
    const buttons = configuration.statusBarButtons();
    const currentLook = parts.length === 0 ? undefined : matchingLook(parts);
    const items: PageItem[] = [
      { label: t('Ready-made looks'), kind: vscode.QuickPickItemKind.Separator },
      ...STATUS_BAR_LOOKS.map((look) => ({
        label: `${statusBarLookLabel(look, t)}${look === currentLook ? ' $(check)' : ''}`,
        description: statusBar.sampleText(STATUS_BAR_LOOK_PARTS[look]) ?? '',
        look,
      })),
      { label: t('Customize'), kind: vscode.QuickPickItemKind.Separator },
      {
        label: `$(checklist) ${t('Pick what to show…')}`,
        description: parts.length === 0 ? t('Hidden') : parts.map((part) => statusBarPartLabel(part, t)).join(', '),
        action: 'parts',
      },
      { label: `$(symbol-color) ${t('Warning colours')}`, description: statusBarColorsLabel(configuration.statusBarColors(), t), action: 'colors' },
      {
        label: `$(layout-statusbar) ${t('Buttons')}`,
        description: buttons.length === 0 ? t('none') : buttons.map((button) => `$(${statusBarButtonIcon(button)})`).join(' '),
        action: 'buttons',
      },
      parts.length === 0
        ? { label: `$(eye) ${t('Show the account on the status bar')}`, action: 'visibility' }
        : { label: `$(eye-closed) ${t('Hide the account from the status bar')}`, action: 'visibility' },
    ];
    const picked = await pickOne(items, {
      title: t('Status bar'),
      placeholder: t('Highlight a look to preview it on the status bar; Enter keeps it.'),
      back: true,
      // With no ready-made look in use, start on "Pick what to show…": highlighting a look would preview it.
      isActive: (item) =>
        focus !== undefined
          ? item.look === focus || item.action === focus
          : currentLook !== undefined
            ? item.look === currentLook
            : item.action === 'parts',
      onActive: (item) => statusBar.preview(item?.look === undefined ? undefined : { parts: STATUS_BAR_LOOK_PARTS[item.look] }),
    });
    statusBar.preview(undefined);
    if (picked === undefined) {
      return 'close';
    }
    if (picked === BACK) {
      return 'list';
    }
    focus = picked.look ?? picked.action;
    let outcome: Outcome = 'list';
    if (picked.look !== undefined) {
      await saveParts(deps, STATUS_BAR_LOOK_PARTS[picked.look]);
    } else if (picked.action === 'parts') {
      outcome = await chooseParts(deps);
    } else if (picked.action === 'colors') {
      outcome = await chooseColors(deps);
    } else if (picked.action === 'buttons') {
      outcome = await chooseButtons(deps);
    } else if (picked.action === 'visibility') {
      if (parts.length > 0) {
        // Remember the layout (even an old preset mode) so "Show" brings back exactly this.
        await writeUserSetting(deps, 'statusBar.parts', parts);
        await saveParts(deps, []);
      } else {
        const custom = configuration.customStatusBarParts();
        await saveParts(deps, custom.length > 0 ? custom : DEFAULT_STATUS_BAR_PARTS);
      }
    }
    if (outcome === 'close') {
      return 'close';
    }
  }
}

// ---- Other screens ------------------------------------------------------------------------------

async function editThresholds(deps: QuickSettingsDependencies, typedWarning?: string): Promise<Outcome> {
  const current = deps.configuration.thresholds();
  const parse = (text: string) => Number(text.trim().replace('%', ''));
  const inRange = (text: string, min: number) => {
    const value = parse(text);
    return text.trim() !== '' && Number.isFinite(value) && value >= min && value <= 100;
  };
  const warning = await askWithBack({
    title: t('Usage colours'),
    step: 1,
    totalSteps: 2,
    prompt: t('Usage % at which accounts turn yellow. Display only; cswap is not changed.'),
    value: typedWarning ?? String(current.warning),
    validate: (text) => (inRange(text, 0) ? undefined : t('Enter a value in {0}.', '0–100')),
  });
  if (warning === undefined) {
    return 'close';
  }
  if (warning === BACK) {
    return 'list';
  }
  const warningValue = parse(warning);
  const critical = await askWithBack({
    title: t('Usage colours'),
    step: 2,
    totalSteps: 2,
    prompt: t('Usage % at which accounts turn red. Display only; cswap is not changed.'),
    value: String(Math.max(current.critical, warningValue)),
    validate: (text) => (inRange(text, warningValue) ? undefined : t('Enter a value in {0}.', `${warningValue}–100`)),
  });
  if (critical === undefined) {
    return 'close';
  }
  if (critical === BACK) {
    // One step back is the first box; going back from there returns to the list.
    return editThresholds(deps, warning);
  }
  await writeUserSetting(deps, 'display.warningThreshold', warningValue);
  await writeUserSetting(deps, 'display.criticalThreshold', parse(critical));
  return 'list';
}

/** Opens a row's own screen. */
async function editRow(deps: QuickSettingsDependencies, key: SettingKey): Promise<Outcome> {
  const { configuration } = deps;
  switch (key) {
    case 'language':
      return editValue(
        deps,
        'language',
        t('Language'),
        LANGUAGE_SETTINGS.map((language) => ({ value: language, label: languageLabel(language, t) })),
        configuration.languageSetting(),
      );
    case 'confirmSwitch':
      await configuration.setConfirmSwitch(!configuration.confirmSwitch());
      return 'list';
    case 'refresh': {
      const current = configuration.refreshIntervalSeconds();
      return editValue(
        deps,
        'refreshIntervalSeconds',
        t('Auto refresh'),
        refreshChoices(current).map((seconds) => ({ value: seconds, label: refreshLabel(seconds, t) })),
        current,
      );
    }
    case 'autoSwitch':
      return fromMenu(await deps.autoSwitch.openMenu({ back: true }));
    case 'autoStrategy':
      return fromMenu(await deps.autoSwitch.chooseStrategy({ back: true }));
    case 'autoRules':
      return fromMenu(await deps.autoSwitch.editRules({ back: true }));
    case 'statusBar':
      return openStatusBarPage(deps);
    case 'barStyle':
      return chooseBarStyle(deps);
    case 'thresholds':
      return editThresholds(deps);
    case 'sortOrder':
      return editValue(
        deps,
        'sidebar.sortOrder',
        t('Account order'),
        SORT_ORDERS.map((order) => ({ value: order, label: sortOrderLabel(order, t) })),
        configuration.sortOrder(),
      );
    case 'cliPath':
      // Machine-scoped and security-relevant: edited on VS Code's own Settings page, never from here.
      await vscode.commands.executeCommand('workbench.action.openSettings', 'cswapManager.cliPath');
      return 'close';
    case 'timeout': {
      const current = Math.round(configuration.cliRunSettings().timeoutMs / 1000);
      return editValue(
        deps,
        'commandTimeoutSeconds',
        t('Command time limit'),
        timeoutChoices(current).map((seconds) => ({ value: seconds, label: t('{0} s', seconds) })),
        current,
      );
    }
    case 'allSettings':
      await vscode.commands.executeCommand('cswapManager.openSettings');
      return 'close';
  }
}

/** **Cswap: Quick Settings…** — the common settings in the extension's own language. */
export async function openQuickSettings(deps: QuickSettingsDependencies, focus?: SettingKey): Promise<void> {
  if (deps.configuration.unregisteredSettings().length > 0) {
    // Say it up front instead of failing on the first save.
    void offerReload();
  }
  let active = focus;
  for (;;) {
    const key = await pickRow(deps, active);
    if (key === undefined) {
      return;
    }
    active = key;
    try {
      if ((await editRow(deps, key)) === 'close') {
        return;
      }
    } catch (error) {
      deps.statusBar.preview(undefined);
      showSaveFailed(error);
    }
  }
}

async function offerReload(): Promise<void> {
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
function showSaveFailed(error: unknown): void {
  if (error instanceof SettingNotLoadedError) {
    void offerReload();
    return;
  }
  const reason = error instanceof Error && error.message !== '' ? redactText(error.message, { homeDir: os.homedir(), maxLength: 300 }) : t('unknown');
  void vscode.window.showWarningMessage(neutralizeLinks(t('The setting could not be saved: {0}', reason)));
}
