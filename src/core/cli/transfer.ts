import { isValidSlot } from '../model/accountPolicy';
import type { ParseResult } from '../model/parsers';

/**
 * `cswap export` / `import` / `import-usage` (cswap 1.2.0, transfer.py). None has JSON output: the
 * results are the stderr lines read below. The extension never opens the files: cswap reads and
 * writes them, and a path is always passed, never "-", so logins never pass through a pipe here.
 */

/**
 * A path argument for cswap: absolute, so it can never be "-" (stdin/stdout), never readable as a
 * flag, and without control characters.
 */
export function isSafePathArgument(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith('-') || /[\u0000-\u001f]/.test(path)) {
    return false;
  }
  return platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') : path.startsWith('/');
}

export interface ExportResult {
  readonly exported: number;
  /** Slots cswap skipped because it had no stored login or config for them. */
  readonly skipped: number;
}

export interface ImportResult {
  readonly imported: number;
  /** Replaced because the user asked to (`--force`). */
  readonly overwritten: number;
  /** Replaced by cswap itself: the stored login there was dead. */
  readonly replaced: number;
  readonly skipped: number;
  /** Set when the import rewrote the stored login of the account Claude Code is logged in to now. */
  readonly liveSlot?: number;
}

export interface UsageImportResult {
  readonly adopted: number;
  /** Matched, but this machine's own reading was newer. */
  readonly kept: number;
  /** Not managed here, or without usage. */
  readonly skipped: number;
}

export function exportArgs(path: string, slot?: number): readonly string[] | undefined {
  if (!isSafePathArgument(path) || (slot !== undefined && !isValidSlot(slot))) {
    return undefined;
  }
  return slot === undefined ? ['export', path] : ['export', path, '--account', String(slot)];
}

export function importArgs(path: string, replaceExisting: boolean): readonly string[] | undefined {
  if (!isSafePathArgument(path)) {
    return undefined;
  }
  return replaceExisting ? ['import', path, '--force'] : ['import', path];
}

/** `holdSeconds`: undefined leaves an earlier hold as it is, 0 lifts it. */
export function importUsageArgs(path: string, holdSeconds?: number): readonly string[] | undefined {
  if (!isSafePathArgument(path)) {
    return undefined;
  }
  if (holdSeconds === undefined) {
    return ['import-usage', path];
  }
  return Number.isSafeInteger(holdSeconds) && holdSeconds >= 0 && holdSeconds <= 86_400 ? ['import-usage', path, '--hold', String(holdSeconds)] : undefined;
}

/** `Exported N account(s) to <path>`, after one `Skipping Account-N …` line per skipped slot. */
export function parseExportOutput(stderr: string): ParseResult<ExportResult> {
  const done = /Exported (\d+) account\(s\)/.exec(stderr);
  if (done === null) {
    return { ok: false, reason: 'unexpected-shape', message: 'cswap export did not report a result.' };
  }
  return { ok: true, value: { exported: Number(done[1]), skipped: stderr.match(/^Skipping Account-\d+/gm)?.length ?? 0 } };
}

/** `Done: A imported, B overwritten, C skipped[, D replaced (dead token)]`, then an optional live-login note. */
export function parseImportOutput(stderr: string): ParseResult<ImportResult> {
  const done = /Done: (\d+) imported, (\d+) overwritten, (\d+) skipped(?:, (\d+) replaced)?/.exec(stderr);
  if (done === null) {
    return { ok: false, reason: 'unexpected-shape', message: 'cswap import did not report a result.' };
  }
  const live = /--switch-to (\d+) --force/.exec(stderr);
  return {
    ok: true,
    value: {
      imported: Number(done[1]),
      overwritten: Number(done[2]),
      skipped: Number(done[3]),
      replaced: Number(done[4] ?? 0),
      ...(live === null ? {} : { liveSlot: Number(live[1]) }),
    },
  };
}

/** `Done: A adopted, B kept, C skipped[; …]`. */
export function parseImportUsageOutput(stderr: string): ParseResult<UsageImportResult> {
  const done = /Done: (\d+) adopted, (\d+) kept, (\d+) skipped/.exec(stderr);
  if (done === null) {
    return { ok: false, reason: 'unexpected-shape', message: 'cswap import-usage did not report a result.' };
  }
  return { ok: true, value: { adopted: Number(done[1]), kept: Number(done[2]), skipped: Number(done[3]) } };
}
