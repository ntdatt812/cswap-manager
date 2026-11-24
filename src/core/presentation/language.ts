/** UI languages with a bundle in `l10n/`. English strings are the keys themselves. */
export const SUPPORTED_LANGUAGES = ['en', 'vi'] as const;
export type UiLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Maps a setting value or a VS Code locale (`vi`, `vi-VN`, `en-US`, …) to a supported language. */
export function resolveLanguage(setting: string | undefined, displayLanguage: string): UiLanguage {
  const requested = (setting === undefined || setting === 'auto' ? displayLanguage : setting).toLowerCase();
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
