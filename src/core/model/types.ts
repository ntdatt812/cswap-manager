/**
 * Normalized, CLI-version-tolerant data model. Every field the CLI may omit is optional;
 * `undefined` always means "the CLI did not provide this value" (unknown), never zero or false.
 * Timestamps are normalized ISO-8601 strings (UTC) so snapshots stay serializable.
 */

export interface UsageMetrics {
  /** Percentage of the window consumed, as reported by the CLI (not clamped). */
  readonly pct?: number;
  readonly resetsAt?: string;
  /** Human countdown text computed by the CLI at fetch time; prefer `resetsAt` for live values. */
  readonly countdown?: string;
  /** Human local reset time computed by the CLI at fetch time. */
  readonly clock?: string;
  readonly expectedPct?: number;
  readonly aheadOfPace?: boolean;
  readonly projectedExhaustionAt?: string;
  readonly willLastToReset?: boolean;
  /** Money fields of a spend window (e.g. `spend`): amount used, limit and currency code. */
  readonly used?: number;
  readonly limit?: number;
  readonly currency?: string;
}

/** A usage window keyed by the CLI's own property name (e.g. `sevenDay`); keys are not hard-coded. */
export interface UsageWindow extends UsageMetrics {
  readonly key: string;
}

/** A scoped (e.g. per-model) usage entry; `name` comes straight from the CLI. */
export interface ScopedUsage extends UsageMetrics {
  readonly name: string;
}

export interface AccountUsage {
  /** Windows in the order the CLI emitted them. */
  readonly windows: readonly UsageWindow[];
  readonly scoped: readonly ScopedUsage[];
  /** The server refused this account for quota (setup-token probe readings). */
  readonly rejected?: { readonly resetsAt?: string; readonly retryAfterSeconds?: number };
}

export interface PlanInfo {
  readonly label?: string;
  readonly displayName?: string;
  readonly tier?: string;
  readonly organizationType?: string;
  readonly billingType?: string;
  readonly subscriptionStatus?: string;
  readonly expired?: boolean;
  readonly fetchedAt?: string;
}

export interface AccountFields {
  readonly email?: string;
  /** Short display alias set with `cswap alias` (emitted by `list --json` only when set). */
  readonly alias?: string;
  /** Held out of auto-rotation with `cswap disable` (emitted only when true). */
  readonly disabled?: boolean;
  readonly organizationName?: string;
  readonly organizationUuid?: string;
  readonly isOrganization?: boolean;
  /** Raw per-account `active` flag from `list`; use the snapshot's resolved active slot for display. */
  readonly activeFlag?: boolean;
  readonly managed?: boolean;
  /** Raw usage status string (observed: `ok`); other values are passed through unchanged. */
  readonly usageStatus?: string;
  readonly usage?: AccountUsage;
  readonly loginExpiresAt?: string;
  readonly plan?: PlanInfo;
  readonly usageFetchedAt?: string;
  /** Age of the usage data in seconds as reported by the CLI at command time. */
  readonly usageAgeSeconds?: number;
  /** Display-grade last known usage, emitted when `usage` is null. Never treat it as current. */
  readonly lastGoodUsage?: AccountUsage;
  readonly lastGoodFetchedAt?: string;
  readonly lastGoodAgeSeconds?: number;
  /** Last usage fetch failure kind (e.g. `http-429`) for an `unavailable` row. */
  readonly usageError?: string;
  readonly usageRetryAt?: string;
  /** Per-account switch-away threshold (percent) set with `cswap threshold`. */
  readonly threshold?: number;
}

/** An account managed by cswap. `slot` (the CLI's `number`) is the identity used for ordering. */
export interface Account extends AccountFields {
  readonly slot: number;
}

/** `status.active` may describe an unmanaged login, so its slot is optional. */
export interface StatusActiveAccount extends AccountFields {
  readonly slot?: number;
}

export type ParseWarningCode =
  | 'schema-version-missing'
  | 'schema-version-untested'
  | 'unexpected-type'
  | 'invalid-timestamp'
  | 'account-without-slot'
  | 'duplicate-slot'
  | 'scope-without-name'
  | 'leading-noise';

/** Parse warnings carry a JSON path and a code, never the offending value (which may be sensitive). */
export interface ParseWarning {
  readonly code: ParseWarningCode;
  readonly path: string;
}

export interface ListPayload {
  readonly schemaVersion?: number;
  readonly activeAccountNumber?: number;
  /** Sorted ascending by slot. */
  readonly accounts: readonly Account[];
  readonly warnings: readonly ParseWarning[];
}

export interface StatusPayload {
  readonly schemaVersion?: number;
  /** `undefined` when the CLI reports no active account (or omits it). */
  readonly active?: StatusActiveAccount;
  readonly totalManagedAccounts?: number;
  readonly warnings: readonly ParseWarning[];
}

export type ActiveConsistency = 'consistent' | 'conflict' | 'unknown';

export interface ActiveResolution {
  /** Resolved active slot; undefined when unknown or when the sources conflict irreconcilably. */
  readonly slot?: number;
  readonly consistency: ActiveConsistency;
  /** Whether `status --json` contributed to this resolution. */
  readonly verifiedWithStatus: boolean;
  /** `status` reported an active login that cswap does not manage. */
  readonly activeUnmanaged?: boolean;
}

/** Account reference used by `switch --json` for `from`/`to`; either side may be null. */
export interface AccountRef {
  readonly slot?: number;
  readonly email?: string;
}

/** Normalized `cswap switch --json` result. */
export interface SwitchResult {
  readonly schemaVersion?: number;
  readonly switched: boolean;
  readonly from?: AccountRef;
  readonly to?: AccountRef;
  /** `direct` for a slot switch, otherwise the strategy label. */
  readonly strategy?: string;
  /** Observed/known: switched, already-active, already-best, candidates-exhausted, ... (open set). */
  readonly reason?: string;
  readonly warnings: readonly string[];
}

/** `{"schemaVersion":1,"error":{"type","message"}}` printed on a handled CLI error (exit 1). */
export interface CliErrorEnvelope {
  readonly type?: string;
  readonly message?: string;
}

export interface AccountsSnapshot {
  readonly schemaVersion?: number;
  /** Sorted ascending by slot. */
  readonly accounts: readonly Account[];
  readonly active: ActiveResolution;
  readonly totalManagedAccounts?: number;
  /** Epoch milliseconds when the CLI output was received. */
  readonly capturedAt: number;
  readonly warnings: readonly ParseWarning[];
}
