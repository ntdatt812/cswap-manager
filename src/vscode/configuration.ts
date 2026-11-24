import * as vscode from 'vscode';
import type { CliRunSettings } from '../core/cli/cswapCli';
import { cleanDisplayName, displayNameKey } from '../core/model/displayNames';
import type { Account } from '../core/model/types';
import { isBarStyle, isSortOrder, normalizeThresholds, type BarStyle, type SortOrder, type UsageThresholds } from '../core/presentation/format';
import { isLanguageSetting, type LanguageSetting } from '../core/presentation/quickSettings';
import {
  DEFAULT_STATUS_BAR_BUTTONS,
  DEFAULT_STATUS_BAR_PARTS,
  STATUS_BAR_BUTTONS,
  isStatusBarColors,
  isStatusBarMode,
  isStatusBarPart,
  statusBarParts,
  type StatusBarButton,
  type StatusBarColors,
  type StatusBarMode,
  type StatusBarPart,
} from '../core/presentation/statusBar';
import { isAutoSwitchMode, type AutoSwitchMode } from '../core/service/autoSwitchService';
import { normalizeIntervalMs } from '../core/service/refreshScheduler';
import { DEFAULT_STALE_AFTER_MS } from '../core/service/refreshService';

export const CONFIG_SECTION = 'cswapManager';

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_OUTPUT_KB = 2048;
const DEFAULT_REFRESH_SECONDS = 120;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Reads settings. `cliPath` is read from the user (global) scope only: the setting is declared
 * machine-scoped, and ignoring workspace values here is defence in depth against a repository that
 * tries to point the extension at an executable of its choosing.
 */
export class ExtensionConfiguration {
  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  private number(key: string, fallback: number): number {
    const value = this.config.get<number>(key, fallback);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  cliPath(): string {
    const inspected = this.config.inspect<string>('cliPath');
    const value = inspected?.globalValue;
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * Saves the cswap path in the user settings (`undefined` = find it automatically). Workspace
   * values of this setting are never read, so nothing else can override it.
   */
  async setCliPath(path: string | undefined): Promise<void> {
    await this.config.update('cliPath', path, vscode.ConfigurationTarget.Global);
  }

  cliRunSettings(): CliRunSettings {
    return {
      timeoutMs: clamp(this.number('commandTimeoutSeconds', DEFAULT_TIMEOUT_SECONDS), 2, 300) * 1000,
      maxOutputBytes: clamp(this.number('maxOutputKilobytes', DEFAULT_MAX_OUTPUT_KB), 64, 65536) * 1024,
    };
  }

  /** 0 means automatic refresh is off. */
  refreshIntervalMs(): number {
    return normalizeIntervalMs(this.number('refreshIntervalSeconds', DEFAULT_REFRESH_SECONDS));
  }

  sortOrder(): SortOrder {
    const value = this.config.get<string>('sidebar.sortOrder', 'slot');
    return isSortOrder(value) ? value : 'slot';
  }

  async setSortOrder(order: SortOrder): Promise<void> {
    await this.config.update('sidebar.sortOrder', order, vscode.ConfigurationTarget.Global);
  }

  thresholds(): UsageThresholds {
    return normalizeThresholds(this.number('display.warningThreshold', 80), this.number('display.criticalThreshold', 95));
  }

  /** Data older than this is shown as stale even if the last refresh succeeded. */
  staleAfterMs(): number {
    return Math.max(DEFAULT_STALE_AFTER_MS, 2 * this.refreshIntervalMs());
  }

  statusBarMode(): StatusBarMode {
    const value = this.config.get<string>('statusBar.mode', 'slotUsage');
    return isStatusBarMode(value) ? value : 'slotUsage';
  }

  /** Parts ticked for `statusBar.mode: custom`; unknown entries are dropped. */
  customStatusBarParts(): StatusBarPart[] {
    const value = this.config.get<unknown>('statusBar.parts');
    return Array.isArray(value) ? value.filter(isStatusBarPart) : [...DEFAULT_STATUS_BAR_PARTS];
  }

  /** What the status bar item shows right now; empty when it is hidden. */
  statusBarParts(): StatusBarPart[] {
    return statusBarParts(this.statusBarMode(), this.customStatusBarParts());
  }

  /** Progress bar look in the sidebar, switch picker and status bar. */
  barStyle(): BarStyle {
    const value = this.config.get<string>('display.barStyle', 'blocks');
    return isBarStyle(value) ? value : 'blocks';
  }

  statusBarColors(): StatusBarColors {
    const value = this.config.get<string>('statusBar.colors', 'background');
    return isStatusBarColors(value) ? value : 'background';
  }

  statusBarButtons(): StatusBarButton[] {
    const value = this.config.get<unknown>('statusBar.buttons');
    return Array.isArray(value) ? STATUS_BAR_BUTTONS.filter((button) => value.includes(button)) : [...DEFAULT_STATUS_BAR_BUTTONS];
  }

  /** User scope only: a workspace must never be able to turn automatic switching on. */
  autoSwitchMode(): AutoSwitchMode {
    const value = this.config.inspect<string>('autoSwitch.mode')?.globalValue;
    return isAutoSwitchMode(value) ? value : 'off';
  }

  async setAutoSwitchMode(mode: AutoSwitchMode): Promise<void> {
    await this.config.update('autoSwitch.mode', mode, vscode.ConfigurationTarget.Global);
  }

  /** `auto` follows VS Code's display language. */
  language(): string {
    return this.config.get<string>('language', 'auto');
  }

  languageSetting(): LanguageSetting {
    const value = this.language();
    return isLanguageSetting(value) ? value : 'auto';
  }

  /** Effective automatic refresh interval in whole seconds; 0 when off. */
  refreshIntervalSeconds(): number {
    return Math.round(this.refreshIntervalMs() / 1000);
  }

  /** User scope only: a workspace must not be able to silence switch confirmations. */
  confirmSwitch(): boolean {
    return this.config.inspect<boolean>('confirmSwitch')?.globalValue !== false;
  }

  async setConfirmSwitch(confirm: boolean): Promise<void> {
    await this.config.update('confirmSwitch', confirm, vscode.ConfigurationTarget.Global);
  }

  /** A notification when an account's weekly limit resets (user scope only; off by default). */
  notifyOnWeeklyReset(): boolean {
    return this.config.inspect<boolean>('notifyOnWeeklyReset')?.globalValue === true;
  }

  async setNotifyOnWeeklyReset(notify: boolean): Promise<void> {
    await this.config.update('notifyOnWeeklyReset', notify, vscode.ConfigurationTarget.Global);
  }

  /** Daily check of PyPI for a newer cswap (user scope only). */
  checkCswapUpdates(): boolean {
    return this.config.inspect<boolean>('checkCswapUpdates')?.globalValue !== false;
  }

  /** Saved display names, keyed by `displayNameKey`; anything malformed is ignored. */
  displayNameMap(): Record<string, string> {
    const value = this.config.get<unknown>('displayNames');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => /^[0-9a-f]{16}$/.test(entry[0]) && typeof entry[1] === 'string'));
  }

  /** Saves (or with an empty name removes) an account's display name in user settings. */
  async setDisplayName(account: Account, name: string): Promise<void> {
    const key = displayNameKey(account);
    if (key === undefined) {
      return;
    }
    const names = { ...this.displayNameMap() };
    const cleaned = cleanDisplayName(name);
    if (cleaned === '') {
      delete names[key];
    } else {
      names[key] = cleaned;
    }
    await this.setUserSetting('displayNames', names);
  }

  /**
   * Settings this window does not know. After VS Code auto-updates the extension it restarts the
   * extension host with the new code, but settings added by the update stay unregistered until the
   * window reloads, and VS Code refuses to write them. Every contributed setting has a default, so a
   * missing default means "not registered".
   */
  unregisteredSettings(keys: readonly UserSettingKey[] = USER_SETTING_KEYS): UserSettingKey[] {
    return keys.filter((key) => this.config.inspect(key)?.defaultValue === undefined);
  }

  /**
   * Writes a user setting. Returns true when a workspace value still overrides it in this window,
   * so the caller can say why nothing seems to change.
   */
  async setUserSetting(key: UserSettingKey, value: unknown): Promise<boolean> {
    try {
      await this.config.update(key, value, vscode.ConfigurationTarget.Global);
    } catch (error) {
      throw this.unregisteredSettings([key]).length > 0 ? new SettingNotLoadedError(key) : error;
    }
    const inspected = this.config.inspect(key);
    return inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
  }
}

/** VS Code has the new extension code but not its new settings yet: a window reload fixes it. */
export class SettingNotLoadedError extends Error {
  constructor(readonly key: string) {
    super(`${CONFIG_SECTION}.${key} is not registered in this window yet`);
    this.name = 'SettingNotLoadedError';
  }
}

/** Window-scoped settings the quick settings menu writes to the user scope. */
export const USER_SETTING_KEYS = [
  'language',
  'statusBar.mode',
  'statusBar.parts',
  'display.barStyle',
  'statusBar.colors',
  'statusBar.buttons',
  'display.warningThreshold',
  'display.criticalThreshold',
  'sidebar.sortOrder',
  'commandTimeoutSeconds',
  'refreshIntervalSeconds',
  'displayNames',
] as const;
export type UserSettingKey = (typeof USER_SETTING_KEYS)[number];
