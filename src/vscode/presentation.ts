import type { PresentationOptions, Translate } from '../core/presentation/accountTree';
import type { ExtensionConfiguration } from './configuration';
import { currentLocale, localize } from './l10n';

export const t: Translate = (message, ...args) => localize(message, ...args);

export function formatDateTime(epoch: number): string {
  return new Date(epoch).toLocaleString(currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function presentationOptions(configuration: ExtensionConfiguration, now = Date.now()): PresentationOptions {
  return { now, thresholds: configuration.thresholds(), t, formatDateTime, barStyle: configuration.barStyle() };
}

/** Re-render relative times ("updated 3m ago", countdowns) without calling the CLI. */
export const CLOCK_TICK_MS = 30_000;
/** The countdown to the next automatic refresh ticks every second. */
export const COUNTDOWN_TICK_MS = 1_000;
