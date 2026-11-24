/**
 * `npm run l10n:extract` — writes l10n/bundle.l10n.json (English source strings, key = value) and
 * lists keys missing from or unused in each translated bundle.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECT_ROOT, scanMessages } from './l10nKeys';

const { keys, nonLiteral } = scanMessages();
const sorted = [...keys.keys()].sort((a, b) => a.localeCompare(b));
const dir = path.join(PROJECT_ROOT, 'l10n');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'bundle.l10n.json'), `${JSON.stringify(Object.fromEntries(sorted.map((key) => [key, key])), null, 2)}\n`);
console.log(`${sorted.length} messages → l10n/bundle.l10n.json`);
if (nonLiteral.length > 0) {
  console.log(`Non-literal translator calls: ${nonLiteral.join(', ')}`);
}
for (const file of fs.readdirSync(dir).filter((name) => /^bundle\.l10n\.[a-z-]+\.json$/.test(name))) {
  const bundle = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, string>;
  const missing = sorted.filter((key) => !(key in bundle));
  const unused = Object.keys(bundle).filter((key) => !keys.has(key));
  console.log(`${file}: ${missing.length} missing, ${unused.length} unused`);
  missing.forEach((key) => console.log(`  missing: ${JSON.stringify(key)}`));
  unused.forEach((key) => console.log(`  unused: ${JSON.stringify(key)}`));
}
