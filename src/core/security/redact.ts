const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const ANTHROPIC_KEY_PATTERN = /\bsk-ant-[A-Za-z0-9_-]+/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const OPAQUE_SECRET_PATTERN = /\b[A-Za-z0-9_-]{40,}\b/g;
/** Standard base64 blobs (with `+`, `/`, `=`) of token length. */
const BASE64_SECRET_PATTERN = /[A-Za-z0-9+/]{40,}={0,2}/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// User names may contain spaces, so the name runs to the next separator or quote.
const WINDOWS_PROFILE_PATTERN = /\b([A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])[^\\/\r\n"'<>|]+/gi;
const POSIX_PROFILE_PATTERN = /(^|[\s"'=:(])(\/(?:home|Users))\/[^/\s"'<>|]+/g;

export const REDACTED = {
  token: '<redacted-token>',
  email: '<email>',
  uuid: '<uuid>',
  user: '<user>',
} as const;

export interface RedactOptions {
  /** User home directory; occurrences are replaced with `~`. */
  readonly homeDir?: string;
  /** Truncate the result to this many characters. */
  readonly maxLength?: number;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceHomeDir(text: string, homeDir: string): string {
  const trimmed = homeDir.replace(/[\\/]+$/, '');
  if (trimmed.length < 3) {
    return text;
  }
  // Match the home directory with either separator style, case-insensitively (Windows paths).
  const pattern = escapeRegExp(trimmed).replace(/\\\\|\//g, '[\\\\/]');
  return text.replace(new RegExp(pattern, 'gi'), '~');
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Removes secrets and personal identifiers from free-form text before it is logged or shown in
 * diagnostics. Redaction is deliberately aggressive: false positives are acceptable, leaks are not.
 */
export function redactText(input: string, options: RedactOptions = {}): string {
  let text = stripAnsi(input);
  text = text
    .replace(JWT_PATTERN, REDACTED.token)
    .replace(ANTHROPIC_KEY_PATTERN, REDACTED.token)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED.token}`)
    .replace(EMAIL_PATTERN, REDACTED.email)
    .replace(UUID_PATTERN, REDACTED.uuid)
    .replace(OPAQUE_SECRET_PATTERN, REDACTED.token)
    .replace(BASE64_SECRET_PATTERN, REDACTED.token);
  if (options.homeDir) {
    text = replaceHomeDir(text, options.homeDir);
  }
  text = text
    .replace(WINDOWS_PROFILE_PATTERN, `$1${REDACTED.user}`)
    .replace(POSIX_PROFILE_PATTERN, `$1$2/${REDACTED.user}`);
  return options.maxLength === undefined ? text : truncate(text, options.maxLength);
}

/**
 * Returns one redacted, truncated line of multi-line output: the first non-empty line (notices) or
 * the last one (errors, where tools such as argparse and Python tracebacks put the actual message).
 */
export function redactLine(input: string, which: 'first' | 'last', options: RedactOptions = {}): string | undefined {
  const lines = stripAnsi(input)
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);
  const line = which === 'first' ? lines[0] : lines[lines.length - 1];
  if (line === undefined) {
    return undefined;
  }
  return redactText(line, { maxLength: 200, ...options });
}

/**
 * VS Code renders `[label](target)` in notification and progress text as a link, including
 * `command:` links. Text that may contain CLI-derived values goes through this before display so
 * it can never become a clickable link.
 */
export function neutralizeLinks(text: string): string {
  return text.replace(/\]\s*\(/g, ']\u200b(').replace(/\b(command|vscode|file|https?):/gi, '$1\u200b:');
}
