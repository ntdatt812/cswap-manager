# Cswap Manager

Manage your [Claude Swap](https://github.com/realiti4/claude-swap) (`cswap`) accounts without leaving VS Code: see every account's usage, switch the active Claude Code account, and adjust account settings. The `cswap` CLI does all the work; this extension is a GUI on top of it.

> Cswap Manager is an independent project. It is not affiliated with or endorsed by Anthropic or the authors of claude-swap. You are responsible for using your Claude accounts in line with Anthropic's terms.

## Requirements
- `cswap` installed and managing at least one account (verified with cswap 1.1.0 and 1.2.0).
- VS Code 1.90 or newer.
- Windows is the primary platform; macOS/Linux should work but are untested.

## Install
- From the Marketplace: search for **Cswap Manager** in the Extensions view, or run `code --install-extension nguyenthanhdat.cswap-manager`.
- From a `.vsix` file (for example a GitHub release): **Extensions** view → `…` menu → **Install from VSIX…**.

The extension finds `cswap` on `PATH` or in `~/.local/bin`. If yours lives elsewhere, set **Cswap Manager › Cli Path** in your user settings to the full path of `cswap.exe`.

## Features

### Accounts sidebar
Click the Cswap Manager icon in the Activity Bar.
- Accounts are listed by slot; the active account is marked and expanded.
- Each account shows plan and usage per window (for example `7d 40%`) with the time until reset; expand it for per-window bars, per-model scopes, plan, login expiry and how old the data is.
- Toolbar: refresh, switch, open dashboard, filter, sort, settings. Diagnostics is in the `…` menu.
- Right-click an account to switch to it, show details, or manage it.

### Status bar
Shows the active account, for example `#5 · 7d 40%`. It turns yellow/red near the usage limit and shows a clock icon when the data is out of date. Click it to switch accounts. Choose what it shows with **Status Bar › Mode** (or hide it).

### Switching accounts
**Cswap: Switch Account…** (or click the status bar) opens a picker arranged by what you most likely want:
1. **Pick automatically** — *Most headroom* (`cswap switch --strategy best`) or *Next available* (`--strategy next-available`).
2. **Current account.**
3. **Available** — accounts below the limit, most remaining quota first.
4. **At limit** — soonest reset first.
5. **Disabled or usage unknown.**

Each account shows a usage bar per window and the time to the next reset; plan, per-model usage and data age are on the second line. Type to filter by slot, email, alias or plan.

You confirm every switch. The extension only reports success after re-reading cswap's state and confirming the new active account. Switching changes the login used by running Claude Code sessions.

### Dashboard
**Cswap: Open Dashboard** opens a tab inside VS Code with a summary, a searchable and sortable account table, and full details for the selected account (all usage windows, pace and forecast when cswap provides them, last known usage, plan, settings and freshness).

### Managing accounts
From the account's right-click menu, **Cswap: Manage Account…**, or the dashboard:
- **Set / remove alias** — a short name for the account.
- **Disable / enable in rotation** — cswap's automatic switching skips disabled accounts; you can still switch to them directly.
- **Set / clear switch threshold** — the usage percentage (50–99.9) at which cswap auto-switch leaves this account. This changes cswap's behaviour.
- **Move to slot** — renumber an account; if the slot is taken, the two accounts trade places.

Disabling and moving ask for confirmation first. Every change is checked against cswap afterwards.

Not available in the extension (use the CLI): adding, removing, importing and exporting accounts, priorities, directory mappings, `cswap run`, and `purge`.

### Automatic switching
**Cswap: Auto-Switch…** (also in the sidebar `…` menu and on the status bar while it is on) runs cswap's own auto-switch (`cswap auto --once`) on a schedule while VS Code is open. It is **off by default**.
- **Notify only** — checks regularly with a dry run and tells you when cswap *would* switch, with a **Switch now** button. Nothing is switched.
- **Switch automatically** — cswap switches the active Claude Code account when it reaches the limit. You confirm once when turning it on, and get a notification for every switch.
- **Preview now** shows what cswap would do at this moment (dry run).
- **Rules…** edits cswap's own settings: switch threshold (default 90%), weekly threshold, cooldown (300 s), check interval (60 s) and strategy (most quota left, soonest weekly reset, …). They also apply to `cswap auto` in a terminal.

With several VS Code windows open, only one of them runs the checks. A check never runs at the same time as a manual switch or account change, and is never interrupted halfway.

## Settings
| Setting | Default | Description |
|---|---|---|
| `cswapManager.cliPath` | empty (auto-detect) | Full path to `cswap.exe`. User settings only — a workspace cannot change it. `.cmd`/`.bat` shims are not supported. |
| `cswapManager.language` | `auto` | Language of the extension's UI: `auto` (follow VS Code), `en` or `vi` (Tiếng Việt). Command titles and setting descriptions follow VS Code's display language. |
| `cswapManager.refreshIntervalSeconds` | `120` | Automatic refresh while the sidebar, status bar or dashboard is shown and the window is focused. `0` turns it off; minimum 30. |
| `cswapManager.statusBar.mode` | `slotUsage` | `slotUsage`, `slot`, `nameUsage` or `hidden`. |
| `cswapManager.confirmSwitch` | `true` | Ask before switching accounts. User settings only — a workspace cannot turn it off. |
| `cswapManager.autoSwitch.mode` | `off` | `off`, `notify` (dry runs, tell me) or `switch` (switch automatically). User settings only — a workspace cannot turn it on. |
| `cswapManager.sidebar.sortOrder` | `slot` | `slot`, `mostUsed`, `leastUsed` or `soonestReset`. |
| `cswapManager.display.warningThreshold` / `criticalThreshold` | `80` / `95` | Usage colours only; they do not change cswap. |
| `cswapManager.commandTimeoutSeconds` | `30` | Time limit for reading commands (switching and account changes always get at least 120 s). |
| `cswapManager.maxOutputKilobytes` | `2048` | Maximum CLI output the extension reads. |

## Privacy and security
- No telemetry. The extension makes no network requests itself; it only runs `cswap`.
- It never reads Claude Code or cswap credential files and never sees tokens.
- `cswap` is started directly (never through a shell), from your home folder, with fixed arguments.
- Logs (**Output › Cswap Manager**) and the diagnostics report contain no CLI output, emails, account IDs or home-folder paths.
- The dashboard runs with a strict Content Security Policy and accepts only a small fixed set of requests.

## Troubleshooting
| Symptom | What to do |
|---|---|
| "cswap was not found" | Install cswap, or set `cswapManager.cliPath` to the full path of `cswap.exe`, then **Refresh**. |
| Path points to a `.cmd`/`.bat` shim | Point the setting at the real `cswap.exe`; shims would need a shell, which the extension does not use. |
| "Stale" / clock icon | The last refresh failed or the data is old. Hover for the reason, then **Refresh**. Older data stays visible but is marked. |
| "list and status disagree about the active account" | cswap reported two different active accounts; run `cswap status` in a terminal. The extension shows the active account as unknown instead of guessing. |
| "The current Claude login is not managed by cswap" | Add it with `cswap add` in a terminal. |
| A switch or change "could not be confirmed" | cswap ran, but the re-read state did not show the expected result. Refresh and check with `cswap list`. |
| Anything else | Run **Cswap: Show Diagnostics** and copy the report; it is safe to share. |

## Known limitations
- The dashboard closes when the window reloads; reopen it with the command.
- Another VS Code window picks up a switch made elsewhere on its next refresh.
- Spend amounts are shown exactly as cswap reports them.
- Only one cswap operation runs at a time; others wait for it to finish.

## License
MIT — see `LICENSE`. Issues and source: https://github.com/ntdatt812/cswap-manager. Development notes: `docs/DEVELOPMENT.md`.
