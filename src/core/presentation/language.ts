/**
 * UI languages with a bundle in `l10n/`, named by VS Code's locale ids (`bundle.l10n.zh-cn.json`).
 * English strings are the keys themselves.
 */
export const SUPPORTED_LANGUAGES = ['en', 'vi', 'zh-cn', 'zh-tw', 'ja', 'ko'] as const;
export type UiLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Chinese locales written in Traditional characters; every other `zh` locale gets Simplified. */
const TRADITIONAL_CHINESE = /^zh-(tw|hk|mo|hant)(-|$)/;

/**
 * Each language's own name (shown in that language, so it can be found whatever the UI language
 * is) and its locale for dates and numbers. A new language needs an entry here, a bundle and a
 * `package.json` enum value (the l10n tests check they match).
 */
export const LANGUAGE_INFO: Readonly<Record<UiLanguage, { readonly name: string; readonly locale: string }>> = {
  en: { name: 'English', locale: 'en' },
  vi: { name: 'Tiếng Việt', locale: 'vi-VN' },
  'zh-cn': { name: '简体中文', locale: 'zh-CN' },
  'zh-tw': { name: '繁體中文', locale: 'zh-TW' },
  ja: { name: '日本語', locale: 'ja-JP' },
  ko: { name: '한국어', locale: 'ko-KR' },
};

/** Locale for dates and numbers: the language's own; English keeps VS Code's English variant (`en-GB`, …). */
export function languageLocale(language: UiLanguage, displayLanguage: string): string {
  return language === 'en' && displayLanguage.toLowerCase().startsWith('en') ? displayLanguage : LANGUAGE_INFO[language].locale;
}

/** Maps a setting value or a VS Code locale (`vi`, `vi-VN`, `zh-tw`, `ja`, `en-US`, …) to a supported language. */
export function resolveLanguage(setting: string | undefined, displayLanguage: string): UiLanguage {
  const requested = (setting === undefined || setting === 'auto' ? displayLanguage : setting).toLowerCase();
  if (requested === 'zh' || requested.startsWith('zh-')) {
    return TRADITIONAL_CHINESE.test(requested) ? 'zh-tw' : 'zh-cn';
  }
  const base = requested.split('-')[0] ?? '';
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(base) ? (base as UiLanguage) : 'en';
}

/** Replaces `{0}`, `{1}`, … like `vscode.l10n.t`. Placeholders without an argument are kept. */
export function formatMessage(template: string, args: ReadonlyArray<string | number | boolean>): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}
