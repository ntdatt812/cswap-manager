/**
 * UI languages with a bundle in `l10n/`, named by VS Code's locale ids (`bundle.l10n.zh-cn.json`).
 * English strings are the keys themselves.
 */
export const SUPPORTED_LANGUAGES = ['en', 'vi', 'zh-cn', 'zh-tw', 'ja', 'ko'] as const;
export type UiLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Chinese locales written in Traditional characters; every other `zh` locale gets Simplified. */
const TRADITIONAL_CHINESE = /^zh-(tw|hk|mo|hant)(-|$)/;

/** Locale for dates and numbers in each translated language. */
export const LANGUAGE_LOCALES: Readonly<Record<Exclude<UiLanguage, 'en'>, string>> = {
  vi: 'vi-VN',
  'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW',
  ja: 'ja-JP',
  ko: 'ko-KR',
};

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
