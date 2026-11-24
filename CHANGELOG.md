# Changelog

## 0.7.0 — 2026-11-24
- **Display names**: give any account a name with capitals, spaces or accents (*Set Display Name…* in the account's right-click menu, *Manage Account…* or the dashboard). It is shown instead of the alias or email in the sidebar, status bar, switcher and dashboard, kept in VS Code only (never sent to cswap), follows the account when it moves slot, and updates every window at once.
- Setting an alias now says what cswap will store as you type (e.g. *Will be saved as "work"*). cswap keeps aliases in lower case with a–z, 0–9, `-`, `_` and `.` because commands use them.
- Calmer dashboard: no coloured card stripes or tinted panels, small corners; colour only where it means something (usage bars, limits, warnings).
- Quota left and auto-switch now sit in one slim line instead of two tall cards.
- *Manage account* is a tidy list of each property with its current value and short actions (Change…, Remove, Move…), merged with the account's email and organization.
- The accounts table no longer scrolls sideways in a narrow panel: the plan column hides when there is no room.

## 0.6.1 — 2026-11-24
Fixes from an independent review of 0.6.0:
- Suggestions never propose an account with less quota left than the active one.
- A suggestion's reset time now belongs to the same usage window as its percentage (with a 5-hour window present, 0.6.0 could pair weekly quota with the 5-hour reset). The reset timeline follows the same rule.
- Accounts with an expired plan or refused by the server for quota are no longer suggested.
- The faster-switch shortcut only skips the pre-switch check when the confirmed data is still the latest read and no refresh failed since; otherwise the slot is re-checked as before.
- Another window's switch signal always triggers a new refresh rather than reusing one already running.
- Dashboard: keyboard focus stays on a folded section's header across updates; the selected account's slot badge no longer looks active during a switch; an old saved sort by the removed Status column falls back to slot.

## 0.6.0 — 2026-11-24
- **Redesigned dashboard**, smarter and calmer:
  - **Suggestions** computed from cswap's own numbers (never a forecast), each with a one-click action: switch before the active account runs out (with when it resets, so waiting can be an option), spend quota that resets soon instead of losing it, no other account can help (with the first reset), logins that need renewing.
  - Overview cards: **Active account** (usage bars, quick switch), **Quota left** (counted in full accounts across those in rotation) and **Auto-switch** (mode and strategy, with *Set up…*).
  - Accounts table: slot badges, name and email on one line, usage bar with percentage, problems flagged next to the name only.
  - **Resets in the next 7 days**: a timeline showing when each account's quota comes back and how much it has left.
  - Account details: switch button up front, usage meters, plan / account / freshness and *Manage account* folded away (open state remembered).
  - *Settings* now opens Quick Settings.
- Faster switching (measured ~0.6–0.9 s less per switch): the check after a switch runs `cswap list` and `cswap status` at the same time, and a switch picked from data under 15 seconds old no longer re-reads the list first. Older data is still re-checked so a slot that changed meanwhile is never switched to.
- Fixed: after an automatic (or any) switch, other VS Code windows kept showing the old account until they were focused and their next refresh came round. A window that sees the active account change now leaves a small signal (slot number, time and window id only) in the extension's shared storage, and every other window refreshes at once. Windows must run 0.6.0 or later for this.
- The auto-switch status bar item is icon-only: ⟳ switches automatically, 👁 notify only, spinning while checking. Mode, rules and the last check are in its tooltip.
- Progress bars are drawn precisely: the last cell is partly filled (eighths for **Blocks**, halves for **Dots** and **Squares**), so 94% shows as `███████▌` instead of a full bar. In every style a bar below 100% never looks full and above 0% never looks empty. **Slanted** has no half glyph in Unicode, so it shows whole cells only.

## 0.5.1 — 2026-11-24
- Fixed: right after VS Code auto-updates the extension, the new settings could not be saved and Quick Settings showed a misleading "check your user settings file". VS Code only registers an update's new settings when the window reloads; Quick Settings now detects this, says so up front and offers **Reload Window**. Other save errors show VS Code's own message.
- All Cswap status bar items (account, auto-switch, buttons) now share one **Cswap Manager** entry in the status bar's right-click menu, which hides or shows them together. Turn single buttons on or off in *Quick Settings › Status bar › Buttons*. If you had hidden the account item from that menu before, it shows again once; hide it there or in Quick Settings.

## 0.5.0 — 2026-11-24
- **Status bar, your way** (*Quick Settings › Status bar*):
  - ready-made looks (Compact, With progress bar, Full, Name and usage, Slot only, Usage only), each drawn with your own data;
  - or tick exactly what to show: usage-level icon, slot, name, plan, progress bar, usage percentage, time to reset;
  - warning colours: coloured background (as before), coloured text only, or none;
  - optional buttons next to the account: Refresh, Dashboard, Settings (⚙, on by default); they hide together with the account item.
  Every change previews live on the real status bar; Enter saves, Esc cancels.
- **Progress bar style** (█░ ▰▱ ●○ ■□) for every usage bar: sidebar, account switcher and status bar.
- Quick Settings gained **Auto-switch rules**, **Usage colours** (yellow/red thresholds), **cswap path** and **Command time limit**.
- Every screen opened from Quick Settings has a **← Back** button to the list; Esc still closes everything.
- New settings: `cswapManager.statusBar.parts`, `statusBar.colors`, `statusBar.buttons`, `display.barStyle`, and the `custom` value for `statusBar.mode`. Existing modes look exactly as before.

## 0.4.1 — 2026-11-24
- Login expiry is flagged like cswap does it: **Re-login due** appears in the sidebar and tooltips only when an account's stored login expires within 7 days (yellow) or has lapsed (red), with how to renew it. The exact date stays in the dashboard.

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
