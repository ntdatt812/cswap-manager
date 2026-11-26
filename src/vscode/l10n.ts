import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatMessage, LANGUAGE_LOCALES, resolveLanguage, type UiLanguage } from '../core/presentation/language';

let language: UiLanguage = 'en';
let bundle: Readonly<Record<string, string>> = {};

function readBundle(extensionPath: string, lang: UiLanguage): Record<string, string> {
  if (lang === 'en') {
    return {};
  }
  try {
    const raw = fs.readFileSync(path.join(extensionPath, 'l10n', `bundle.l10n.${lang}.json`), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    // A missing or broken bundle falls back to English rather than breaking the UI.
    return {};
  }
}

/**
 * Loads the bundle for `cswapManager.language` (`auto` follows VS Code's display language). This is
 * separate from `vscode.l10n` so users can pick the extension's language without switching VS Code.
 * Command titles and settings descriptions still follow VS Code's own display language.
 */
export function configureLocalization(extensionPath: string, setting: string | undefined): UiLanguage {
  language = resolveLanguage(setting, vscode.env.language);
  bundle = readBundle(extensionPath, language);
  return language;
}

export function currentLanguage(): UiLanguage {
  return language;
}

/** BCP 47 locale for dates and numbers in the chosen UI language. */
export function currentLocale(): string {
  return language === 'en' ? vscode.env.language || 'en' : LANGUAGE_LOCALES[language];
}

export function localize(message: string, ...args: Array<string | number | boolean>): string {
  return formatMessage(bundle[message] ?? message, args);
}
