import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { formatMessage, LANGUAGE_LOCALES, resolveLanguage, SUPPORTED_LANGUAGES } from '../../src/core/presentation/language';
import { LANGUAGE_SETTINGS } from '../../src/core/presentation/quickSettings';
import { PROJECT_ROOT, placeholders, readBundle, scanMessages } from '../helpers/l10nKeys';

const scan = scanMessages();
const TRANSLATED = SUPPORTED_LANGUAGES.filter((language) => language !== 'en');
/** Icons (`$(sync)`), setting links (`#cswapManager.x#`) and command links must survive translation unchanged. */
const tokens = (text: string) => (text.match(/\$\([a-z0-9-]+\)|#cswapManager\.[A-Za-z.]+#|\(command:[^)]+\)/g) ?? []).sort().join();

describe('localization', () => {
  it('only passes string literals to the translator, so every message can be extracted', () => {
    assert.deepEqual(scan.nonLiteral, []);
    assert.ok(scan.keys.size > 200, `found ${scan.keys.size} messages`);
  });

  it('offers every translated language in the language setting', () => {
    for (const language of TRANSLATED) {
      assert.ok((LANGUAGE_SETTINGS as readonly string[]).includes(language), language);
      assert.ok(LANGUAGE_LOCALES[language], language);
    }
  });

  for (const language of TRANSLATED) {
    describe(language, () => {
      const bundle = readBundle(language);

      it('translates every UI message', () => {
        const missing = [...scan.keys.keys()].filter((key) => typeof bundle[key] !== 'string' || bundle[key].trim() === '');
        assert.deepEqual(missing, []);
      });

      it('keeps the same {n} placeholders, icons and links in every translation', () => {
        const broken = Object.entries(bundle)
          .filter(([key]) => scan.keys.has(key))
          .filter(([key, value]) => placeholders(key).join() !== placeholders(value).join() || tokens(key) !== tokens(value))
          .map(([key]) => key);
        assert.deepEqual(broken, []);
      });

      it('has no stale translations for messages that no longer exist', () => {
        const unused = Object.keys(bundle).filter((key) => !scan.keys.has(key));
        assert.deepEqual(unused, []);
      });

      it(`translates every contributed string (package.nls.${language}.json) with the same command and setting links`, () => {
        const base = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.nls.json'), 'utf8')) as Record<string, string>;
        const translated = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, `package.nls.${language}.json`), 'utf8')) as Record<string, string>;
        assert.deepEqual(Object.keys(translated).sort(), Object.keys(base).sort());
        for (const [key, value] of Object.entries(base)) {
          assert.equal(tokens(translated[key] ?? ''), tokens(value), key);
        }
      });
    });
  }
});

describe('language selection and formatting', () => {
  it('resolves the setting or VS Code locale to a supported language', () => {
    assert.equal(resolveLanguage('auto', 'vi'), 'vi');
    assert.equal(resolveLanguage('auto', 'vi-VN'), 'vi');
    assert.equal(resolveLanguage('auto', 'en-US'), 'en');
    assert.equal(resolveLanguage('auto', 'fr'), 'en');
    assert.equal(resolveLanguage('vi', 'en'), 'vi');
    assert.equal(resolveLanguage('en', 'vi'), 'en');
    assert.equal(resolveLanguage(undefined, 'vi'), 'vi');
    assert.equal(resolveLanguage('xx', 'vi'), 'en');
  });

  it('tells Simplified from Traditional Chinese, and reads Japanese and Korean locales', () => {
    assert.equal(resolveLanguage('auto', 'zh-cn'), 'zh-cn');
    assert.equal(resolveLanguage('auto', 'zh'), 'zh-cn');
    assert.equal(resolveLanguage('auto', 'zh-SG'), 'zh-cn');
    assert.equal(resolveLanguage('auto', 'zh-tw'), 'zh-tw');
    assert.equal(resolveLanguage('auto', 'zh-HK'), 'zh-tw');
    assert.equal(resolveLanguage('auto', 'zh-Hant-TW'), 'zh-tw');
    assert.equal(resolveLanguage('auto', 'ja'), 'ja');
    assert.equal(resolveLanguage('auto', 'ko-KR'), 'ko');
    assert.equal(resolveLanguage('zh-tw', 'en'), 'zh-tw');
  });

  it('formats positional placeholders like vscode.l10n.t', () => {
    assert.equal(formatMessage('Slot {0} → {1}', [2, 'work']), 'Slot 2 → work');
    assert.equal(formatMessage('{1}/{0}', ['a', 'b']), 'b/a');
    assert.equal(formatMessage('keep {3}', ['a']), 'keep {3}');
  });
});
