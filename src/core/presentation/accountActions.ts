import type { AccountAction, AccountActionId, ManageRow } from '../../shared/dashboardProtocol';
import type { Account } from '../model/types';
import type { Translate } from './accountTree';
import { formatPercent } from './format';

/** Actions that make sense for the account's current state (e.g. "Remove alias" only when set). */
export function availableActions(account: Account): AccountActionId[] {
  const actions: AccountActionId[] = ['setDisplayName', 'setAlias'];
  if (account.alias !== undefined) {
    actions.push('removeAlias');
  }
  actions.push(account.disabled === true ? 'enable' : 'disable', 'setThreshold');
  if (account.threshold !== undefined) {
    actions.push('clearThreshold');
  }
  actions.push('move');
  return actions;
}

export function actionLabel(action: AccountActionId, t: Translate): string {
  switch (action) {
    case 'setDisplayName':
      return t('Set display name…');
    case 'setAlias':
      return t('Set alias…');
    case 'removeAlias':
      return t('Remove alias');
    case 'disable':
      return t('Disable in rotation…');
    case 'enable':
      return t('Enable in rotation');
    case 'setThreshold':
      return t('Set switch threshold…');
    case 'clearThreshold':
      return t('Clear switch threshold');
    case 'move':
      return t('Move to slot…');
  }
}

/**
 * The account's editable properties as a list: current value plus short actions, the same set as
 * `availableActions` (the manage flow checks against it).
 */
export function manageRows(account: Account, t: Translate): ManageRow[] {
  const action = (id: AccountActionId, label: string): AccountAction => ({ id, label });
  return [
    {
      label: t('Display name'),
      value: account.displayName ?? t('not set'),
      actions: [action('setDisplayName', account.displayName === undefined ? t('Set…') : t('Change…'))],
    },
    {
      label: t('Alias'),
      value: account.alias ?? t('not set'),
      actions: [
        action('setAlias', account.alias === undefined ? t('Set…') : t('Change…')),
        ...(account.alias === undefined ? [] : [action('removeAlias', t('Remove'))]),
      ],
    },
    {
      label: t('Auto-rotation'),
      value: account.disabled === true ? t('held out') : t('included'),
      actions: [account.disabled === true ? action('enable', t('Include')) : action('disable', t('Hold out…'))],
    },
    {
      label: t('Switch threshold'),
      value: account.threshold === undefined ? t('global setting') : formatPercent(account.threshold),
      actions: [
        action('setThreshold', account.threshold === undefined ? t('Set…') : t('Change…')),
        ...(account.threshold === undefined ? [] : [action('clearThreshold', t('Use global'))]),
      ],
    },
    { label: t('Slot'), value: String(account.slot), actions: [action('move', t('Move…'))] },
  ];
}

export function accountActions(account: Account, t: Translate): AccountAction[] {
  return availableActions(account).map((id) => ({ id, label: actionLabel(id, t) }));
}

/**
 * Tree item context value with state flags, matched by `when` clauses in package.json, e.g.
 * `cswap.account:inactive:enabled:aliased:nothreshold`.
 */
export function accountContextValue(account: Account, active: boolean): string {
  return [
    'cswap.account',
    active ? 'active' : 'inactive',
    account.disabled === true ? 'disabled' : 'enabled',
    account.alias !== undefined ? 'aliased' : 'unaliased',
    account.threshold !== undefined ? 'threshold' : 'nothreshold',
  ].join(':');
}
