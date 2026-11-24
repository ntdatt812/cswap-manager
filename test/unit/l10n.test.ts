import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { formatMessage, resolveLanguage } from '../../src/core/presentation/language';
import { PROJECT_ROOT, placeholders, readBundle, scanMessages } from '../helpers/l10nKeys';

const scan = scanMessages();
const vi = readBundle('vi');

describe('localization', () => {
  it('only passes string literals to the translator, so every message can be extracted', () => {
    assert.deepEqual(scan.nonLiteral, []);
    assert.ok(scan.keys.size > 200, `found ${scan.keys.size} messages`);
  });

  it('has a Vietnamese translation for every UI message', () => {
    const missing = [...scan.keys.keys()].filter((key) => typeof vi[key] !== 'string' || vi[key].trim() === '');
    assert.deepEqual(missing, []);
  });

  it('keeps the same {n} placeholders in every translation', () => {
    const broken = Object.entries(vi)
      .filter(([key]) => scan.keys.has(key))
      .filter(([key, value]) => placeholders(key).join() !== placeholders(value).join())
      .map(([key]) => key);
    assert.deepEqual(broken, []);
  });

  it('has no stale translations for messages that no longer exist', () => {
    const unused = Object.keys(vi).filter((key) => !scan.keys.has(key));
    assert.deepEqual(unused, []);
  });

  it('translates every contributed string (package.nls.vi.json) with the same command links', () => {
    const base = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.nls.json'), 'utf8')) as Record<string, string>;
    const translated = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.nls.vi.json'), 'utf8')) as Record<string, string>;
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(base).sort());
    const links = (text: string) => (text.match(/\(command:[^)]+\)/g) ?? []).sort().join();
    for (const [key, value] of Object.entries(base)) {
      assert.equal(links(translated[key] ?? ''), links(value), key);
    }
  });
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

  it('formats positional placeholders like vscode.l10n.t', () => {
    assert.equal(formatMessage('Slot {0} → {1}', [2, 'work']), 'Slot 2 → work');
    assert.equal(formatMessage('{1}/{0}', ['a', 'b']), 'b/a');
    assert.equal(formatMessage('keep {3}', ['a']), 'keep {3}');
  });
});
