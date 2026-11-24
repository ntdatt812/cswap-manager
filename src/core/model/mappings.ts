/**
 * Directory → account mappings (`cswap map`), used by a bare `cswap run` in that directory. cswap
 * 1.2.0 has no JSON for them; the list format below was verified in switcher.py.
 */
export interface MappingEntry {
  /** As cswap prints it (on Windows: lower case, backslashes). */
  readonly path: string;
  /** Undefined when cswap prints "(account removed)". */
  readonly slot?: number;
}

/**
 * Reads `cswap map` (no arguments). Verified output (switcher.py): `Directory mappings:` then rows
 * `  <path> → N: <email>[ org tag]` or `  <path> → <email> (account removed)`, or
 * `No directory mappings yet.` Returns undefined for anything else, so a changed format is never misread.
 */
export function parseMappingList(stdout: string): MappingEntry[] | undefined {
  const text = stdout.replace(/\r/g, '');
  if (/No directory mappings yet/i.test(text)) {
    return [];
  }
  if (!/^\s*Directory mappings:/im.test(text)) {
    return undefined;
  }
  const entries: MappingEntry[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s+(.+?)\s+→\s+(?:(\d+):|\S+ \(account removed\))/.exec(line);
    if (match !== null && match[1] !== undefined) {
      entries.push({ path: match[1].trim(), ...(match[2] === undefined ? {} : { slot: Number(match[2]) }) });
    }
  }
  return entries;
}

/** Compares paths the way cswap stores them on this platform (Windows: case-insensitive, `\\`). */
export function comparablePath(path: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return platform === 'win32' ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
}

/** The folder's own entry, not a parent's: what `cswap unmap <folder>` removes. */
export function ownMapping(folder: string, entries: readonly MappingEntry[], platform: NodeJS.Platform = process.platform): MappingEntry | undefined {
  const target = comparablePath(folder, platform);
  return entries.find((entry) => comparablePath(entry.path, platform) === target);
}

/** The mapping that applies to a folder: the longest mapped parent wins, like cswap's lookup. */
export function mappingFor(folder: string, entries: readonly MappingEntry[], platform: NodeJS.Platform = process.platform): MappingEntry | undefined {
  const target = comparablePath(folder, platform);
  const separator = platform === 'win32' ? '\\' : '/';
  return entries
    .filter((entry) => {
      const base = comparablePath(entry.path, platform);
      return target === base || target.startsWith(`${base}${separator}`);
    })
    .sort((a, b) => b.path.length - a.path.length)[0];
}
