import type { SwitchStrategy } from '../cli/cswapCli';
import type { AccountsSnapshot } from '../model/types';
import { accountName, hasUnavailableUsage, planText, relativeAge, type PresentationOptions } from './accountTree';
import { compactDuration, epochOf, formatPercent, usageAgeMs, windowLabel } from './format';

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

/**
 * Items for the quick switch picker: the two CLI strategies, then every account in slot order.
 * Labels include slot and name, descriptions include plan and usage so all are searchable.
 */
export function buildQuickSwitchItems(snapshot: AccountsSnapshot, options: PresentationOptions): QuickSwitchItemModel[] {
  const { t, now } = options;
  const items: QuickSwitchItemModel[] = [
    { label: t('Strategies'), separator: true },
    {
      label: t('Switch to the account with the most headroom'),
      description: 'cswap switch --strategy best',
      iconId: 'sparkle',
      action: { kind: 'strategy', strategy: 'best' },
    },
    {
      label: t('Switch to the next available account'),
      description: 'cswap switch --strategy next-available',
      iconId: 'arrow-right',
      action: { kind: 'strategy', strategy: 'next-available' },
    },
    { label: t('Accounts'), separator: true },
  ];

  for (const account of [...snapshot.accounts].sort((a, b) => a.slot - b.slot)) {
    const active = snapshot.active.slot === account.slot;
    const description: string[] = [];
    if (active) {
      description.push(t('current'));
    }
    if (account.disabled === true) {
      description.push(t('disabled'));
    }
    const plan = planText(account, t);
    if (plan !== undefined) {
      description.push(plan);
    }
    if (hasUnavailableUsage(account)) {
      description.push(t('usage {0}', account.usageStatus ?? ''));
    }
    for (const window of account.usage?.windows ?? []) {
      const reset = epochOf(window.resetsAt);
      const resetText = reset !== undefined && reset > now ? ` ↻ ${compactDuration(reset - now)}` : '';
      description.push(`${windowLabel(window.key)} ${window.pct === undefined ? '?' : formatPercent(window.pct)}${resetText}`);
    }

    const detail: string[] = [];
    if (account.alias !== undefined && account.email !== undefined) {
      detail.push(account.email);
    }
    for (const scope of account.usage?.scoped ?? []) {
      detail.push(`${scope.name} ${scope.pct === undefined ? '?' : formatPercent(scope.pct)}`);
    }
    const age = usageAgeMs(account, snapshot.capturedAt, now);
    if (age !== undefined) {
      detail.push(t('usage updated {0}', relativeAge(age, t)));
    }

    items.push({
      label: `${account.slot} · ${accountName(account, t)}`,
      description: description.join(' · '),
      ...(detail.length > 0 ? { detail: detail.join(' · ') } : {}),
      iconId: active ? 'pass-filled' : 'account',
      action: { kind: 'account', slot: account.slot, active },
    });
  }
  return items;
}
