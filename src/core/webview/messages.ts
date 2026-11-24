import { ACCOUNT_ACTION_IDS, type WebviewToHost } from '../../shared/dashboardProtocol';
import { isRecord } from '../model/json';

/**
 * Strict allow-list for messages from the dashboard webview. Anything else — unknown types,
 * malformed fields, command names, URLs — is rejected; the webview can never name a command.
 */
export function parseWebviewMessage(raw: unknown): WebviewToHost | undefined {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') {
    return undefined;
  }
  switch (raw['type']) {
    case 'ready':
    case 'refresh':
    case 'openSettings':
    case 'showDiagnostics':
      return { type: raw['type'] };
    case 'switchToAccount': {
      const slot = raw['slot'];
      return typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0 ? { type: 'switchToAccount', slot } : undefined;
    }
    case 'switchStrategy': {
      const strategy = raw['strategy'];
      return strategy === 'best' || strategy === 'next-available' ? { type: 'switchStrategy', strategy } : undefined;
    }
    case 'manageAccount': {
      const slot = raw['slot'];
      const action = ACCOUNT_ACTION_IDS.find((id) => id === raw['action']);
      return action !== undefined && typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 1
        ? { type: 'manageAccount', action, slot }
        : undefined;
    }
    default:
      return undefined;
  }
}
