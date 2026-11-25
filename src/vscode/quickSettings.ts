import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import type { CachedExecutableResolver } from '../core/cli/executableResolver';
import { SORT_ORDERS } from '../core/presentation/format';
import {
  LANGUAGE_SETTINGS,
  STATUS_BAR_LOOKS,
  STATUS_BAR_LOOK_PARTS,
  barStyleLabel,
  barStylePrecision,
  barStyleSample,
  buildQuickSettingsRows,
  cswapVersionText,
  languageLabel,
  matchingLook,
  refreshChoices,
  refreshLabel,
  sortOrderLabel,
  statusBarButtonLabel,
  statusBarColorsLabel,
  statusBarLookLabel,
  statusBarPartLabel,
  shareHistoryOn,
  timeoutChoices,
  tokenUsageLevel,
  usageAlertChoices,
  usageAlertLabel,
  type QuickSettingsPage,
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
import type { ExtensionConfiguration, UserSettingKey } from './configuration';
import type { AccountsSnapshot } from '../core/model/types';
import { slotLabel } from '../core/presentation/accountTree';
import { t } from './presentation';
import type { ProjectAccounts } from './projectAccounts';
import { askWithBack, BACK, pickMany, pickOne, type Back } from './quickPick';
import { offerReload, showSaveFailed } from './settingErrors';
import { statusBarButtonIcon, type StatusBarController } from './statusBarController';

export interface QuickSettingsDependencies {
  readonly configuration: ExtensionConfiguration;
  readonly autoSwitch: AutoSwitchController;
  readonly statusBar: StatusBarController;
  /** For names of mapped accounts. */
  readonly refreshService?: { getState(): { readonly snapshot?: AccountsSnapshot } };
  /** Account mapped to the open project folder (`cswap map`). */
  readonly projectAccounts?: Pick<ProjectAccounts, 'currentMapping' | 'assign' | 'load'>;
  /** Where cswap is found now, for the cswap path screen. */
  readonly resolver?: Pick<CachedExecutableResolver, 'resolve'>;
  /** Known cswap version / newer release, for the Advanced row. */
  readonly updateCheck?: { getState(): { readonly current?: { readonly text: string }; readonly latest?: { readonly text: string } } };
}

/**
 * Every screen below the settings list ends in one of these: go back to the list (← Back, or a
 * change was made), or close everything (Esc, focus moved elsewhere, or other UI took over).
 */
type Outcome = 'list' | 'close';

/** The open project's account; undefined when no folder is open. Names the folder in a multi-root workspace. */
function projectAccountText(deps: QuickSettingsDependencies): string | undefined {
  const mapping = deps.projectAccounts?.currentMapping();
  if (mapping === undefined) {
    return undefined;
  }
  let text: string;
  if (mapping.unknown === true) {
    text = t('not read yet');
  } else if (mapping.slot === undefined) {
    text = t('not assigned');
  } else {
    const account = deps.refreshService?.getState().snapshot?.accounts.find((candidate) => candidate.slot === mapping.slot);
    text = account === undefined ? `#${mapping.slot}` : slotLabel(account, t);
  }
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? `${text} (${mapping.folderName})` : text;
}

const fromMenu = (result: MenuResult): Outcome => (result === 'closed' ? 'close' : 'list');

type RowItem = vscode.QuickPickItem & { readonly key?: SettingKey };
type ValueItem<T> = vscode.QuickPickItem & { readonly value: T };

function displayPath(path: string): string {
  const home = os.homedir();
  return home !== '' && path.toLowerCase().startsWith(home.toLowerCase()) ? `~${path.slice(home.length)}` : path;
}

function currentValues(deps: QuickSettingsDependencies): QuickSettingsValues {
  const { configuration } = deps;
  const rules = deps.autoSwitch.service.getState().rules;
  const projectAccount = projectAccountText(deps);
  const update = deps.updateCheck?.getState();
  return {
    language: configuration.languageSetting(),
    confirmSwitch: configuration.confirmSwitch(),
    notifications: configuration.notificationSettings(),
    autoSwitchMode: configuration.autoSwitchMode(),
    autoSwitchStrategy: rules?.strategy,
    autoSwitchModel: rules === undefined ? undefined : (rules.model ?? null),
    autoSwitchRules: deps.autoSwitch.rulesText(),
    shareHistory: shareHistoryOn(rules),
    tokenUsage: tokenUsageLevel(rules),
    statusBarParts: configuration.statusBarParts(),
    statusBarButtons: configuration.statusBarButtons(),
    barStyle: configuration.barStyle(),
    thresholds: configuration.thresholds(),
    sortOrder: configuration.sortOrder(),
    refreshSeconds: configuration.refreshIntervalSeconds(),
    cliPath: displayPath(configuration.cliPath()),
    timeoutSeconds: Math.round(configuration.cliRunSettings().timeoutMs / 1000),
    ...(projectAccount === undefined ? {} : { projectAccount }),
    ...(update?.current === undefined ? {} : { cswapVersion: update.current.text }),
    ...(update?.latest === undefined ? {} : { cswapLatest: update.latest.text }),
    cswapUpdates: { daily: configuration.checkCswapUpdates(), automatic: configuration.autoUpdateCswap() },
  };
}

function rowItems(deps: QuickSettingsDependencies, page: QuickSettingsPage): RowItem[] {
  return buildQuickSettingsRows(currentValues(deps), t, page).map((row) =>
    row.separator === true
      ? { label: row.label, kind: vscode.QuickPickItemKind.Separator }
      : { key: row.key, label: `$(${row.iconId}) ${row.label}`, description: row.value },
  );
}

/** On/off rows that switch in place, without a screen of their own. */
const TOGGLES = {
  confirmSwitch: (deps: QuickSettingsDependencies) => deps.configuration.setConfirmSwitch(!deps.configuration.confirmSwitch()),
} satisfies Partial<Record<SettingKey, (deps: QuickSettingsDependencies) => Promise<void>>>;
type ToggleKey = keyof typeof TOGGLES;
/** Rows that open a screen of their own. */
type ScreenKey = Exclude<SettingKey, ToggleKey | 'advanced'>;

function isToggle(key: SettingKey): key is ToggleKey {
  return Object.hasOwn(TOGGLES, key);
}

/**
 * One page of the settings list. On/off rows switch in place; every other row closes the list and
 * resolves to its key so its own screen can open. The "Advanced…" page has a ← Back button.
 */
function pickRow(deps: QuickSettingsDependencies, focus: SettingKey | undefined, page: QuickSettingsPage): Promise<ScreenKey | 'advanced' | typeof BACK | undefined> {
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<RowItem>();
    if (page === 'advanced') {
      picker.buttons = [vscode.QuickInputButtons.Back];
      picker.onDidTriggerButton(() => {
        result = BACK;
        picker.hide();
      });
    }
    // Re-rendered after each change; titles follow the language setting.
    const render = (key: SettingKey | undefined) => {
      picker.title = page === 'advanced' ? t('Cswap Settings › Advanced') : t('Cswap Settings');
      picker.placeholder = t('Pick a setting to change it. Esc closes.');
      picker.items = rowItems(deps, page);
      const active = picker.items.find((item) => item.key !== undefined && item.key === key);
      if (active !== undefined) {
        picker.activeItems = [active];
      }
    };
    let result: ScreenKey | 'advanced' | typeof BACK | undefined;
    let open = true;
    render(focus);
    // Data read on demand: auto-switch rules (loaded once auto-switch runs) and the project mapping.
    const loads: Array<Promise<unknown>> = [];
    if (deps.autoSwitch.service.getState().rules === undefined) {
      loads.push(deps.autoSwitch.service.reloadRules());
    }
    if (deps.projectAccounts?.currentMapping()?.unknown === true) {
      loads.push(deps.projectAccounts.load());
    }
    for (const load of loads) {
      void load.then(() => {
        if (open && !picker.busy) {
          render(picker.activeItems[0]?.key ?? focus);
        }
      });
    }
    const toggle = async (key: ToggleKey) => {
      picker.busy = true;
      try {
        await TOGGLES[key](deps);
      } catch (error) {
        showSaveFailed(error);
      } finally {
        picker.busy = false;
      }
      render(key);
    };
    picker.onDidAccept(() => {
      const key = picker.activeItems[0]?.key;
      if (key === undefined || picker.busy) {
        return;
      }
      if (isToggle(key)) {
        void toggle(key);
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

/** Why a typed or picked path cannot be the cswap program, or undefined when it can. */
function cliPathProblem(path: string): string | undefined {
  if (!nodePath.isAbsolute(path)) {
    return t('Enter the full path to the cswap program.');
  }
  if (process.platform === 'win32' && !/\.(exe|com)$/i.test(path)) {
    return t('Choose cswap.exe itself: .cmd and .bat launchers would need a shell, which the extension does not use.');
  }
  try {
    return fs.statSync(path).isFile() ? undefined : t('No file at that path.');
  } catch {
    return t('No file at that path.');
  }
}

/**
 * The cswap path, in the extension's own language: find it automatically, pick the program, or type
 * its path. It is saved in the user settings only (workspace values are never read), and the
 * resolver still refuses `.cmd`/`.bat` launchers and anything that is not an existing file.
 */
async function chooseCliPath(deps: QuickSettingsDependencies): Promise<Outcome> {
  const { configuration } = deps;
  const current = configuration.cliPath();
  const resolution = await deps.resolver?.resolve();
  const found = current === '' && resolution?.ok === true ? displayPath(resolution.path) : undefined;
  type Choice = 'auto' | 'browse' | 'type' | 'settings';
  const choice = await chooseValue<Choice>(
    t('cswap path'),
    [
      { value: 'auto', label: `$(search) ${t('Find cswap automatically')}`, detail: found === undefined ? t('Looks in PATH and ~/.local/bin.') : t('Found: {0}', found) },
      { value: 'browse', label: `$(folder-opened) ${t('Choose the cswap program…')}` },
      { value: 'type', label: `$(edit) ${t('Enter the path…')}`, ...(current === '' ? {} : { detail: displayPath(current) }) },
      { value: 'settings', label: `$(settings-gear) ${t('Open in VS Code Settings')}` },
    ],
    current === '' ? 'auto' : 'type',
  );
  if (choice === undefined) {
    return 'close';
  }
  if (choice === BACK) {
    return 'list';
  }
  let path: string | undefined;
  switch (choice) {
    case 'settings':
      await vscode.commands.executeCommand('workbench.action.openSettings', 'cswapManager.cliPath');
      return 'close';
    case 'auto':
      path = undefined;
      break;
    case 'browse': {
      const picked = await vscode.window.showOpenDialog({
        title: t('Choose the cswap program'),
        canSelectMany: false,
        openLabel: t('Use This Program'),
        defaultUri: vscode.Uri.file(nodePath.join(os.homedir(), '.local', 'bin')),
        ...(process.platform === 'win32' ? { filters: { cswap: ['exe', 'com'] } } : {}),
      });
      const file = picked?.[0];
      if (file === undefined) {
        return 'list';
      }
      const problem = cliPathProblem(file.fsPath);
      if (problem !== undefined) {
        void vscode.window.showErrorMessage(problem);
        return 'list';
      }
      path = file.fsPath;
      break;
    }
    case 'type': {
      const typed = await askWithBack({
        title: t('cswap path'),
        prompt: t('Full path to the cswap program (cswap.exe on Windows).'),
        value: current,
        validate: (text) => cliPathProblem(text.trim()),
      });
      if (typed === undefined) {
        return 'close';
      }
      if (typed === BACK) {
        return 'list';
      }
      path = typed.trim();
      break;
    }
  }
  if (path !== (current === '' ? undefined : current)) {
    try {
      // The configuration listener re-resolves cswap and refreshes the accounts.
      await configuration.setCliPath(path);
    } catch (error) {
      showSaveFailed(error);
    }
  }
  return 'list';
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
  name: () => t('display name or email'),
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
    BAR_STYLES.map((style) => ({ value: style, label: barStyleLabel(style, t), description: barStyleSample(style), detail: barStylePrecision(style, t) })),
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

type PageAction = 'parts' | 'colors' | 'buttons' | 'countdown' | 'visibility';
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
      { label: `$(watch) ${t('Countdown to the next refresh')}`, description: configuration.statusBarCountdown() ? t('On') : t('Off'), action: 'countdown' },
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
    } else if (picked.action === 'countdown') {
      await writeUserSetting(deps, 'statusBar.countdown', !configuration.statusBarCountdown());
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

// ---- Notifications screen -----------------------------------------------------------------------

type NotificationAction = 'weeklyReset' | 'usageAlert' | 'loginExpiry';
type NotificationItem = vscode.QuickPickItem & { readonly action: NotificationAction };

/** Weekly reset and login expiry switch on/off; the usage alert opens a level picker. Each returns here. */
async function openNotificationsPage(deps: QuickSettingsDependencies): Promise<Outcome> {
  const { configuration } = deps;
  let focus: NotificationAction = 'weeklyReset';
  for (;;) {
    const settings = configuration.notificationSettings();
    const onOff = (on: boolean) => (on ? t('On') : t('Off'));
    const items: NotificationItem[] = [
      {
        label: `$(history) ${t('When a weekly limit resets')}`,
        description: onOff(settings.weeklyReset),
        detail: t('With a button to switch to that account.'),
        action: 'weeklyReset',
      },
      {
        label: `$(warning) ${t('When the active account nears its limit')}`,
        description: usageAlertLabel(settings.usageAlertPct, t),
        detail: t('Once per limit period. Not while automatic switching is on.'),
        action: 'usageAlert',
      },
      {
        label: `$(key) ${t('When a login is about to expire')}`,
        description: onOff(settings.loginExpiry),
        detail: t('3 days before, and once it has expired.'),
        action: 'loginExpiry',
      },
    ];
    const picked = await pickOne(items, {
      title: t('Notifications'),
      placeholder: t('Pick a setting to change it. Esc closes.'),
      back: true,
      isActive: (item) => item.action === focus,
    });
    if (picked === undefined) {
      return 'close';
    }
    if (picked === BACK) {
      return 'list';
    }
    focus = picked.action;
    switch (picked.action) {
      case 'weeklyReset':
        await configuration.setNotifyOnWeeklyReset(!settings.weeklyReset);
        break;
      case 'loginExpiry':
        await configuration.setNotifyLoginExpiry(!settings.loginExpiry);
        break;
      case 'usageAlert': {
        const current = settings.usageAlertPct;
        const value = await chooseValue(
          t('When the active account nears its limit'),
          usageAlertChoices(current).map((pct) => ({ value: pct, label: usageAlertLabel(pct, t) })),
          current,
        );
        if (value === undefined) {
          return 'close';
        }
        if (value !== BACK && value !== current) {
          await configuration.setNotifyAtUsage(value);
        }
        break;
      }
    }
  }
}

// ---- cswap updates screen -----------------------------------------------------------------------

type CswapUpdateAction = 'check' | 'daily' | 'automatic';
type CswapUpdateItem = vscode.QuickPickItem & { readonly action: CswapUpdateAction };

/** Check now (closes the menu), and the daily check and automatic updates switching on/off in place. */
async function openCswapUpdatesPage(deps: QuickSettingsDependencies): Promise<Outcome> {
  const { configuration } = deps;
  let focus: CswapUpdateAction = 'check';
  for (;;) {
    const update = deps.updateCheck?.getState();
    const version = cswapVersionText(update?.current?.text, update?.latest?.text, t);
    const onOff = (on: boolean) => (on ? t('On') : t('Off'));
    const items: CswapUpdateItem[] = [
      { label: `$(sync) ${t('Check for a cswap update now')}`, ...(version === undefined ? {} : { description: version }), action: 'check' },
      {
        label: `$(calendar) ${t('Check once a day')}`,
        description: onOff(configuration.checkCswapUpdates()),
        detail: t('Asks PyPI for the latest claude-swap release; nothing else is sent.'),
        action: 'daily',
      },
      {
        label: `$(cloud-download) ${t('Update automatically')}`,
        description: onOff(configuration.autoUpdateCswap()),
        detail: t('When a check finds a newer cswap, update it in the background with the uv or pipx that installed it.'),
        action: 'automatic',
      },
    ];
    const picked = await pickOne(items, {
      title: t('cswap version'),
      placeholder: t('Pick a setting to change it. Esc closes.'),
      back: true,
      isActive: (item) => item.action === focus,
    });
    if (picked === undefined) {
      return 'close';
    }
    if (picked === BACK) {
      return 'list';
    }
    focus = picked.action;
    switch (picked.action) {
      case 'check':
        await vscode.commands.executeCommand('cswapManager.checkCswapUpdate');
        return 'close';
      case 'daily':
        await configuration.setCheckCswapUpdates(!configuration.checkCswapUpdates());
        break;
      case 'automatic':
        await configuration.setAutoUpdateCswap(!configuration.autoUpdateCswap());
        break;
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
async function editRow(deps: QuickSettingsDependencies, key: ScreenKey): Promise<Outcome> {
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
    case 'autoModel':
      return fromMenu(await deps.autoSwitch.chooseModel({ back: true }));
    case 'autoRules':
      return fromMenu(await deps.autoSwitch.editRules({ back: true }));
    case 'shareHistory':
      return fromMenu(await deps.autoSwitch.chooseShareHistory({ back: true }));
    case 'tokenUsage':
      return fromMenu(await deps.autoSwitch.chooseTokenUsage({ back: true }));
    case 'statusBar':
      return openStatusBarPage(deps);
    case 'notifications':
      return openNotificationsPage(deps);
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
      return chooseCliPath(deps);
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
    case 'projectAccount':
      if (deps.projectAccounts === undefined) {
        return 'list';
      }
      await deps.projectAccounts.assign();
      return 'list';
    case 'cswapVersion':
      return openCswapUpdatesPage(deps);
    case 'transfer': {
      const command = await chooseValue(
        t('Another computer'),
        [
          {
            value: 'cswapManager.exportAccounts',
            label: `$(export) ${t('Export accounts to a file…')}`,
            detail: t('To move your accounts to another computer. The file holds the logins.'),
          },
          { value: 'cswapManager.importAccounts', label: `$(desktop-download) ${t('Import accounts from a file…')}` },
          {
            value: 'cswapManager.saveUsageReadings',
            label: `$(save) ${t('Save usage readings for another computer…')}`,
            detail: t('Computers with the same accounts can let one of them fetch usage and pass it to the others.'),
          },
          { value: 'cswapManager.importUsage', label: `$(cloud-download) ${t('Import usage readings from another computer…')}` },
        ],
        '',
      );
      if (command === undefined) {
        return 'close';
      }
      if (command === BACK) {
        return 'list';
      }
      await vscode.commands.executeCommand(command);
      return 'close';
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
  // A link straight to a setting opens the page that lists it.
  let page: QuickSettingsPage = buildQuickSettingsRows(currentValues(deps), t, 'advanced').some((row) => row.separator !== true && row.key === focus)
    ? 'advanced'
    : 'main';
  for (;;) {
    const key = await pickRow(deps, active, page);
    if (key === undefined) {
      return;
    }
    if (key === BACK) {
      page = 'main';
      active = 'advanced';
      continue;
    }
    if (key === 'advanced') {
      page = 'advanced';
      active = undefined;
      continue;
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
