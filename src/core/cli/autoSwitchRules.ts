/**
 * Auto-switch rules the extension may change through `cswap config set/unset`, with the same
 * validation cswap 1.2.0 applies (verified with live probes). Anything else stays CLI-only.
 */
export const AUTO_SWITCH_RULE_KEYS = [
  'autoswitch.threshold',
  'autoswitch.weeklyThreshold',
  'autoswitch.cooldownSeconds',
  'autoswitch.intervalSeconds',
  'autoswitch.strategy',
] as const;
export type AutoSwitchRuleKey = (typeof AUTO_SWITCH_RULE_KEYS)[number];

export const AUTO_SWITCH_STRATEGIES = ['best', 'weekly-first', 'consume-first', 'priority-consume-first'] as const;
export type AutoSwitchStrategy = (typeof AUTO_SWITCH_STRATEGIES)[number];

export const THRESHOLD_RANGE = { min: 50, max: 99.9 } as const;
export const INTERVAL_MIN_SECONDS = 15;
export const COOLDOWN_MAX_SECONDS = 86_400;
export const INTERVAL_MAX_SECONDS = 3_600;

export type AutoSwitchRuleUpdate =
  | { readonly key: 'autoswitch.threshold' | 'autoswitch.weeklyThreshold'; readonly value: number }
  | { readonly key: 'autoswitch.cooldownSeconds' | 'autoswitch.intervalSeconds'; readonly value: number }
  | { readonly key: 'autoswitch.strategy'; readonly value: AutoSwitchStrategy };

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
    case 'autoswitch.strategy':
      return (AUTO_SWITCH_STRATEGIES as readonly string[]).includes(text) ? { ok: true, value: text } : { ok: false, range: AUTO_SWITCH_STRATEGIES.join(', ') };
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
