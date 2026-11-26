# Changelog

## Unreleased
- **Colours in the switch picker**: accounts near their limit get a yellow icon and accounts at their limit a red one, like the status bar's colours (the current account keeps its check mark, coloured). The picker cannot colour text, so the colour is in the icon. Turn it off under *Quick Settings › Usage colours › Colours in the switch picker* (`cswapManager.display.pickerColors`). Every row's icon now sits in one column.
- **Calmer confirmations**: every confirmation dialog has its Cancel button in the extension's language (it was VS Code's English *Cancel*), and only steps that delete, overwrite or expose something, or cost money, keep the warning icon; the rest use the information icon. *Turn on automatic account switching?* is shorter and gives the cooldown in minutes (*cooldown 5 min*; menus too). 
- **Dialogs in your colour theme**: on its first run Cswap Manager sets VS Code's `window.dialogStyle` to `custom`, so confirmations are drawn in the colour theme instead of as Windows message boxes (an extension cannot contribute a default for this setting, so it is written to your user settings once, with **Undo**). Not on macOS, and not when you already chose a style. Change it under *Quick Settings › Advanced… › Dialogs*; VS Code applies it without a restart.
- **Settings grouped by task**: Quick Settings now reads *Language*, then **Switching** (ask before switching, account for this project, chat history across accounts — moved up from Advanced), **Auto-switch** and **Display**. The auto-switch row says *On / Notify only / Off* instead of repeating its own name, and its strategy, per-model limits and rules are listed only while it runs. *Auto refresh* moved to *Advanced… › Usage and alerts*, next to notifications and usage of token accounts. *every minute* instead of *every 1 min*.
- The account right-click menu is grouped the same way: use the account (switch, open Claude Code with it, assign to a project folder), details, its auto-switch settings (rotation, switch threshold), organise (display name, move to slot, export) and remove. In Vietnamese, moving an account to another slot is now *Dời sang slot…*, so it is no longer confused with *Chuyển sang tài khoản này* (switch).

## 0.13.0 — 2026-11-26
- **Columns line up exactly across plans**: a window an account lacks now shows `‒%` (a figure dash, as wide as a digit), so the columns after it no longer shift; an unknown percentage shows `?%`. The dashboard table keeps an empty line for such a window too, so the same windows line up across its rows.
- **No 5-hour wording for weekly-only accounts, anywhere**: the threshold help no longer says "no 5-hour limit", and the Get Started pictures show weekly limits (valid for every plan). An account whose usage cannot be read counts by its plan name; while that is unsure (an unseen plan), the threshold help uses neutral wording and both thresholds stay listed.
- Composed phrases use each language's own list and bracket punctuation (`、`, `（）`).
- With English chosen, dates and numbers follow English instead of VS Code's display language.
- The language row and picker keep the English word next to a translation (*Ngôn ngữ · Language*, *语言 · Language*), so a language picked by mistake is easy to undo.
- After a switch, background VS Code windows re-read cswap at a random moment within 5 seconds, or as soon as you bring one to the front, so they no longer all start it at the moment Claude Code is busiest. The window in front still updates right away.

## 0.12.0 — 2026-11-26
- **More languages**: the UI, command titles and setting descriptions are now also in 简体中文, 繁體中文, 日本語 and 한국어, next to English and Tiếng Việt. `cswapManager.language` (*Quick Settings › Language*) offers them; `auto` follows VS Code, with `zh-tw`/`zh-hk`/`zh-mo` getting Traditional and other Chinese locales Simplified. Dates and numbers follow the chosen language.
- The remove-account confirmation now points to **Add Account…** (it still named an old button).
- **Fits every plan**: menus and help name only the limits your accounts actually report. With weekly-only accounts (such as Ultra) nothing speaks of a 5-hour limit any more: *Usage of token accounts* reads *Weekly limits*, *Overall limits only* compares weekly limits, the switch threshold says *Switch when the weekly limit reaches this usage*, and the separate weekly threshold is hidden unless it is set (it would do the same job). With accounts on different plans, the wording names the plans, e.g. *5-hour (Max) and weekly*.
- Sidebar and switch picker: with accounts on different plans, an account without a window keeps that window's column (`5h –`), so the same windows line up across rows; the picker's bars keep one width.
- The *Usage alert* setting's description no longer assumes a 5-hour limit.
- **Automatic cswap updates stay on tested versions**: they install a patch of a release line Cswap Manager was tested with (1.1.x, 1.2.x) or of the line in use. A newer line, such as 1.3.0, is offered instead with a note that it was not tested yet, and **Update anyway** / **Skip this version**: several commands read cswap's text output (add, priority, map, export, import), which a new line may change. *Quick Settings › Advanced… › cswap version* marks it *(not tested yet)*.

## 0.11.0 — 2026-11-25
- **Install cswap from the extension**: when cswap is missing, the Accounts view, the error message and a one-time notification offer **Install cswap…**. After you confirm the exact program (by its full path) and arguments, the terminal you watch runs that program directly, without a shell: `uv tool install claude-swap`, or `pipx install claude-swap`, or first `uv` itself through winget (Windows, from the winget source) or Homebrew (macOS). No remote script runs. The extension notices cswap as soon as it is installed, refreshes, and offers **Add Account…**.
- **cswap updates itself**: when the daily check finds a newer cswap, the extension updates it in the background instead of asking (`cswapManager.autoUpdateCswap`, on by default; off brings back *Update* / *Skip this version*). It starts the uv or pipx that installed cswap by its full path, without a shell (before, *Update* typed `uv …` / `pipx …` into a terminal, where the shell could find another `uv`, such as a project's virtual environment), with `tool upgrade claude-swap` / `upgrade claude-swap`, after any switch or account change and while its own cswap commands wait. The status bar shows the progress, then cswap's version is read again, the accounts refresh and a notification says what changed (*cswap was updated: 1.2.0 → 1.3.0.*). A failure gives the exit code and the installer's last error line (emails and the user folder hidden), with **Try again** and **Open in terminal**; on Windows it mentions that a running cswap (a `cswap run` terminal) can block the update. Only one window updates at a time. *Quick Settings › Advanced… › cswap version* now opens a small screen: *Check for a cswap update now*, *Check once a day*, *Update automatically*.
- **Usage history**: the dashboard's account details gain **Last 7 days**, a small line of the measured usage of the weekly (and the limiting) window, with "about X per day (measured)" once there are enough readings. Nothing is projected. Readings stay on this computer in VS Code's storage for the extension, keyed by a short hash instead of the email, for 8 days. Turn it off with `cswapManager.usageHistory`; **Cswap: Clear Usage History** deletes it.
- **Notifications** (*Quick Settings › Advanced… › Notifications…*):
  - **Usage alert** while automatic switching is off: once per usage window, when the active account reaches 90% (or 80% / 95% / off, `cswapManager.notifyAtUsage`), with **Switch to most quota left** and **Switch automatically when used up**.
  - **Login expiry**: three days before an account's stored login expires, and when it has (`cswapManager.notifyLoginExpiry`, on by default). Log in again with `/login`; the extension stores the new login by itself.
  - The weekly-reset alert moved here.
  - Each alert shows once, also across reloads; only the window in front shows it.
- **Get Started walkthrough** (*Welcome: Open Walkthrough… › Get Started with Cswap Manager*): install cswap, open the Accounts view, add accounts, switch, dashboard and settings, each with buttons.
- The status bar's progress bar has 10 cells, like the sidebar's and the switch picker's.
- Renewal hints now say that the extension stores the new login after `/login` (no `cswap add` by hand).
- New Marketplace page: screenshots, a feature overview and a Vietnamese README (`README.vi.md`).

## 0.10.0 — 2026-11-24
- **Countdown to the next refresh**: while automatic refresh runs, the Accounts view's title and the dashboard header show only the time left, ticking every second (`Active: #3 · 0:42`), and so does the end of the status bar item (`#3 · 7d 40% · 0:42`; *Quick Settings › Status bar › Countdown to the next refresh*, `cswapManager.statusBar.countdown`, on by default). The dashboard's tooltip keeps the data's age. With automatic refresh off or paused (window not in front), the age shows as before; stale or failed data shows its warning instead of a countdown, and no countdown runs while a refresh does. One clock drives every countdown, and only while one is shown.
- **Switch when an account is used up** (on/off in one step: first item of *Auto-Switch…*, or **Cswap: Switch When an Account Is Used Up (On/Off)**): automatic switching at cswap's highest threshold, 99.9%, with the weekly threshold following it, so a session moves to another account instead of stopping at the limit. The strategy you chose stays. Checks run every 60 s by default (*Rules… › Check interval*, from 15 s), so one request can still meet the limit just before the switch; Claude Code uses the new account from its next request, without a restart.
- **Tidier screens** after a pass through the whole UI:
  - Dashboard: when every account has the same plan it is said once next to *Accounts* and the plan column goes away, so emails are no longer cut off. The reset date sits on each bar's title line (`7d · resets in 6d 18h (15:00 1 Dec)`) instead of a row of its own. The active account's details no longer repeat the bars of the *Active account* card.
  - The default organization of a personal account ("…'s Organization", which only repeats the email) is no longer shown.
  - Accounts view: *Filter* and *Sort* moved to the `…` menu (Clear filter still appears while a filter is on), so the view's title has room.
  - Quick Settings fits without scrolling: rarely changed settings (chat history across accounts, weekly-reset alerts, usage of token accounts, cswap path and version, command time limit, another computer, all settings) are on an **Advanced…** page with ← Back.
  - Switch picker: shorter group names (*Available*, *At limit*, *Disabled or unknown*), so the first account of a group is not cut off.
  - Vietnamese: "cooldown" is now "thời gian nghỉ", seconds are written out.
- **Keyboard shortcuts**: `Ctrl+Alt+S` opens the switch picker, `Ctrl+Alt+Shift+S` switches to the next available account (same keys on macOS; change them in Keyboard Shortcuts).
- **Weekly reset alerts** (`cswapManager.notifyOnWeeklyReset`, off by default; *Quick Settings › Advanced…*): a notification when an account's weekly limit resets, with a **Switch** button. Only the window in front shows it.
- **Adding accounts is easy to find**: a **＋** button opens the Accounts view's toolbar, and the switch picker ends with **＋ Add Account…**. It asks how: log in to a new account with `/login` (the usual way), paste a setup-token or API key, or refresh the stored login of the active account. After `/login` with an account cswap does not manage yet, the extension notices by itself and offers **Add to cswap…**.
- **Setup-token and API-key accounts** (`cswap add-token`): paste the token into a password box; it goes to cswap on its standard input only (never an argument, never logged or stored by the extension). Confirmed first; only free slots are offered.
- **Logging in again** to an account cswap already has (expired, about to expire or refused) is detected: the extension runs `cswap add --slot N` once to store the new login (cswap cancels if Claude Code is no longer on that account) and says so. Only the window in front acts.
- **More cswap settings**: *Rules…* adds minimum advantage (`autoswitch.hysteresisPct`) and failed checks before skipping (`autoswitch.unhealthyTicks`); *Quick Settings* adds **Chat history across accounts** (`run.shareHistory`) and **Usage of token accounts** (`usage.headerProbe` / `usage.fableProbe`, which spend 1 Haiku / Fable token per reading).
- **Columns line up everywhere**: the switch picker shows `slot · 7d ▰▱ 40% · ↻ 2d 4h · name` like the sidebar; the dashboard's reset timeline and *Manage account* list share one grid, so names, quota left and values sit in columns; tooltips show their details as a two-column table.
- Fewer cswap runs: adding a setup-token or API key no longer checks the active account (it does not change), turning auto-switch on in one step reads cswap's settings once, and changing token usage writes only the probe that changes.
- **Aliases removed from the extension**: *Set Alias…* and *Remove Alias* are gone from the menus, *Manage Account…* and the dashboard, and *Add Current Login…* no longer asks for one. Use **Set Display Name…** instead: it allows capitals, spaces and accents. An alias set in a terminal (`cswap alias`) is still shown as the account's name when it has no display name, and stays searchable.

## 0.9.0 — 2026-11-24
- **Sidebar columns line up**: each account row now reads `slot · 7d 40% · ↻ 2d 4h · name`, with numbers padded so percentages and reset times sit in straight columns; plan and problems follow in dim text. Usage rows under an account show the bar and percentage first. The active account is marked by its icon (and still named in its tooltip and spoken label).
- **Smoother drag and drop**: the move shows in the list at once while cswap runs it, and the two slot numbers it changed stay highlighted for a moment. Dropping on an account's usage rows counts as dropping on the account, and dropping on the empty space below the list moves the account to the end. When the list is not sorted by slot, a one-time tip offers to sort by slot.
- **Dashboard, more compact**: the reset time sits on each usage bar's title line (`7d · resets in 6d 20h`), and spacing is tighter throughout.
- **cswap path** in Quick Settings is now its own screen in the extension's language: find cswap automatically (showing where it was found), choose the program, or type its path. It is still saved in your user settings only, and `.cmd`/`.bat` launchers are still refused.
- Fewer cswap runs: priorities are re-read only after changes that can move them, and folder mappings are read when Quick Settings opens instead of at start-up.

## 0.8.0 — 2026-11-24
More of cswap, without a terminal:
- **Add Current Login…** (`cswap add`) — stores the account Claude Code is logged in to now, in a free slot of your choice with an optional alias, or refreshes its stored login when it is already managed. The empty sidebar links to it.
- **Remove from cswap…** (`cswap remove`, account right-click menu) — confirmed first, with a special warning for the active account.
- **Drag and drop** in the Accounts view: drop an account onto another one to give it that slot (the two trade places, `cswap move`). No dialog: progress shows in the view and the result has **Undo**. Account changes made from data read in the last 15 seconds skip the extra re-read, like switching.
- **Priority** (`cswap priority`, 0–1000) under *Manage Account…* and the dashboard, for the *By account priority* auto-switch strategy.
- **Per-model limits** (*Quick Settings*, cswap's `autoswitch.model`) — also count one model's weekly limit, or all of them, when picking an account.
- **Per-project accounts** (`cswap map` / `cswap run`) — assign an account to the open folder and **Open Claude Code for This Project** in a terminal with it, or **Open Claude Code as This Account…** with any account. The account used everywhere else does not change. The folder must be trusted, and on Windows a `claude` program inside the project is never picked up instead of the real one.
- **Another computer** (*Quick Settings*, sidebar `…` menu) — export accounts to a file and import them (`cswap export` / `import`, both confirmed; the file holds logins and the extension never opens it), and pass usage readings between computers that share accounts (`cswap import-usage`, with an optional pause of local fetching).
- **cswap updates** — a daily check against PyPI offers to update cswap with the command for the way it was installed (`cswapManager.checkCswapUpdates`, on by default); *Quick Settings › cswap version* checks on demand.
- Dashboard: the active account card uses two columns (the account and its switch buttons on the left, its usage meters on the right), so it is shorter; clicking an account in *Resets in the next 7 days* opens its details. *Expected by now* is renamed **Even pace by now** (it is the share of the window's time already passed, not a usage forecast) and drawn as a thin mark on the usage bars.
- **Precise slanted bars**: Unicode has no partly filled parallelogram, so **Slanted** bars used whole cells (54% looked like 50%, 1% like 10%, 98% like 90%). The extension now ships its own slanted cells filled in eighths, used in the switcher, the status bar and tooltips (about 1% steps, like **Blocks**). Sidebar rows cannot show icons and keep whole cells. The style picker says how precise each style is.

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
