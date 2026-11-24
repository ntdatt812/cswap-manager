/** Bounds the line-based recovery so pathological output cannot stall the extension host. */
const MAX_RECOVERY_ATTEMPTS = 5;

export type JsonDocumentResult =
  | { readonly ok: true; readonly value: unknown; readonly leadingNoise: boolean }
  | { readonly ok: false };

/**
 * Parses CLI stdout as a single JSON document. If the whole text is not JSON, it retries from each
 * line that starts with `{` or `[`, tolerating banners/notices printed before the payload.
 */
export function parseJsonDocument(text: string): JsonDocumentResult {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (trimmed.length === 0) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown, leadingNoise: false };
  } catch {
    // Fall through to line-based recovery.
  }

  const lines = trimmed.split(/\r?\n/);
  let attempts = 0;
  for (let index = 1; index < lines.length && attempts < MAX_RECOVERY_ATTEMPTS; index++) {
    const line = lines[index]?.trimStart() ?? '';
    if (!line.startsWith('{') && !line.startsWith('[')) {
      continue;
    }
    attempts++;
    try {
      const value = JSON.parse(lines.slice(index).join('\n')) as unknown;
      return { ok: true, value, leadingNoise: true };
    } catch {
      // Keep scanning.
    }
  }
  return { ok: false };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
