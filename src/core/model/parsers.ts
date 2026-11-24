import { compact } from './compact';
import { isRecord, parseJsonDocument } from './json';
import type {
  Account,
  AccountFields,
  AccountRef,
  AccountUsage,
  CliErrorEnvelope,
  ListPayload,
  ParseWarning,
  ParseWarningCode,
  PlanInfo,
  ScopedUsage,
  StatusActiveAccount,
  StatusPayload,
  SwitchResult,
  UsageMetrics,
  UsageWindow,
} from './types';

/** Schema versions whose shape has been observed and tested. Others are parsed best-effort. */
export const TESTED_SCHEMA_VERSIONS: readonly number[] = [1];

export type ParseFailureReason = 'invalid-json' | 'unexpected-shape';

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ParseFailureReason; readonly message: string };

class FieldReader {
  readonly warnings: ParseWarning[] = [];

  warn(code: ParseWarningCode, path: string): void {
    this.warnings.push({ code, path });
  }

  private present(record: Record<string, unknown>, key: string): boolean {
    return record[key] !== undefined && record[key] !== null;
  }

  number(record: Record<string, unknown>, key: string, path: string): number | undefined {
    if (!this.present(record, key)) {
      return undefined;
    }
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    this.warn('unexpected-type', `${path}.${key}`);
    return undefined;
  }

  string(record: Record<string, unknown>, key: string, path: string): string | undefined {
    if (!this.present(record, key)) {
      return undefined;
    }
    const value = record[key];
    if (typeof value === 'string') {
      return value.length > 0 ? value : undefined;
    }
    this.warn('unexpected-type', `${path}.${key}`);
    return undefined;
  }

  boolean(record: Record<string, unknown>, key: string, path: string): boolean | undefined {
    if (!this.present(record, key)) {
      return undefined;
    }
    const value = record[key];
    if (typeof value === 'boolean') {
      return value;
    }
    this.warn('unexpected-type', `${path}.${key}`);
    return undefined;
  }

  timestamp(record: Record<string, unknown>, key: string, path: string): string | undefined {
    const value = this.string(record, key, path);
    if (value === undefined) {
      return undefined;
    }
    const epoch = Date.parse(value);
    if (Number.isNaN(epoch)) {
      this.warn('invalid-timestamp', `${path}.${key}`);
      return undefined;
    }
    return new Date(epoch).toISOString();
  }

  slot(record: Record<string, unknown>, path: string): number | undefined {
    const value = this.number(record, 'number', path);
    if (value === undefined) {
      return undefined;
    }
    if (!Number.isInteger(value) || value < 0) {
      this.warn('unexpected-type', `${path}.number`);
      return undefined;
    }
    return value;
  }

  record(record: Record<string, unknown>, key: string, path: string): Record<string, unknown> | undefined {
    if (!this.present(record, key)) {
      return undefined;
    }
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
    this.warn('unexpected-type', `${path}.${key}`);
    return undefined;
  }
}

const USAGE_METRIC_KEYS = ['pct', 'resetsAt'] as const;

function looksLikeUsageMetrics(value: Record<string, unknown>): boolean {
  return USAGE_METRIC_KEYS.some((key) => key in value);
}

function readMetrics(reader: FieldReader, raw: Record<string, unknown>, path: string): UsageMetrics {
  return compact<UsageMetrics>({
    pct: reader.number(raw, 'pct', path),
    resetsAt: reader.timestamp(raw, 'resetsAt', path),
    countdown: reader.string(raw, 'countdown', path),
    clock: reader.string(raw, 'clock', path),
    expectedPct: reader.number(raw, 'expectedPct', path),
    aheadOfPace: reader.boolean(raw, 'aheadOfPace', path),
    projectedExhaustionAt: reader.timestamp(raw, 'projectedExhaustionAt', path),
    willLastToReset: reader.boolean(raw, 'willLastToReset', path),
    used: reader.number(raw, 'used', path),
    limit: reader.number(raw, 'limit', path),
    currency: reader.string(raw, 'currency', path),
  });
}

function readUsage(reader: FieldReader, raw: Record<string, unknown>, path: string): AccountUsage {
  const windows: UsageWindow[] = [];
  const scoped: ScopedUsage[] = [];
  let rejected: AccountUsage['rejected'];

  for (const [key, value] of Object.entries(raw)) {
    const windowPath = `${path}.${key}`;
    if (key === 'rejected') {
      // A quota refusal marker, not a usage window, even though it carries resetsAt.
      if (isRecord(value)) {
        rejected = compact<NonNullable<AccountUsage['rejected']>>({
          resetsAt: reader.timestamp(value, 'resetsAt', windowPath),
          retryAfterSeconds: reader.number(value, 'retryAfterS', windowPath),
        });
      }
      continue;
    }
    if (key === 'scoped') {
      if (value === null || value === undefined) {
        continue;
      }
      if (!Array.isArray(value)) {
        reader.warn('unexpected-type', windowPath);
        continue;
      }
      value.forEach((entry: unknown, index) => {
        const entryPath = `${windowPath}[${index}]`;
        if (!isRecord(entry)) {
          reader.warn('unexpected-type', entryPath);
          return;
        }
        const name = reader.string(entry, 'name', entryPath);
        if (name === undefined) {
          reader.warn('scope-without-name', entryPath);
          return;
        }
        scoped.push({ name, ...readMetrics(reader, entry, entryPath) });
      });
      continue;
    }
    // Any object with usage metrics is a window, whatever its key; other fields are ignored so
    // that unknown future additions do not break parsing.
    if (isRecord(value) && looksLikeUsageMetrics(value)) {
      windows.push({ key, ...readMetrics(reader, value, windowPath) });
    }
  }
  return rejected === undefined ? { windows, scoped } : { windows, scoped, rejected };
}

function readPlan(reader: FieldReader, raw: Record<string, unknown>, path: string): PlanInfo {
  return compact<PlanInfo>({
    label: reader.string(raw, 'label', path),
    displayName: reader.string(raw, 'planDisplayName', path),
    tier: reader.string(raw, 'tier', path),
    organizationType: reader.string(raw, 'organizationType', path),
    billingType: reader.string(raw, 'billingType', path),
    subscriptionStatus: reader.string(raw, 'subscriptionStatus', path),
    expired: reader.boolean(raw, 'expired', path),
    fetchedAt: reader.timestamp(raw, 'fetchedAt', path),
  });
}

function readAccountFields(reader: FieldReader, raw: Record<string, unknown>, path: string): AccountFields {
  const usage = reader.record(raw, 'usage', path);
  const plan = reader.record(raw, 'plan', path);
  const lastGood = reader.record(raw, 'lastGoodUsage', path);
  return compact<AccountFields>({
    email: reader.string(raw, 'email', path),
    alias: reader.string(raw, 'alias', path),
    disabled: reader.boolean(raw, 'disabled', path),
    organizationName: reader.string(raw, 'organizationName', path),
    organizationUuid: reader.string(raw, 'organizationUuid', path),
    isOrganization: reader.boolean(raw, 'isOrganization', path),
    activeFlag: reader.boolean(raw, 'active', path),
    managed: reader.boolean(raw, 'managed', path),
    usageStatus: reader.string(raw, 'usageStatus', path),
    usage: usage === undefined ? undefined : readUsage(reader, usage, `${path}.usage`),
    loginExpiresAt: reader.timestamp(raw, 'loginExpiresAt', path),
    plan: plan === undefined ? undefined : readPlan(reader, plan, `${path}.plan`),
    usageFetchedAt: reader.timestamp(raw, 'usageFetchedAt', path),
    usageAgeSeconds: reader.number(raw, 'usageAgeSeconds', path),
    lastGoodUsage: lastGood === undefined ? undefined : readUsage(reader, lastGood, `${path}.lastGoodUsage`),
    lastGoodFetchedAt: reader.timestamp(raw, 'lastGoodFetchedAt', path),
    lastGoodAgeSeconds: reader.number(raw, 'lastGoodAgeSeconds', path),
    usageError: reader.string(raw, 'usageError', path),
    usageRetryAt: reader.timestamp(raw, 'usageRetryAt', path),
    threshold: reader.number(raw, 'threshold', path),
  });
}

function readSchemaVersion(reader: FieldReader, root: Record<string, unknown>): number | undefined {
  const version = reader.number(root, 'schemaVersion', '$');
  if (version === undefined) {
    reader.warn('schema-version-missing', '$.schemaVersion');
  } else if (!TESTED_SCHEMA_VERSIONS.includes(version)) {
    reader.warn('schema-version-untested', '$.schemaVersion');
  }
  return version;
}

function parseRoot(stdout: string, reader: FieldReader): ParseResult<Record<string, unknown>> {
  const document = parseJsonDocument(stdout);
  if (!document.ok) {
    return { ok: false, reason: 'invalid-json', message: 'The CLI output is not valid JSON.' };
  }
  if (!isRecord(document.value)) {
    return { ok: false, reason: 'unexpected-shape', message: 'The CLI output is not a JSON object.' };
  }
  if (document.leadingNoise) {
    reader.warn('leading-noise', '$');
  }
  return { ok: true, value: document.value };
}

/** Parses `cswap list --json`. Accounts without a usable slot are skipped with a warning. */
export function parseListOutput(stdout: string): ParseResult<ListPayload> {
  const reader = new FieldReader();
  const root = parseRoot(stdout, reader);
  if (!root.ok) {
    return root;
  }
  const rawAccounts = root.value['accounts'];
  if (!Array.isArray(rawAccounts)) {
    return { ok: false, reason: 'unexpected-shape', message: 'The list output has no "accounts" array.' };
  }

  const schemaVersion = readSchemaVersion(reader, root.value);
  const activeAccountNumber = reader.number(root.value, 'activeAccountNumber', '$');
  const bySlot = new Map<number, Account>();

  rawAccounts.forEach((entry: unknown, index) => {
    const path = `$.accounts[${index}]`;
    if (!isRecord(entry)) {
      reader.warn('unexpected-type', path);
      return;
    }
    const slot = reader.slot(entry, path);
    if (slot === undefined) {
      reader.warn('account-without-slot', path);
      return;
    }
    if (bySlot.has(slot)) {
      reader.warn('duplicate-slot', path);
      return;
    }
    bySlot.set(slot, { slot, ...readAccountFields(reader, entry, path) });
  });

  const accounts = [...bySlot.values()].sort((a, b) => a.slot - b.slot);
  return {
    ok: true,
    value: {
      ...compact<Omit<ListPayload, 'accounts' | 'warnings'>>({
        schemaVersion,
        activeAccountNumber: activeAccountNumber !== undefined && Number.isInteger(activeAccountNumber) ? activeAccountNumber : undefined,
      }),
      accounts,
      warnings: reader.warnings,
    },
  };
}

/** Parses `cswap status --json`. A missing or null `active` means no active account is reported. */
export function parseStatusOutput(stdout: string): ParseResult<StatusPayload> {
  const reader = new FieldReader();
  const root = parseRoot(stdout, reader);
  if (!root.ok) {
    return root;
  }
  const schemaVersion = readSchemaVersion(reader, root.value);
  const rawActive = reader.record(root.value, 'active', '$');
  let active: StatusActiveAccount | undefined;
  if (rawActive !== undefined) {
    const slot = reader.slot(rawActive, '$.active');
    active = { ...compact<{ slot: number }>({ slot }), ...readAccountFields(reader, rawActive, '$.active') };
  }
  const total = reader.number(root.value, 'totalManagedAccounts', '$');

  return {
    ok: true,
    value: {
      ...compact<Omit<StatusPayload, 'warnings'>>({
        schemaVersion,
        active,
        totalManagedAccounts: total !== undefined && Number.isInteger(total) && total >= 0 ? total : undefined,
      }),
      warnings: reader.warnings,
    },
  };
}

function readAccountRef(reader: FieldReader, root: Record<string, unknown>, key: string): AccountRef | undefined {
  const raw = reader.record(root, key, '$');
  if (raw === undefined) {
    return undefined;
  }
  return compact<AccountRef>({ slot: reader.slot(raw, `$.${key}`), email: reader.string(raw, 'email', `$.${key}`) });
}

/** Parses `cswap switch ... --json`. `switched` is required; everything else is optional. */
export function parseSwitchOutput(stdout: string): ParseResult<SwitchResult> {
  const reader = new FieldReader();
  const root = parseRoot(stdout, reader);
  if (!root.ok) {
    return root;
  }
  const switched = reader.boolean(root.value, 'switched', '$');
  if (switched === undefined) {
    return { ok: false, reason: 'unexpected-shape', message: 'The switch output has no "switched" flag.' };
  }
  const rawWarnings = root.value['warnings'];
  const warnings = Array.isArray(rawWarnings) ? rawWarnings.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    ok: true,
    value: {
      ...compact<Omit<SwitchResult, 'switched' | 'warnings'>>({
        schemaVersion: reader.number(root.value, 'schemaVersion', '$'),
        from: readAccountRef(reader, root.value, 'from'),
        to: readAccountRef(reader, root.value, 'to'),
        strategy: reader.string(root.value, 'strategy', '$'),
        reason: reader.string(root.value, 'reason', '$'),
      }),
      switched,
      warnings,
    },
  };
}

/** Recognizes the CLI's handled-error envelope; returns undefined for any other output. */
export function parseErrorEnvelope(stdout: string): CliErrorEnvelope | undefined {
  const document = parseJsonDocument(stdout);
  if (!document.ok || !isRecord(document.value) || !isRecord(document.value['error'])) {
    return undefined;
  }
  const reader = new FieldReader();
  const error = document.value['error'];
  return compact<CliErrorEnvelope>({ type: reader.string(error, 'type', '$.error'), message: reader.string(error, 'message', '$.error') });
}
