# Cswap Manager — Product Specification

## 1. Product vision
Create an independent, modern VS Code extension to manage accounts maintained by `cswap` (Claude Swap). It should be a useful account-management surface, not only a quota indicator. The CLI remains the authoritative backend.

## 2. Target platform and stack
- VS Code Extension API, TypeScript, strict mode.
- Windows prioritized; design for portability where feasible.
- TreeView for sidebar, StatusBarItem, QuickPick, Webview for dashboard.
- No backend/server/database.
- Use VS Code APIs and theme tokens; avoid heavy UI dependencies unless justified.
- Build/package with a maintained toolchain (e.g. esbuild) and VSCE.

## 3. Verified environment
- Windows PowerShell 5.1
- cswap 1.1.0
- executable path observed: `%USERPROFILE%\.local\bin\cswap.exe`
- JSON output observed for `list` and `status`
- Help reports JSON support for `list`, `status`, `switch`.
- Exact `switch` target syntax observed in help: `cswap switch <num|email>`.
- Strategy syntax observed: `cswap switch --strategy best` or `--strategy next-available`.
These observations are not a guarantee of future versions; validate compatibility and tolerate schema changes.

## 4. UX
### 4.1 Activity Bar / Sidebar
- Dedicated icon and view titled Cswap Manager.
- Toolbar actions: refresh, switch, open dashboard, settings.
- Show active account prominently.
- List accounts by slot by default; optional sorting/filter/search.
- Account rows: slot, email or alias, plan when known, usage bars/percentages for available windows/scopes, reset time/countdown, status and active marker.
- Avoid overly dense rows; tooltip/details show extended information.
- Empty/error states should guide configuration without exposing credentials.

### 4.2 Account detail
- Header with slot, email/alias, active status, plan/status metadata when present.
- Usage section dynamically renders each usage window and each scope returned by CLI.
- Forecast and pacing fields only when supplied.
- Metadata section: usage fetched timestamp, login expiry (if supplied), freshness.
- Actions only when implemented and CLI behavior verified.

### 4.3 Quick switch
- VS Code QuickPick searchable by slot, email, alias, plan.
- Show current active account and usage context.
- Explicit choices: switch to selected account; switch strategy `best`; switch strategy `next-available`.
- Confirm action as appropriate; show progress, errors, and post-switch verification.
- Never claim switch success before process success and refreshed state confirms it.

### 4.4 Dashboard Webview
- Summary: account count, active account, usage states, stale/error state.
- Table: slot, alias/email, plan, usage, reset, status.
- Search/filter/sort.
- Click/select opens account details.
- Theme-aware, responsive, accessible.
- Webview message validation; no arbitrary commands from webview.

### 4.5 Status bar
- Configurable modes: active slot; slot + usage; alias/email + usage.
- Click opens QuickPick or switch command (configurable if justified).
- Tooltip shows active account and available usage summaries, reset/freshness and plan when available.
- Must remain concise and not assume a specific usage window.

### 4.6 Account operations (later phase)
CLI help lists commands for alias, enable/disable, threshold, priority, swap/move, add/remove, mapping, export/import, auto-switch and other features. Each feature must be verified and individually scoped before implementation.
- Alias: prefer CLI alias command if supported and verified, not extension-only metadata unless explicitly chosen.
- Enable/disable: confirm semantics and output.
- Threshold and priority: validate accepted values and display current state.
- Slot move/swap: confirm preview and consequences.
- Remove: strong confirmation.
- Add/add-token: defer until secure, verified workflow; do not expose token in process args or logs.
- Import/export: defer; confirm file handling, sensitive data risks, overwrite behavior and scope.
- Mapping: validate path behavior and whether paths are persisted globally.
- Auto-switch: inspect config and command behavior; do not alter implicitly.

### 4.7 Diagnostics
- Extension version, VS Code version, OS, CLI path/version, command status, parse/schema status, last refresh.
- Diagnostics must not dump raw command output or secrets.
- Provide a copy-safe report with redaction.

### 4.8 Settings
- CLI executable path (auto-detect with user override).
- Refresh interval, default candidate 120 seconds, configurable.
- Refresh on activation/open/focus and after switching; avoid duplicate concurrent refresh.
- Status bar mode.
- Threshold display preferences only; service thresholds are not implied by UI thresholds.
- Timeout and output-size limits.

## 5. Data model (tolerant)
All fields optional unless necessary for identifying an account. Normalize parsed CLI data into internal types. Unknown fields should not break rendering.

Account:
- number (slot)
- email, organizationName, organizationUuid (avoid exposing UUID unless useful)
- isOrganization, active, managed
- usageStatus
- usage: dynamic window keys plus scoped array
- loginExpiresAt
- plan: label, tier, status fields as available
- usageFetchedAt, usageAgeSeconds
- other known safe metadata

Usage:
- pct
- resetsAt
- countdown
- clock
- expectedPct
- aheadOfPace
- projectedExhaustionAt
- willLastToReset
- scoped usage includes dynamic name

Do not hardcode `Fable`, seven-day-only assumptions, or a fixed 5-hour window. The sample contains a `sevenDay` property but future data may vary. Support dynamic usage windows, while special rendering for known window keys is optional.

## 6. Observed JSON
### list
Top-level `schemaVersion`, `activeAccountNumber`, `accounts[]`. Accounts may include slot number, email, organization fields, active, usageStatus, usage object with `sevenDay` and `scoped[]`, plan, loginExpiresAt, usage timestamps/age.

### status
Top-level `schemaVersion`, `active`, `totalManagedAccounts`. `active` includes slot/email, managed/active account info, usageStatus, usage, usage timestamps. Status sample does not include plan, so merge plan from list only with reliable identity/slot matching.

## 7. Refresh and caching
- First attempt list --json as primary snapshot.
- Determine whether status --json is needed; avoid unnecessary duplicate calls.
- Verify active slot consistency from both outputs when both used.
- Cache last known good normalized data.
- Failed refresh preserves last good data and marks it stale.
- Refresh button, activation, view open if stale, after switch, interval refresh.
- Avoid overlapping processes; cancellation and timeout where supported.
- Never show stale data as current.

## 8. CLI execution
- Adapter abstraction and injectable runner for testing.
- No shell string concatenation; arguments array and shell disabled.
- On Windows, investigate executable handling and path settings safely.
- Timeout, stdout/stderr limits, exit-code handling, cancellation.
- Parse stdout JSON defensively.
- Capture stderr for immediate error presentation only, with redaction; no persistent raw logs.
- Version compatibility: graceful message for unsupported CLI.

## 9. Commands and UI actions (initial)
- Refresh accounts/usage.
- Open dashboard.
- Show quick switch.
- Switch to account.
- Switch best strategy.
- Switch next-available strategy.
- Open account details.
- Open settings.
- Show diagnostics.
Implementation should contribute commands incrementally, not register inert controls.

## 10. Accessibility and quality
- Keyboard accessible.
- Native VS Code theme colors and icons.
- Light/dark/high-contrast consideration.
- Localization-ready string organization.
- Tests for parser normalization, malformed/unknown schema, CLI runner, switch outcomes, cache freshness.
- Extension-host tests where practical.
- README and changelog before release.

## 11. Out of scope / prohibited
- Direct credential file reading/writing.
- Token collection or telemetry.
- Purge functionality.
- Unverified CLI commands.
- Automatic account switching without explicit user configuration and clear visibility.
- Unvalidated webview command dispatch.
