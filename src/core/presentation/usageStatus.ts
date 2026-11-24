import type { Tone } from '../../shared/dashboardProtocol';
import type { Translate } from './accountTree';

/** Meanings taken from the CLI's own documentation of `usageStatus`; unknown values pass through. */
export function usageStatusText(status: string, t: Translate): string {
  switch (status) {
    case 'ok':
      return t('OK');
    case 'token_expired':
      return t('token expired (refresh pending)');
    case 'api_key':
      return t('API key (no subscription quota)');
    case 'keychain_unavailable':
      return t('keychain unavailable');
    case 'relogin_required':
      return t('re-login required');
    case 'foreign_credential':
      return t('live login belongs to another account');
    case 'no_credentials':
      return t('no stored credentials');
    case 'unavailable':
      return t('usage unavailable');
    default:
      return status;
  }
}

export function usageStatusTone(status: string): Tone {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'api_key':
      return 'neutral';
    case 'relogin_required':
    case 'no_credentials':
    case 'foreign_credential':
      return 'error';
    default:
      return 'warning';
  }
}
