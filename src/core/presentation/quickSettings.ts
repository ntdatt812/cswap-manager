import type { AutoSwitchStrategy } from '../cli/autoSwitchRules';
import type { AutoSwitchMode } from '../service/autoSwitchService';
import type { Translate } from './accountTree';
import { formatPercent, usageBar, type BarStyle, type SortOrder, type UsageThresholds } from './format';
import { STATUS_BAR_BAR_WIDTH, STATUS_BAR_PARTS, type StatusBarButton, type StatusBarColors, type StatusBarPart } from './statusBar';

export const LANGUAGE_SETTINGS = ['auto', 'en', 'vi'] as const;
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number];

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
  'allSettings',
] as const;
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
  /** cswap's `autoswitch.model`: null when unset, undefined while the rules are not loaded. */
  readonly autoSwitchModel: string | null | undefined;
  /** Short summary of cswap's other auto-switch rules; undefined while not loaded. */
  readonly autoSwitchRules: string | undefined;
  /** cswap's `run.shareHistory`; undefined while the settings are not loaded. */
  readonly shareHistory: boolean | undefined;
  /** cswap's `usage.headerProbe` / `usage.fableProbe`; undefined while not loaded. */
  readonly tokenUsage: TokenUsageLevel | undefined;
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
  readonly cswapVersion?: string;
  readonly cswapLatest?: string;
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

export function tokenUsageLabel(level: TokenUsageLevel | undefined, t: Translate): string {
  switch (level) {
    case undefined:
      return t('rules not loaded');
    case 'off':
      return t('Off');
    case 'haiku':
      return t('5-hour and weekly');
    case 'fable':
      return t('5-hour, weekly and Fable');
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

export function buildQuickSettingsRows(values: QuickSettingsValues, t: Translate): QuickSettingsRow[] {
  return [
    { key: 'language', iconId: 'globe', label: t('Language'), value: languageLabel(values.language, t) },
    { key: 'confirmSwitch', iconId: 'question', label: t('Ask before switching'), value: values.confirmSwitch ? t('On') : t('Off') },
    { key: 'projectAccount', iconId: 'folder', label: t('Account for this project'), value: values.projectAccount ?? t('no folder open') },
    {
      key: 'shareHistory',
      iconId: 'comment-discussion',
      label: t('Chat history across accounts'),
      value: values.shareHistory === undefined ? t('rules not loaded') : values.shareHistory ? t('Shared') : t('Separate per account'),
    },
    { key: 'refresh', iconId: 'history', label: t('Auto refresh'), value: refreshLabel(values.refreshSeconds, t) },
    { separator: true, label: t('Auto-switch') },
    { key: 'autoSwitch', iconId: 'sync', label: t('Auto-switch'), value: autoSwitchModeLabel(values.autoSwitchMode, t) },
    {
      key: 'autoStrategy',
      iconId: 'lightbulb',
      label: t('Auto-switch strategy'),
      value: values.autoSwitchStrategy === undefined ? t('rules not loaded') : autoSwitchStrategyLabel(values.autoSwitchStrategy, t),
    },
    { key: 'autoModel', iconId: 'symbol-class', label: t('Per-model limits'), value: modelLabel(values.autoSwitchModel, t) },
    { key: 'autoRules', iconId: 'law', label: t('Auto-switch rules'), value: values.autoSwitchRules ?? t('rules not loaded') },
    { separator: true, label: t('Display') },
    { key: 'statusBar', iconId: 'layout-statusbar', label: t('Status bar'), value: statusBarSummary(values.statusBarParts, values.statusBarButtons, t) },
    { key: 'barStyle', iconId: 'symbol-numeric', label: t('Progress bar style'), value: `${barStyleLabel(values.barStyle, t)} ${barStyleSample(values.barStyle)}` },
    { key: 'thresholds', iconId: 'symbol-color', label: t('Usage colours'), value: thresholdsLabel(values.thresholds, t) },
    { key: 'sortOrder', iconId: 'list-ordered', label: t('Account order'), value: sortOrderLabel(values.sortOrder, t) },
    { separator: true, label: t('Advanced') },
    { key: 'tokenUsage', iconId: 'key', label: t('Usage of token accounts'), value: tokenUsageLabel(values.tokenUsage, t) },
    { key: 'cliPath', iconId: 'terminal', label: t('cswap path'), value: values.cliPath === '' ? t('auto-detect') : values.cliPath },
    {
      key: 'cswapVersion',
      iconId: 'cloud-download',
      label: t('cswap version'),
      value:
        values.cswapVersion === undefined
          ? t('check for updates')
          : values.cswapLatest !== undefined && values.cswapLatest !== values.cswapVersion
            ? t('{0} · {1} available', values.cswapVersion, values.cswapLatest)
            : values.cswapVersion,
    },
    { key: 'timeout', iconId: 'watch', label: t('Command time limit'), value: t('{0} s', values.timeoutSeconds) },
    { key: 'transfer', iconId: 'arrow-swap', label: t('Another computer'), value: t('export, import, usage readings') },
    { key: 'allSettings', iconId: 'settings-gear', label: t('All settings…'), value: t('VS Code settings page') },
  ];
}
