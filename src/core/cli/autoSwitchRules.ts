import { ruleField, type AutoSwitchRules } from '../model/autoSwitch';

/**
 * cswap settings the extension may change through `cswap config set/unset`, with the same
 * validation cswap 1.2.0 applies (`settings.SETTING_SPECS`, verified with live probes). Anything else
 * stays CLI-only: `autoswitch.includeApiKeyAccounts` on purpose (API keys bill per token).
 */
export const AUTO_SWITCH_RULE_KEYS = [
  'autoswitch.threshold',
  'autoswitch.weeklyThreshold',
  'autoswitch.cooldownSeconds',
  'autoswitch.intervalSeconds',
  'autoswitch.hysteresisPct',
  'autoswitch.unhealthyTicks',
  'autoswitch.strategy',
  'autoswitch.model',
  'run.shareHistory',
  'usage.headerProbe',
  'usage.fableProbe',
] as const;
export type AutoSwitchRuleKey = (typeof AUTO_SWITCH_RULE_KEYS)[number];

export const AUTO_SWITCH_STRATEGIES = ['best', 'weekly-first', 'consume-first', 'priority-consume-first'] as const;
export type AutoSwitchStrategy = (typeof AUTO_SWITCH_STRATEGIES)[number];

export const THRESHOLD_RANGE = { min: 50, max: 99.9 } as const;
export const INTERVAL_MIN_SECONDS = 15;
export const COOLDOWN_MAX_SECONDS = 86_400;
export const INTERVAL_MAX_SECONDS = 3_600;
export const HYSTERESIS_MAX_PCT = 50;
export const UNHEALTHY_TICKS_RANGE = { min: 1, max: 100 } as const;

type BooleanKey = 'run.shareHistory' | 'usage.headerProbe' | 'usage.fableProbe';
type NumericKey = Exclude<AutoSwitchRuleKey, 'autoswitch.strategy' | 'autoswitch.model' | BooleanKey>;

export type AutoSwitchRuleUpdate =
  | { readonly key: NumericKey; readonly value: number }
  | { readonly key: 'autoswitch.strategy'; readonly value: AutoSwitchStrategy }
  | { readonly key: 'autoswitch.model'; readonly value: string }
  | { readonly key: BooleanKey; readonly value: boolean };

/**
 * `autoswitch.model`: "all" or comma-separated per-model window names (e.g. "Fable"). cswap accepts
 * any non-empty string and matches names case-insensitively; the extension only lets plain names
 * through, so nothing that could be read as a flag or contain control characters reaches the CLI.
 */
const MODEL_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const MODEL_RANGE = 'all | Fable, Opus, …';

function validateModels(text: string): RuleValidation {
  if (text.toLowerCase() === 'all') {
    return { ok: true, value: 'all' };
  }
  const names = text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0 || names.length > 10 || names.some((name) => !MODEL_NAME.test(name))) {
    return { ok: false, range: MODEL_RANGE };
  }
  return { ok: true, value: names.join(',') };
}

export type RuleValidation = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly range: string };

/** Parses user input for one rule into the exact string cswap receives. */
export function validateRuleInput(key: AutoSwitchRuleKey, input: string): RuleValidation {
  const text = input.trim();
  switch (key) {
    case 'autoswitch.threshold':
    case 'autoswitch.weeklyThreshold': {
      const range = `${THRESHOLD_RANGE.min}–${THRESHOLD_RANGE.max}`;
      if (!/^\d+(\.\d+)?$/.test(text)) {
        return { ok: false, range };
      }
      const value = Number(text);
      return value >= THRESHOLD_RANGE.min && value <= THRESHOLD_RANGE.max ? { ok: true, value: String(value) } : { ok: false, range };
    }
    case 'autoswitch.cooldownSeconds': {
      const range = `0–${COOLDOWN_MAX_SECONDS}`;
      return /^\d+$/.test(text) && Number(text) <= COOLDOWN_MAX_SECONDS ? { ok: true, value: String(Number(text)) } : { ok: false, range };
    }
    case 'autoswitch.intervalSeconds': {
      const range = `${INTERVAL_MIN_SECONDS}–${INTERVAL_MAX_SECONDS}`;
      const value = Number(text);
      return /^\d+$/.test(text) && value >= INTERVAL_MIN_SECONDS && value <= INTERVAL_MAX_SECONDS
        ? { ok: true, value: String(value) }
        : { ok: false, range };
    }
    case 'autoswitch.hysteresisPct': {
      const range = `0–${HYSTERESIS_MAX_PCT}`;
      return /^\d+(\.\d+)?$/.test(text) && Number(text) <= HYSTERESIS_MAX_PCT ? { ok: true, value: String(Number(text)) } : { ok: false, range };
    }
    case 'autoswitch.unhealthyTicks': {
      const range = `${UNHEALTHY_TICKS_RANGE.min}–${UNHEALTHY_TICKS_RANGE.max}`;
      const value = Number(text);
      return /^\d+$/.test(text) && value >= UNHEALTHY_TICKS_RANGE.min && value <= UNHEALTHY_TICKS_RANGE.max
        ? { ok: true, value: String(value) }
        : { ok: false, range };
    }
    case 'autoswitch.strategy':
      return (AUTO_SWITCH_STRATEGIES as readonly string[]).includes(text) ? { ok: true, value: text } : { ok: false, range: AUTO_SWITCH_STRATEGIES.join(', ') };
    case 'autoswitch.model':
      return validateModels(text);
    case 'run.shareHistory':
    case 'usage.headerProbe':
    case 'usage.fableProbe':
      return text === 'true' || text === 'false' ? { ok: true, value: text } : { ok: false, range: 'true, false' };
  }
}

/** The typed update for a value `validateRuleInput` accepted for that key. */
export function ruleUpdate(key: AutoSwitchRuleKey, value: string): AutoSwitchRuleUpdate {
  switch (key) {
    case 'autoswitch.strategy':
      return { key, value: value as AutoSwitchStrategy };
    case 'autoswitch.model':
      return { key, value };
    case 'autoswitch.threshold':
    case 'autoswitch.weeklyThreshold':
    case 'autoswitch.cooldownSeconds':
    case 'autoswitch.intervalSeconds':
    case 'autoswitch.hysteresisPct':
    case 'autoswitch.unhealthyTicks':
      return { key, value: Number(value) };
    case 'run.shareHistory':
    case 'usage.headerProbe':
    case 'usage.fableProbe':
      return { key, value: value === 'true' };
  }
}

/** Builds `config set` arguments only for allow-listed keys with values that pass validation. */
export function autoSwitchRuleArgs(rule: AutoSwitchRuleUpdate): readonly string[] | undefined {
  if (!(AUTO_SWITCH_RULE_KEYS as readonly string[]).includes(rule.key)) {
    return undefined;
  }
  const validated = validateRuleInput(rule.key, String(rule.value));
  return validated.ok ? ['config', 'set', rule.key, validated.value] : undefined;
}

/** Whether the settings read back from cswap hold the value the rules editor just wrote. */
export function ruleMatches(rules: AutoSwitchRules, key: AutoSwitchRuleKey, written: string): boolean {
  if (written === '') {
    return !rules.customized.includes(key);
  }
  const field = ruleField(key);
  const actual = field === undefined ? undefined : rules[field];
  switch (typeof actual) {
    case 'string':
      return actual === written;
    case 'boolean':
      return actual === (written === 'true');
    case 'number':
      return Math.abs(actual - Number(written)) < 1e-9;
    default:
      return false;
  }
}
