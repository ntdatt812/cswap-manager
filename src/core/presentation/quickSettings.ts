import type { AutoSwitchStrategy } from '../cli/autoSwitchRules';
import type { AutoSwitchMode } from '../service/autoSwitchService';
import type { Translate } from './accountTree';
import type { SortOrder } from './format';
import type { StatusBarMode } from './statusBar';

export const LANGUAGE_SETTINGS = ['auto', 'en', 'vi'] as const;
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number];

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return typeof value === 'string' && (LANGUAGE_SETTINGS as readonly string[]).includes(value);
}

/** Refresh intervals offered in the picker, in seconds (0 = off). */
export const REFRESH_CHOICES_SECONDS: readonly number[] = [0, 60, 120, 300, 600, 900, 1800, 3600];

export const SETTING_KEYS = ['language', 'confirmSwitch', 'autoSwitch', 'autoStrategy', 'statusBar', 'sortOrder', 'refresh', 'allSettings'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === 'string' && (SETTING_KEYS as readonly string[]).includes(value);
}

export interface QuickSettingsValues {
  readonly language: LanguageSetting;
  readonly confirmSwitch: boolean;
  readonly autoSwitchMode: AutoSwitchMode;
  /** cswap's `autoswitch.strategy`; undefined while the rules are not loaded. */
  readonly autoSwitchStrategy: string | undefined;
  readonly statusBarMode: StatusBarMode;
  readonly sortOrder: SortOrder;
  /** Effective automatic refresh interval in seconds; 0 when off. */
  readonly refreshSeconds: number;
}

export type QuickSettingsRow =
  | { readonly separator: true; readonly label: string }
  | { readonly separator?: false; readonly key: SettingKey; readonly iconId: string; readonly label: string; readonly value: string };

/** Language names are shown in their own language so they can be found whatever the UI language is. */
export function languageLabel(language: LanguageSetting, t: Translate): string {
  switch (language) {
    case 'auto':
      return t('Automatic (follow VS Code)');
    case 'en':
      return 'English';
    case 'vi':
      return 'Tiếng Việt';
  }
}

export function autoSwitchModeLabel(mode: AutoSwitchMode, t: Translate): string {
  switch (mode) {
    case 'off':
      return t('Off');
    case 'notify':
      return t('Notify only');
    case 'switch':
      return t('Switch automatically');
  }
}

/** Names for cswap's `cswap auto --strategy` values (from `cswap auto --help`). */
export function autoSwitchStrategyLabel(strategy: string | undefined, t: Translate): string {
  switch (strategy as AutoSwitchStrategy | undefined) {
    case 'best':
      return t('Most quota left');
    case 'weekly-first':
      return t('Soonest weekly reset, at the limit');
    case 'consume-first':
      return t('Use quota that resets soonest first');
    case 'priority-consume-first':
      return t('By account priority');
    default:
      // Only cswap-style strategy codes are shown; anything else in the config file is not echoed.
      return strategy !== undefined && /^[a-z0-9-]{1,40}$/.test(strategy) ? strategy : t('unknown');
  }
}

export function autoSwitchStrategyDetail(strategy: AutoSwitchStrategy, t: Translate): string {
  switch (strategy) {
    case 'best':
      return t('Switches at the threshold, to the account with the most quota left. cswap default.');
    case 'weekly-first':
      return t('Switches at the threshold, to the account whose weekly quota resets soonest.');
    case 'consume-first':
      return t('Moves early to an account with quota left whose week resets sooner, so that quota is not wasted.');
    case 'priority-consume-first':
      return t('Highest account priority first (set with cswap priority), then soonest weekly reset.');
  }
}

export function statusBarModeLabel(mode: StatusBarMode, t: Translate): string {
  switch (mode) {
    case 'slotUsage':
      return t('Slot and usage');
    case 'slot':
      return t('Slot only');
    case 'nameUsage':
      return t('Name and usage');
    case 'hidden':
      return t('Hidden');
  }
}

export function sortOrderLabel(order: SortOrder, t: Translate): string {
  switch (order) {
    case 'slot':
      return t('By slot number');
    case 'mostUsed':
      return t('Highest usage first');
    case 'leastUsed':
      return t('Most remaining quota first');
    case 'soonestReset':
      return t('Soonest reset first');
  }
}

export function refreshLabel(seconds: number, t: Translate): string {
  if (seconds <= 0) {
    return t('Off');
  }
  return seconds % 60 === 0 ? t('every {0} min', seconds / 60) : t('every {0}s', seconds);
}

/** The offered intervals, plus the current one when it was set to something else by hand. */
export function refreshChoices(currentSeconds: number): number[] {
  const choices = new Set(REFRESH_CHOICES_SECONDS);
  choices.add(Math.max(0, Math.round(currentSeconds)));
  return [...choices].sort((a, b) => a - b);
}

export function buildQuickSettingsRows(values: QuickSettingsValues, t: Translate): QuickSettingsRow[] {
  return [
    { key: 'language', iconId: 'globe', label: t('Language'), value: languageLabel(values.language, t) },
    { key: 'confirmSwitch', iconId: 'question', label: t('Ask before switching'), value: values.confirmSwitch ? t('On') : t('Off') },
    { key: 'autoSwitch', iconId: 'sync', label: t('Auto-switch'), value: autoSwitchModeLabel(values.autoSwitchMode, t) },
    {
      key: 'autoStrategy',
      iconId: 'lightbulb',
      label: t('Auto-switch strategy'),
      value: values.autoSwitchStrategy === undefined ? t('rules not loaded') : autoSwitchStrategyLabel(values.autoSwitchStrategy, t),
    },
    { separator: true, label: t('Display') },
    { key: 'statusBar', iconId: 'layout-statusbar', label: t('Status bar'), value: statusBarModeLabel(values.statusBarMode, t) },
    { key: 'sortOrder', iconId: 'list-ordered', label: t('Account order'), value: sortOrderLabel(values.sortOrder, t) },
    { key: 'refresh', iconId: 'history', label: t('Auto refresh'), value: refreshLabel(values.refreshSeconds, t) },
    { separator: true, label: t('Advanced') },
    { key: 'allSettings', iconId: 'settings-gear', label: t('All settings…'), value: t('cswap path, timeouts, colours') },
  ];
}
