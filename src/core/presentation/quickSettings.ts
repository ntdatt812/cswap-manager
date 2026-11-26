import type { AutoSwitchStrategy } from '../cli/autoSwitchRules';
import { upgradeTested, type CliVersion } from '../cli/version';
import type { AutoSwitchMode } from '../service/autoSwitchService';
import type { Translate } from './accountTree';
import { capitalized, formatPercent, usageBar, type BarStyle, type SortOrder, type UsageThresholds } from './format';
import { LANGUAGE_INFO, SUPPORTED_LANGUAGES, type UiLanguage } from './language';
import { limitNames, NO_LIMITS_KNOWN, type LimitProfile } from './limits';
import { STATUS_BAR_BAR_WIDTH, STATUS_BAR_PARTS, type StatusBarButton, type StatusBarColors, type StatusBarPart } from './statusBar';

export type LanguageSetting = 'auto' | UiLanguage;
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['auto', ...SUPPORTED_LANGUAGES];

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return typeof value === 'string' && (LANGUAGE_SETTINGS as readonly string[]).includes(value);
}

/** Refresh intervals offered in the picker, in seconds (0 = off). */
export const REFRESH_CHOICES_SECONDS: readonly number[] = [0, 60, 120, 300, 600, 900, 1800, 3600];

export const SETTING_KEYS = [
  'language',
  'confirmSwitch',
  'projectAccount',
  'shareHistory',
  'refresh',
  'autoSwitch',
  'autoStrategy',
  'autoModel',
  'autoRules',
  'statusBar',
  'barStyle',
  'thresholds',
  'sortOrder',
  'tokenUsage',
  'cliPath',
  'cswapVersion',
  'timeout',
  'transfer',
  'dialogStyle',
  'allSettings',
  'notifications',
  'advanced',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === 'string' && (SETTING_KEYS as readonly string[]).includes(value);
}

/** The main list fits without scrolling; rarely changed settings sit on the "Advanced…" page. */
export type QuickSettingsPage = 'main' | 'advanced';

/** The notifications the user can turn on or off. */
export interface NotificationSettings {
  /** `cswapManager.notifyOnWeeklyReset`. */
  readonly weeklyReset: boolean;
  /** `cswapManager.notifyAtUsage`: usage % of the active account's limiting window that alerts; 0 = off. */
  readonly usageAlertPct: number;
  /** `cswapManager.notifyLoginExpiry`. */
  readonly loginExpiry: boolean;
}

/** Usage alert levels offered in the picker (0 = off). */
export const USAGE_ALERT_CHOICES: readonly number[] = [0, 80, 90, 95];

/** The offered alert levels, plus the current one when it was set to something else by hand. */
export function usageAlertChoices(currentPct: number): number[] {
  return [...new Set([...USAGE_ALERT_CHOICES, currentPct])].sort((a, b) => a - b);
}

export function usageAlertLabel(pct: number, t: Translate): string {
  return pct > 0 ? formatPercent(pct) : t('Off');
}

/** `90% · login expiry · weekly reset`, or Off when every notification is off. */
export function notificationsSummary(settings: NotificationSettings, t: Translate): string {
  const parts = [
    settings.usageAlertPct > 0 ? formatPercent(settings.usageAlertPct) : undefined,
    settings.loginExpiry ? t('login expiry') : undefined,
    settings.weeklyReset ? t('weekly reset') : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? t('Off') : parts.join(' · ');
}

export interface QuickSettingsValues {
  readonly language: LanguageSetting;
  readonly confirmSwitch: boolean;
  readonly notifications: NotificationSettings;
  readonly autoSwitchMode: AutoSwitchMode;
  /** cswap's `autoswitch.strategy`; undefined while the rules are not loaded. */
  readonly autoSwitchStrategy: string | undefined;
  /** cswap's `autoswitch.model`: null when unset, undefined while the rules are not loaded. */
  readonly autoSwitchModel: string | null | undefined;
  /** Short summary of cswap's other auto-switch rules; undefined while not loaded. */
  readonly autoSwitchRules: string | undefined;
  /** cswap's `run.shareHistory`; undefined while the settings are not loaded. */
  readonly shareHistory: boolean | undefined;
  /** cswap's `usage.headerProbe` / `usage.fableProbe`; undefined while not loaded. */
  readonly tokenUsage: TokenUsageLevel | undefined;
  /** Which limits the accounts report, for labels that name them; nothing known when absent. */
  readonly limits?: LimitProfile;
  /** Parts the status bar item shows; empty when it is hidden. */
  readonly statusBarParts: readonly StatusBarPart[];
  readonly statusBarButtons: readonly StatusBarButton[];
  readonly barStyle: BarStyle;
  readonly thresholds: UsageThresholds;
  readonly sortOrder: SortOrder;
  /** Effective automatic refresh interval in seconds; 0 when off. */
  readonly refreshSeconds: number;
  /** The configured cswap path for display (home shortened to `~`); empty when auto-detected. */
  readonly cliPath: string;
  readonly timeoutSeconds: number;
  /** Account assigned to the open project with `cswap map`: text, or undefined when no folder is open. */
  readonly projectAccount?: string;
  /** Installed cswap version and the newer one, when known. */
  readonly cswapVersion?: CliVersion;
  readonly cswapLatest?: CliVersion;
  readonly cswapUpdates: CswapUpdateSettings;
  /** VS Code's `window.dialogStyle` is `custom`: dialogs follow the colour theme. */
  readonly themedDialogs: boolean;
}

/** `cswapManager.checkCswapUpdates` and `cswapManager.autoUpdateCswap`. */
export interface CswapUpdateSettings {
  readonly daily: boolean;
  readonly automatic: boolean;
}

/**
 * `1.2.0`, `1.2.0 · 1.2.1 available`, or `… (not tested yet)` for a release line this extension was
 * not tested with (`upgradeTested`); undefined while the version is not known.
 */
export function cswapVersionText(version: CliVersion | undefined, latest: CliVersion | undefined, t: Translate): string | undefined {
  if (version === undefined) {
    return undefined;
  }
  if (latest === undefined || latest.text === version.text) {
    return version.text;
  }
  return upgradeTested(version, latest) ? t('{0} · {1} available', version.text, latest.text) : t('{0} · {1} available (not tested yet)', version.text, latest.text);
}

/** How cswap is kept up to date. */
export function cswapUpdatesLabel(settings: CswapUpdateSettings, t: Translate): string {
  if (!settings.daily) {
    return t('not checked daily');
  }
  return settings.automatic ? t('updates automatically') : t('asks before updating');
}

/** Time limits offered for one cswap command, in seconds. */
export const TIMEOUT_CHOICES_SECONDS: readonly number[] = [15, 30, 60, 120, 300];

/** The offered time limits, plus the current one when it was set to something else by hand. */
export function timeoutChoices(currentSeconds: number): number[] {
  return [...new Set([...TIMEOUT_CHOICES_SECONDS, Math.round(currentSeconds)])].sort((a, b) => a - b);
}

export type QuickSettingsRow =
  | { readonly separator: true; readonly label: string }
  | { readonly separator?: false; readonly key: SettingKey; readonly iconId: string; readonly label: string; readonly value: string };

/** Language names are shown in their own language so they can be found whatever the UI language is. */
export function languageLabel(language: LanguageSetting, t: Translate): string {
  return language === 'auto' ? t('Automatic (follow VS Code)') : LANGUAGE_INFO[language].name;
}

/**
 * The language row and picker title keep the English word next to a translation (`Ngôn ngữ ·
 * Language`), so someone who picked a language they cannot read can still find the way back.
 */
export function languageTitle(t: Translate): string {
  const translated = t('Language');
  return translated === 'Language' ? translated : `${translated} · Language`;
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
  if (seconds === 60) {
    return t('every minute');
  }
  return seconds % 60 === 0 ? t('every {0} min', seconds / 60) : t('every {0}s', seconds);
}

/** cswap's wait after a switch: `cooldown 5 min`, or seconds when it is not whole minutes. */
export function cooldownLabel(seconds: number, t: Translate): string {
  return seconds > 0 && seconds % 60 === 0 ? t('cooldown {0} min', seconds / 60) : t('cooldown {0}s', seconds);
}

/** The offered intervals, plus the current one when it was set to something else by hand. */
export function refreshChoices(currentSeconds: number): number[] {
  const choices = new Set(REFRESH_CHOICES_SECONDS);
  choices.add(Math.max(0, Math.round(currentSeconds)));
  return [...choices].sort((a, b) => a - b);
}

// ---- Status bar -------------------------------------------------------------------------------

export const STATUS_BAR_LOOKS = ['compact', 'bar', 'full', 'name', 'slot', 'minimal'] as const;
export type StatusBarLook = (typeof STATUS_BAR_LOOKS)[number];

/** Ready-made status bar looks; `compact` is the default. */
export const STATUS_BAR_LOOK_PARTS: Record<StatusBarLook, readonly StatusBarPart[]> = {
  compact: ['icon', 'slot', 'usage'],
  bar: ['icon', 'slot', 'bar', 'usage'],
  full: ['icon', 'slot', 'plan', 'bar', 'usage', 'reset'],
  name: ['icon', 'name', 'usage'],
  slot: ['icon', 'slot'],
  minimal: ['icon', 'usage'],
};

export function statusBarLookLabel(look: StatusBarLook, t: Translate): string {
  switch (look) {
    case 'compact':
      return t('Compact');
    case 'bar':
      return t('With progress bar');
    case 'full':
      return t('Full');
    case 'name':
      return t('Name and usage');
    case 'slot':
      return t('Slot only');
    case 'minimal':
      return t('Usage only');
  }
}

/** The ready-made look these parts match, if any (order does not matter). */
export function matchingLook(parts: readonly StatusBarPart[]): StatusBarLook | undefined {
  const key = (list: readonly StatusBarPart[]) => STATUS_BAR_PARTS.filter((part) => list.includes(part)).join();
  return STATUS_BAR_LOOKS.find((look) => key(STATUS_BAR_LOOK_PARTS[look]) === key(parts));
}

export function statusBarPartLabel(part: StatusBarPart, t: Translate): string {
  switch (part) {
    case 'icon':
      return t('Usage-level icon');
    case 'slot':
      return t('Slot number');
    case 'name':
      return t('Name (display name or email)');
    case 'plan':
      return t('Plan');
    case 'bar':
      return t('Progress bar');
    case 'usage':
      return t('Usage percentage');
    case 'reset':
      return t('Time to reset');
  }
}

export function barStyleLabel(style: BarStyle, t: Translate): string {
  switch (style) {
    case 'blocks':
      return t('Blocks');
    case 'parallelograms':
      return t('Slanted');
    case 'circles':
      return t('Dots');
    case 'squares':
      return t('Squares');
  }
}

/**
 * How finely a style can draw. Blocks have Unicode eighths; slanted cells get eighths from the
 * extension's own icons, which tree items cannot show.
 */
export function barStylePrecision(style: BarStyle, t: Translate): string {
  switch (style) {
    case 'blocks':
      return t('Each cell shows eighths, so steps of about 1%.');
    case 'circles':
    case 'squares':
      return t('Each cell shows halves, so steps of about 5%.');
    case 'parallelograms':
      return t('Each cell shows eighths (about 1%) in the switcher, status bar and tooltips; the sidebar shows whole cells.');
  }
}

/** A sample bar in the given style, for pickers. */
export function barStyleSample(style: BarStyle): string {
  return usageBar(60, STATUS_BAR_BAR_WIDTH, style, { icons: true });
}

export function statusBarColorsLabel(colors: StatusBarColors, t: Translate): string {
  switch (colors) {
    case 'background':
      return t('Coloured background');
    case 'text':
      return t('Coloured text only');
    case 'none':
      return t('No colour');
  }
}

export function statusBarButtonLabel(button: StatusBarButton, t: Translate): string {
  switch (button) {
    case 'refresh':
      return t('Refresh');
    case 'dashboard':
      return t('Dashboard');
    case 'settings':
      return t('Settings');
  }
}

export function statusBarSummary(parts: readonly StatusBarPart[], buttons: readonly StatusBarButton[], t: Translate): string {
  const look = matchingLook(parts);
  const item = parts.length === 0 ? t('Hidden') : look === undefined ? t('Custom') : statusBarLookLabel(look, t);
  return buttons.length === 0 ? item : `${item} · ${t('{0} button(s)', buttons.length)}`;
}

export function thresholdsLabel(thresholds: UsageThresholds, t: Translate): string {
  return t('yellow {0} · red {1}', formatPercent(thresholds.warning), formatPercent(thresholds.critical));
}

/** How cswap reads setup-token accounts' usage: not at all, 1-token Haiku probes, or Haiku + Fable probes. */
export type TokenUsageLevel = 'off' | 'haiku' | 'fable';

export function tokenUsageLevel(settings: { readonly headerProbe?: boolean; readonly fableProbe?: boolean } | undefined): TokenUsageLevel | undefined {
  if (settings === undefined) {
    return undefined;
  }
  if (settings.headerProbe !== true) {
    return 'off';
  }
  return settings.fableProbe === true ? 'fable' : 'haiku';
}

/** cswap's `run.shareHistory`, on unless set to false; undefined while the settings are not loaded. */
export function shareHistoryOn(settings: { readonly shareHistory?: boolean } | undefined): boolean | undefined {
  return settings === undefined ? undefined : settings.shareHistory !== false;
}

/** The probe levels name the limits the accounts actually have (`limitProfile`), e.g. `Weekly limits`. */
export function tokenUsageLabel(level: TokenUsageLevel | undefined, t: Translate, limits: LimitProfile = NO_LIMITS_KNOWN): string {
  switch (level) {
    case undefined:
      return t('rules not loaded');
    case 'off':
      return t('Off');
    case 'haiku':
      return capitalized(t('{0} limits', limitNames(limits, t)));
    case 'fable':
      return capitalized(t('{0} limits', limitNames(limits, t, ['Fable'])));
  }
}

export function modelLabel(model: string | null | undefined, t: Translate): string {
  if (model === undefined) {
    return t('rules not loaded');
  }
  if (model === null || model === '') {
    return t('Overall limits only');
  }
  return model.toLowerCase() === 'all' ? t('All per-model limits') : model;
}

export function buildQuickSettingsRows(values: QuickSettingsValues, t: Translate, page: QuickSettingsPage = 'main'): QuickSettingsRow[] {
  return page === 'main' ? mainRows(values, t) : advancedRows(values, t);
}

function mainRows(values: QuickSettingsValues, t: Translate): QuickSettingsRow[] {
  return [
    { key: 'language', iconId: 'globe', label: languageTitle(t), value: languageLabel(values.language, t) },
    { separator: true, label: t('Switching') },
    { key: 'confirmSwitch', iconId: 'question', label: t('Ask before switching'), value: values.confirmSwitch ? t('On') : t('Off') },
    { key: 'projectAccount', iconId: 'folder', label: t('Account for this project'), value: values.projectAccount ?? t('no folder open') },
    {
      key: 'shareHistory',
      iconId: 'comment-discussion',
      label: t('Chat history across accounts'),
      value: values.shareHistory === undefined ? t('rules not loaded') : values.shareHistory ? t('Shared') : t('Separate per account'),
    },
    { separator: true, label: t('Auto-switch') },
    { key: 'autoSwitch', iconId: 'sync', label: t('Auto-switch'), value: values.autoSwitchMode === 'switch' ? t('On') : autoSwitchModeLabel(values.autoSwitchMode, t) },
    // How it switches matters only while it runs; turned off, the list stays short.
    ...(values.autoSwitchMode === 'off' ? [] : autoSwitchDetailRows(values, t)),
    { separator: true, label: t('Display') },
    { key: 'statusBar', iconId: 'layout-statusbar', label: t('Status bar'), value: statusBarSummary(values.statusBarParts, values.statusBarButtons, t) },
    { key: 'barStyle', iconId: 'symbol-numeric', label: t('Progress bar style'), value: `${barStyleLabel(values.barStyle, t)} ${barStyleSample(values.barStyle)}` },
    { key: 'thresholds', iconId: 'symbol-color', label: t('Usage colours'), value: thresholdsLabel(values.thresholds, t) },
    { key: 'sortOrder', iconId: 'list-ordered', label: t('Account order'), value: sortOrderLabel(values.sortOrder, t) },
    { separator: true, label: t('More') },
    { key: 'advanced', iconId: 'ellipsis', label: t('Advanced…'), value: t('notifications, refresh, token accounts, cswap, another computer, dialogs') },
  ];
}

function autoSwitchDetailRows(values: QuickSettingsValues, t: Translate): QuickSettingsRow[] {
  return [
    {
      key: 'autoStrategy',
      iconId: 'lightbulb',
      label: t('Auto-switch strategy'),
      value: values.autoSwitchStrategy === undefined ? t('rules not loaded') : autoSwitchStrategyLabel(values.autoSwitchStrategy, t),
    },
    { key: 'autoModel', iconId: 'symbol-class', label: t('Per-model limits'), value: modelLabel(values.autoSwitchModel, t) },
    { key: 'autoRules', iconId: 'law', label: t('Auto-switch rules'), value: values.autoSwitchRules ?? t('rules not loaded') },
  ];
}

function advancedRows(values: QuickSettingsValues, t: Translate): QuickSettingsRow[] {
  return [
    { separator: true, label: t('Usage and alerts') },
    { key: 'notifications', iconId: 'bell', label: t('Notifications…'), value: notificationsSummary(values.notifications, t) },
    { key: 'refresh', iconId: 'history', label: t('Auto refresh'), value: refreshLabel(values.refreshSeconds, t) },
    { key: 'tokenUsage', iconId: 'key', label: t('Usage of token accounts'), value: tokenUsageLabel(values.tokenUsage, t, values.limits) },
    { separator: true, label: t('cswap') },
    { key: 'cliPath', iconId: 'terminal', label: t('cswap path'), value: values.cliPath === '' ? t('auto-detect') : values.cliPath },
    {
      key: 'cswapVersion',
      iconId: 'cloud-download',
      label: t('cswap version'),
      value: [cswapVersionText(values.cswapVersion, values.cswapLatest, t), cswapUpdatesLabel(values.cswapUpdates, t)].filter((part) => part !== undefined).join(' · '),
    },
    { key: 'timeout', iconId: 'watch', label: t('Command time limit'), value: t('{0} s', values.timeoutSeconds) },
    { separator: true, label: t('Other') },
    { key: 'transfer', iconId: 'arrow-swap', label: t('Another computer'), value: t('export, import, usage readings') },
    { key: 'dialogStyle', iconId: 'window', label: t('Dialogs'), value: values.themedDialogs ? t('In the colour theme') : t('System style') },
    { key: 'allSettings', iconId: 'settings-gear', label: t('All settings…'), value: t('VS Code settings page') },
  ];
}
