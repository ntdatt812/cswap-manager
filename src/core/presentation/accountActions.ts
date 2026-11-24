import type { AccountAction, AccountActionId } from '../../shared/dashboardProtocol';
import type { Account } from '../model/types';
import type { Translate } from './accountTree';

/** Actions that make sense for the account's current state (e.g. "Remove alias" only when set). */
export function availableActions(account: Account): AccountActionId[] {
  const actions: AccountActionId[] = ['setAlias'];
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
