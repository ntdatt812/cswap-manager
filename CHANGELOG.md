# Changelog

## 0.4.0 — 2026-11-24
- **Cswap: Quick Settings…** (gear in the Accounts view and in the switch picker): language, ask before switching, auto-switch and its strategy, status bar, account order and refresh interval, in the extension's own language, without opening VS Code's Settings page.
- The switch confirmation has a **Switch, don't ask again** button.
- cswap's auto-switch strategies (`best`, `weekly-first`, `consume-first`, `priority-consume-first`) are explained and picked from **Auto-Switch › Strategy…**; **Switch automatically, use quota before it resets** turns on automatic switching with `consume-first` in one step.
- Dialogs now say that running Claude Code sessions pick up a new account by themselves, without a restart.

## 0.3.1 — 2026-11-24
- Auto-switch hardening after an independent security review: a mode change can no longer let a real tick through, cswap config values are type-checked, lease-file failures are reported, every real switch is notified, CLI error text is redacted, real ticks get a 10-minute safety timeout, and the mode is not synced across machines.

## 0.3.0 — 2026-11-24
- Automatic switching with cswap's own `cswap auto`: **Cswap: Auto-Switch…** with modes off / notify only (dry runs) / switch automatically, a status bar indicator, notifications, a dry-run preview and an editor for cswap's auto-switch rules. Off by default; user settings only; one window runs it; ticks never overlap with other cswap changes.
- Includes the 0.2.0 changes below (not published separately).

## 0.2.0 — 2026-11-24
- Switch Account picker redesigned: usage bars with the next reset, grouped by usefulness (automatic picks, current, most headroom, at limit by soonest reset, disabled/unknown), less text per row.
- Vietnamese UI (`cswapManager.language`: auto, en, vi) for the sidebar, status bar, dialogs and dashboard; Vietnamese command titles and settings when VS Code runs in Vietnamese.
- Dates follow the chosen language.

## 0.1.2 — 2026-11-24
- First Marketplace release: publisher `nguyenthanhdat`, MIT license, extension icon, repository links, independence notice in the README.

## 0.1.1 — 2026-11-24
- Verified against cswap 1.2.0 (source diff + live probes + full test suite); the 1.2 line is now reported as tested in diagnostics.

## 0.1.0 — 2026-11-24

First release, built in phases:

### Phase 1
- Safe CLI process runner (no shell, timeout, output bound, cancellation).
- `cswap` executable resolution with a machine-scoped `cswapManager.cliPath` setting.
- Tolerant parsers and normalized model for `cswap list --json` and `cswap status --json`.
- Refresh service with last-good cache, stale tracking and single-flight refresh.
- Commands: `Cswap: Refresh Accounts`, `Cswap: Show Diagnostics` (redacted report).

### Phase 2
- Activity Bar view **Cswap Manager → Accounts**: slot-ordered accounts, prominent active account, dynamic usage windows/scopes with bars and live countdowns, plan/login/freshness details, escaped tooltips.
- Welcome states for loading, CLI not found, invalid/unsupported path, errors, no accounts and empty filter; stale/conflict/filter messages above the tree.
- Automatic refresh while the view is visible and the window focused (`cswapManager.refreshIntervalSeconds`, default 120, `0` = off).
- Filter, sort (`cswapManager.sidebar.sortOrder`) and display-only usage colour thresholds.

### Phase 3
- Status bar item for the active account (`cswapManager.statusBar.mode`), with stale/switching states and a usage tooltip.
- `Cswap: Switch Account…` quick pick (strategies `best` / `next-available` and every account), `Switch to Account with Most Headroom`, `Switch to Next Available Account`, and an inline switch action on account rows.
- Switches are confirmed (`cswapManager.confirmSwitch`), never run concurrently, and are reported as successful only after a fresh list + status refresh confirms the new active account.
- Account alias and disabled state are read from `cswap list --json`.

### Phase 4
- `Cswap: Open Dashboard`: summary cards, searchable/sortable account table and an account detail pane inside a VS Code editor tab; `Show Account Details` from the sidebar.
- Detail shows every usage window and scope, pace/forecast and spend only when supplied, last-known usage (marked as not current), fetch errors, plan, alias, rotation, per-account threshold and freshness.
- Webview hardened with a nonce CSP, restricted resource roots, text-only rendering and an allow-listed message bridge.

### Phase 5
- Account management from the sidebar context menu, `Cswap: Manage Account…` and the dashboard: set/remove alias, disable/enable in rotation, set/clear the per-account switch threshold, move to a slot (swaps if occupied).
- Inputs are validated with cswap's own rules; disable and move ask for confirmation with a preview; every change is verified against a fresh `cswap list --json`.
- Switching and management share one lock, so cswap changes never overlap.

### Phase 6
- Independent security review; fixed: link injection into notifications, workspace override of switch confirmation, status bar icon injection, slot changes between confirmation and execution; extra redaction patterns, bounded JSON recovery, stricter webview CSP.
- User-facing README (install, features, settings, privacy, troubleshooting, limitations); development notes moved to `docs/DEVELOPMENT.md`.
- `npm run package:vsix` release build.
