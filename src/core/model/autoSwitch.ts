import { isRecord } from './json';

/**
 * `cswap auto --once --json` (verified against cswap 1.2.0): one JSON object per line with an
 * `event` kind, and an exit code of 0 switched · 1 error · 2 no action · 3 blocked.
 * Only slot numbers and non-identifying fields are kept; emails are dropped on purpose.
 */
export type AutoEvent =
  | { readonly kind: 'poll'; readonly activeSlot?: number; readonly threshold?: number }
  | {
      readonly kind: 'switch';
      readonly trigger?: string;
      readonly fromSlot?: number;
      readonly toSlot?: number;
      readonly dryRun: boolean;
      readonly warningCount: number;
    }
  | { readonly kind: 'no-switch'; readonly reason?: string }
  | { readonly kind: 'account-quarantined'; readonly slot?: number; readonly reason?: string }
  | { readonly kind: 'account-unquarantined'; readonly slot?: number }
  | { readonly kind: 'all-exhausted'; readonly earliestResetAt?: string }
  | { readonly kind: 'error'; readonly message?: string; readonly transient: boolean }
  | { readonly kind: 'config-warning'; readonly message?: string }
  | { readonly kind: 'other'; readonly name: string };

export type AutoOutcome = 'switched' | 'error' | 'no-action' | 'blocked' | 'unknown';

export interface AutoTickResult {
  readonly exitCode: number | null;
  readonly outcome: AutoOutcome;
  readonly events: readonly AutoEvent[];
  readonly dryRun: boolean;
}

const OUTCOME_BY_EXIT: Readonly<Record<number, AutoOutcome>> = { 0: 'switched', 1: 'error', 2: 'no-action', 3: 'blocked' };

export function outcomeForExitCode(exitCode: number | null): AutoOutcome {
  return exitCode === null ? 'unknown' : (OUTCOME_BY_EXIT[exitCode] ?? 'unknown');
}

function slotOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  if (isRecord(value)) {
    return slotOf(value['number']);
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function withDefined<T extends object>(base: T, extra: Record<string, unknown>): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

export function parseAutoEvent(raw: unknown): AutoEvent | undefined {
  if (!isRecord(raw) || typeof raw['event'] !== 'string') {
    return undefined;
  }
  switch (raw['event']) {
    case 'poll':
      return withDefined<AutoEvent>({ kind: 'poll' }, {
        activeSlot: slotOf(raw['active']),
        threshold: typeof raw['threshold'] === 'number' ? raw['threshold'] : undefined,
      });
    case 'switch': {
      const warnings = raw['warnings'];
      return withDefined<AutoEvent>(
        { kind: 'switch', dryRun: raw['dryRun'] === true, warningCount: Array.isArray(warnings) ? warnings.length : 0 },
        { trigger: text(raw['trigger']), fromSlot: slotOf(raw['from']), toSlot: slotOf(raw['to']) },
      );
    }
    case 'no-switch':
      return withDefined<AutoEvent>({ kind: 'no-switch' }, { reason: text(raw['reason']) });
    case 'account-quarantined':
      return withDefined<AutoEvent>({ kind: 'account-quarantined' }, { slot: slotOf(raw['number']), reason: text(raw['reason']) });
    case 'account-unquarantined':
      return withDefined<AutoEvent>({ kind: 'account-unquarantined' }, { slot: slotOf(raw['number']) });
    case 'all-exhausted':
      return withDefined<AutoEvent>({ kind: 'all-exhausted' }, { earliestResetAt: text(raw['earliestResetAt']) });
    case 'error':
      return withDefined<AutoEvent>({ kind: 'error', transient: raw['transient'] !== false }, { message: text(raw['message']) });
    case 'config-warning':
      return withDefined<AutoEvent>({ kind: 'config-warning' }, { message: text(raw['message']) });
    default:
      return { kind: 'other', name: raw['event'] };
  }
}

/** Parses the JSON-lines stream; malformed lines are skipped rather than failing the tick. */
export function parseAutoEvents(stdout: string): AutoEvent[] {
  const events: AutoEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const event = parseAutoEvent(JSON.parse(trimmed) as unknown);
      if (event !== undefined) {
        events.push(event);
      }
    } catch {
      // Ignore a partial or non-JSON line.
    }
  }
  return events;
}

export function buildTickResult(stdout: string, exitCode: number | null, dryRun: boolean): AutoTickResult {
  const events = parseAutoEvents(stdout);
  // In a dry run, exit 0 means "would switch"; callers must check `dryRun` before treating it as done.
  const outcome = outcomeForExitCode(exitCode);
  return { exitCode, outcome, events, dryRun };
}

export function findEvent<K extends AutoEvent['kind']>(result: AutoTickResult, kind: K): Extract<AutoEvent, { kind: K }> | undefined {
  return result.events.find((event): event is Extract<AutoEvent, { kind: K }> => event.kind === kind);
}

/**
 * cswap settings from `cswap config --json list`: the auto-switch rules plus the few other settings
 * the extension shows. `undefined` means "not set / none".
 */
export interface AutoSwitchRules {
  readonly threshold?: number;
  readonly weeklyThreshold?: number;
  readonly intervalSeconds?: number;
  readonly cooldownSeconds?: number;
  readonly hysteresisPct?: number;
  readonly unhealthyTicks?: number;
  readonly strategy?: string;
  readonly model?: string;
  readonly includeApiKeyAccounts?: boolean;
  /** `run.shareHistory`: `cswap run` sessions share one conversation history. */
  readonly shareHistory?: boolean;
  /** `usage.headerProbe`: read setup-token accounts' usage with a 1-token Haiku request. */
  readonly headerProbe?: boolean;
  /** `usage.fableProbe`: with the header probe, also a 1-token Fable request for Fable's weekly limit. */
  readonly fableProbe?: boolean;
  /** Keys explicitly set by the user (others are cswap defaults). */
  readonly customized: readonly string[];
}

/** Expected JSON type of each rule; values of any other type are ignored. */
const RULE_TYPES: Readonly<Record<keyof Omit<AutoSwitchRules, 'customized'>, 'number' | 'string' | 'boolean'>> = {
  threshold: 'number',
  weeklyThreshold: 'number',
  intervalSeconds: 'number',
  cooldownSeconds: 'number',
  hysteresisPct: 'number',
  unhealthyTicks: 'number',
  strategy: 'string',
  model: 'string',
  includeApiKeyAccounts: 'boolean',
  shareHistory: 'boolean',
  headerProbe: 'boolean',
  fableProbe: 'boolean',
};

const RULE_KEYS: Readonly<Record<string, keyof Omit<AutoSwitchRules, 'customized'>>> = {
  'autoswitch.threshold': 'threshold',
  'autoswitch.weeklyThreshold': 'weeklyThreshold',
  'autoswitch.intervalSeconds': 'intervalSeconds',
  'autoswitch.cooldownSeconds': 'cooldownSeconds',
  'autoswitch.hysteresisPct': 'hysteresisPct',
  'autoswitch.unhealthyTicks': 'unhealthyTicks',
  'autoswitch.strategy': 'strategy',
  'autoswitch.model': 'model',
  'autoswitch.includeApiKeyAccounts': 'includeApiKeyAccounts',
  'run.shareHistory': 'shareHistory',
  'usage.headerProbe': 'headerProbe',
  'usage.fableProbe': 'fableProbe',
};

/**
 * Reads only the entries listed above. The payload also carries the settings file `path`
 * (which contains the user's home directory); it is never read.
 */
export function parseAutoSwitchRules(stdout: string): AutoSwitchRules | undefined {
  let root: unknown;
  try {
    root = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(root) || !Array.isArray(root['settings'])) {
    return undefined;
  }
  const rules: Record<string, unknown> = {};
  const customized: string[] = [];
  for (const entry of root['settings'] as unknown[]) {
    if (!isRecord(entry) || typeof entry['key'] !== 'string') {
      continue;
    }
    const field = RULE_KEYS[entry['key']];
    if (field === undefined) {
      continue;
    }
    const value = entry['value'];
    const typeMatches = typeof value === RULE_TYPES[field] && (typeof value !== 'number' || Number.isFinite(value));
    if (typeMatches) {
      rules[field] = value;
    }
    if (entry['isSet'] === true) {
      customized.push(entry['key']);
    }
  }
  return { ...(rules as Omit<AutoSwitchRules, 'customized'>), customized };
}
