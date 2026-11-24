import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/** Compiled helpers live in out/test/helpers; the project root is three levels up. */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Files allowed to call the translator with a non-literal (they are the translator wrappers). */
const WRAPPER_FILES = new Set(['src/vscode/l10n.ts', 'src/vscode/presentation.ts']);

export interface MessageScan {
  /** Message key → `file:line` locations. */
  readonly keys: Map<string, string[]>;
  /** Translator calls whose first argument is not a string literal (cannot be translated). */
  readonly nonLiteral: string[];
}

function listSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listSources(full);
    }
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function isTranslatorCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text === 't' || callee.text === 'localize';
  }
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 't';
}

/** Finds every `t('…')`, `options.t('…')` and `localize('…')` call under src/. */
export function scanMessages(root = PROJECT_ROOT): MessageScan {
  const keys = new Map<string, string[]>();
  const nonLiteral: string[] = [];
  for (const file of listSources(path.join(root, 'src'))) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isTranslatorCall(node)) {
        const first = node.arguments[0];
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const where = `${relative}:${line}`;
        if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          keys.set(first.text, [...(keys.get(first.text) ?? []), where]);
        } else if (!WRAPPER_FILES.has(relative)) {
          nonLiteral.push(where);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { keys, nonLiteral };
}

export function placeholders(text: string): string[] {
  return [...new Set(text.match(/\{\d+\}/g) ?? [])].sort();
}

export function readBundle(language: string, root = PROJECT_ROOT): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(root, 'l10n', `bundle.l10n.${language}.json`), 'utf8')) as Record<string, string>;
}
