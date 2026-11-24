import type { SwitchStrategy } from '../cli/cswapCli';
import type { Account, AccountsSnapshot } from '../model/types';
import { accountLevel, accountName, hasUnavailableUsage, relativeAge, type PresentationOptions } from './accountTree';
import { compactDuration, epochOf, formatPercent, maxUsagePct, usageAgeMs, usageBar, windowLabel } from './format';
import { usageStatusText } from './usageStatus';

export type QuickSwitchAction =
  | { readonly kind: 'strategy'; readonly strategy: SwitchStrategy }
  | { readonly kind: 'account'; readonly slot: number; readonly active: boolean };

export interface QuickSwitchItemModel {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly iconId?: string;
  readonly separator?: boolean;
  readonly action?: QuickSwitchAction;
}

/** One bar per window: full width for a single window, shorter when several share the line. */
function usageLine(account: Account, options: PresentationOptions): string {
  const { t, now } = options;
  if (account.usageStatus !== undefined && hasUnavailableUsage(account)) {
    return usageStatusText(account.usageStatus, t);
  }
  const windows = account.usage?.windows ?? [];
  if (windows.length === 0) {
    return t('usage unknown');
  }
  const width = windows.length === 1 ? 10 : 6;
  const bars = windows.map((window) => {
    const pct = window.pct === undefined ? '?' : formatPercent(window.pct);
    return `${windowLabel(window.key)} ${usageBar(window.pct ?? 0, width, options.barStyle)} ${pct}`;
  });
  const reset = windows.map((window) => epochOf(window.resetsAt)).find((epoch) => epoch !== undefined && epoch > now);
  return reset === undefined ? bars.join('   ') : `${bars.join('   ')}   ↻ ${compactDuration(reset - now)}`;
}

function detailLine(account: Account, active: boolean, snapshot: AccountsSnapshot, options: PresentationOptions): string {
  const { t } = options;
  const parts: string[] = [];
  if (active) {
    parts.push(t('Current'));
  }
  if (account.disabled === true) {
    parts.push(t('Disabled'));
  }
  if (account.alias !== undefined && account.email !== undefined) {
    parts.push(account.email);
  }
  const plan = account.plan?.displayName ?? account.plan?.label;
  if (plan !== undefined) {
    // The subscription status is only worth showing when something is wrong with it.
    parts.push(account.plan?.expired === true ? t('{0} (expired)', plan) : plan);
  }
  for (const scope of account.usage?.scoped ?? []) {
    parts.push(`${scope.name} ${scope.pct === undefined ? '?' : formatPercent(scope.pct)}`);
  }
  const age = usageAgeMs(account, snapshot.capturedAt, options.now);
  if (age !== undefined) {
    parts.push(t('updated {0}', relativeAge(age, t)));
  }
  return parts.join(' · ');
}

function accountIcon(account: Account, active: boolean, options: PresentationOptions): string {
  if (active) {
    return 'pass-filled';
  }
  if (hasUnavailableUsage(account)) {
    return 'circle-slash';
  }
  switch (accountLevel(account, options.thresholds)) {
    case 'critical':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'account';
  }
}

export type QuickSwitchGroup = 'current' | 'available' | 'atLimit' | 'other';

/**
 * Where an account belongs in the picker:
 * - `current`: the active account (context, listed once);
 * - `available`: usage known and below the critical threshold, in rotation;
 * - `atLimit`: at or above the critical threshold — only useful once it resets;
 * - `other`: disabled, usage unavailable or unknown.
 */
export function quickSwitchGroup(account: Account, active: boolean, options: PresentationOptions): QuickSwitchGroup {
  if (active) {
    return 'current';
  }
  if (account.disabled === true || hasUnavailableUsage(account) || (account.usage?.windows.length ?? 0) === 0) {
    return 'other';
  }
  return accountLevel(account, options.thresholds) === 'critical' ? 'atLimit' : 'available';
}

function soonestFutureReset(account: Account, now: number): number | undefined {
  const resets = (account.usage?.windows ?? [])
    .map((window) => epochOf(window.resetsAt))
    .filter((epoch): epoch is number => epoch !== undefined && epoch > now);
  return resets.length === 0 ? undefined : Math.min(...resets);
}

const missingLast = (value: number | undefined): number => value ?? Number.POSITIVE_INFINITY;

/**
 * Items for the quick switch picker, arranged by what the user is likely to want: the automatic
 * strategies, the current account, accounts with the most headroom, accounts at their limit by
 * soonest reset, then disabled/unknown ones. Slot numbers stay in every label and everything
 * remains searchable. Each account shows a usage bar per window with the next reset; plan,
 * per-model usage and data age sit on the secondary line.
 */
export function buildQuickSwitchItems(snapshot: AccountsSnapshot, options: PresentationOptions): QuickSwitchItemModel[] {
  const { t, now } = options;
  const groups: Record<QuickSwitchGroup, Account[]> = { current: [], available: [], atLimit: [], other: [] };
  for (const account of snapshot.accounts) {
    groups[quickSwitchGroup(account, snapshot.active.slot === account.slot, options)].push(account);
  }
  groups.available.sort((a, b) => missingLast(maxUsagePct(a)) - missingLast(maxUsagePct(b)) || a.slot - b.slot);
  groups.atLimit.sort((a, b) => missingLast(soonestFutureReset(a, now)) - missingLast(soonestFutureReset(b, now)) || a.slot - b.slot);
  groups.other.sort((a, b) => a.slot - b.slot);

  const accountItem = (account: Account): QuickSwitchItemModel => {
    const active = snapshot.active.slot === account.slot;
    const detail = detailLine(account, active, snapshot, options);
    return {
      label: `${account.slot} · ${accountName(account, t)}`,
      description: usageLine(account, options),
      ...(detail.length > 0 ? { detail } : {}),
      iconId: accountIcon(account, active, options),
      action: { kind: 'account', slot: account.slot, active },
    };
  };
  const section = (title: string, accounts: Account[]): QuickSwitchItemModel[] =>
    accounts.length === 0 ? [] : [{ label: title, separator: true }, ...accounts.map(accountItem)];

  return [
    { label: t('Pick automatically'), separator: true },
    {
      label: t('Most headroom'),
      description: t('the account with the most quota left'),
      iconId: 'sparkle',
      action: { kind: 'strategy', strategy: 'best' },
    },
    {
      label: t('Next available'),
      description: t('the next account that is not at its limit'),
      iconId: 'arrow-right',
      action: { kind: 'strategy', strategy: 'next-available' },
    },
    ...section(t('Current account'), groups.current),
    ...section(t('Available — most headroom first'), groups.available),
    ...section(t('At limit — soonest reset first'), groups.atLimit),
    ...section(t('Disabled or usage unknown'), groups.other),
  ];
}
