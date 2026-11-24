/**
 * A countdown as minutes and seconds, rounded up so it reaches 0:00 only when time is up: `0:42`,
 * `1:05`, `60:00`. Shared by the Accounts view and the dashboard webview.
 */
export function countdownText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
