# Architecture and decisions

## Layout
```
src/
  extension.ts                 activation, command registration (VS Code layer)
  vscode/                      configuration, logger, localized messages
  core/                        no `vscode` import (enforced by ESLint); unit-tested in plain Node
    cli/
      processRunner.ts         spawn wrapper: shell:false, timeout, stdout bound, cancellation
      executableResolver.ts    setting → absolute PATH entries → ~/.local/bin
      cswapCli.ts              read-only adapter: --version, list --json, status --json
      cliErrors.ts, version.ts
    model/                     tolerant parsers, normalized types, list/status reconciliation
    service/refreshService.ts  cache, single-flight refresh, stale tracking, events
    diagnostics/               structured, redacted diagnostics report
    security/redact.ts         redaction of emails, UUIDs, tokens, home paths, ANSI
test/
  unit/                        node:test suites (npm test)
  live/                        opt-in read-only smoke test against the real CLI (npm run test:live)
  fixtures/                    redacted JSON shaped like observed CLI output (fake identities)
```

## Process execution
- `child_process.spawn` with an argument array, `shell: false`, `windowsHide`, `stdin` ignored, a fixed working directory (the user's home, never a workspace folder), a timeout and a stdout byte limit (stderr capped at 64 KB).
- The adapter can only send three constant argument vectors (`COMMAND_ARGS`). Phase 1 runs no mutating command.
- On timeout, cancellation or output overflow the promise settles immediately and the process is killed best-effort; it does not wait for `close`, because a grandchild holding the pipes could otherwise hang it (covered by a test).
- Env adds `NO_COLOR=1` and `PYTHONIOENCODING=utf-8` (inert hints for clean UTF-8 output from the Python-based CLI).
- Windows: only `.exe`/`.com` are executed. `.cmd`/`.bat`/`.ps1` shims are reported as unsupported instead of being run through `cmd.exe`, because that would reintroduce shell parsing.

## Executable resolution
1. `cswapManager.cliPath` (declared `scope: machine`, read from the global/user value only). If set but unusable, resolution fails — it never silently falls back.
2. Absolute `PATH` entries only (relative/empty entries are skipped so a workspace cannot shadow the CLI).
3. `~/.local/bin` (uv tool / pipx default).
Successful resolutions are cached until the setting changes or a spawn reports `ENOENT`; failures are not cached.

## Data model and parsing
- Every field except the slot (`number`) is optional; `undefined` means "the CLI did not provide it".
- Usage windows are any object under `usage` that has `pct` or `resetsAt`, kept in CLI order under their own key — no hard-coded `sevenDay`/`fiveHour`. `scoped[]` entries need a `name`.
- Wrongly typed values are dropped with a warning (`code` + JSON path, never the value). Unknown fields are ignored.
- `schemaVersion` other than 1 is parsed best-effort with a `schema-version-untested` warning; missing `accounts` array is a hard `unexpected-shape` error.
- Accounts are sorted by slot; accounts without a valid slot or with duplicate slots are skipped with warnings.

## Refresh and reconciliation
- `list --json` is the primary snapshot. `status --json` is called only when the caller asks for verification (post-switch, later phases) or when the list is ambiguous (missing `activeAccountNumber`, or flags disagree with it).
- Status data is merged into a list account only when slot matches and emails do not contradict; its usage replaces the list usage only if `usageFetchedAt` is newer. Plan data always comes from `list`.
- On conflicting sources the active slot is taken from `status` only if its identity is confirmed; otherwise it is reported as unknown with `consistency: conflict`.
- Concurrent refreshes share one CLI run. `requireFresh` queues a single follow-up run instead of reusing an in-flight result.

## Data states (for the UI phases)
| State | Meaning |
|---|---|
| unknown | the CLI omitted the field — render as unknown, never as 0/false |
| unavailable | the CLI reports a `usageStatus` other than `ok`, or no usage for the account |
| stale | a last-good snapshot exists but the latest refresh failed (`refresh-failed`) or it is older than 5 minutes (`too-old`) |
| none / error | no data has ever loaded; show the error with guidance, not an empty list |

## Sidebar (Phase 2)
- Activity Bar container **Cswap Manager** with the **Accounts** tree (`src/vscode/accountsView.ts`, `accountsTreeProvider.ts`).
- The tree model is built in `src/core/presentation/accountTree.ts` as plain data (`NodeModel`) with an injected translator, so it is unit-tested without VS Code; the VS Code layer only maps it to `TreeItem`s.
- Account row: `slot · email`, description `Active · plan · <window> <pct> … · ↻ <time to first reset>`; icon shows active (`pass-filled`, coloured by usage level) or the worst usage level. The active account is expanded by default; order stays by slot unless the user picks another sort.
- Children: one row per usage window and per scope (text bar, %, live countdown computed from `resetsAt`, never a negative countdown), then plan, login expiry, usage age and organization when supplied. Pace/forecast fields appear in tooltips only when the CLI provides them.
- Tooltips are untrusted `MarkdownString`s; CLI strings go through `appendText` (escaped), so account data cannot inject links or commands.
- View states use the `cswapManager.viewState` context key and `viewsWelcome`: loading, notFound, invalidSetting, unsupportedExecutable, error, empty, filteredEmpty. With data present, the view description shows `Stale` / active slot / age and `TreeView.message` explains stale data, refresh failures, list/status conflicts, an unmanaged login, untested schema versions and the active filter.
- Refresh triggers: activation/first show, the `RefreshScheduler` (default 120 s, `0` = off, minimum 30 s) which only runs while the view is visible **and** the window is focused and is due one interval after the last attempt of any kind, toolbar/command refresh, and `cliPath` changes. Relative times re-render every 30 s without calling the CLI. A view progress bar shows while a refresh runs.
- Stale threshold: `max(5 min, 2 × refresh interval)`.
- Filter (in-memory, per window) matches slot, email, organization, plan and usage status; sort order is the `cswapManager.sidebar.sortOrder` setting. Warning/critical colours use display-only thresholds (80/95 by default).

## Switching, status bar and quick switch (Phase 3)
- `CswapCli.switch(target)` builds arguments only from a validated integer slot or one of the two known strategies (`switchArgs`); emails/aliases are never passed and `--force` is never used. A switch gets a timeout of at least 120 s and is not cancellable, so a credential rewrite is never killed half-way. A non-zero exit with the CLI's JSON error envelope becomes `cli-reported-error` (type kept, message redacted).
- `SwitchService` allows one switch at a time (`busy` otherwise) and **always** follows it — even after a failure — with a `requireFresh` + `verifyActive` refresh. The outcome carries a verification: `confirmed` only when list and status agree on the expected slot; `mismatch` or `unverified` otherwise. The UI says "switched" only for `confirmed`.
- Quick switch (`Cswap: Switch Account…`, status bar click, view toolbar): strategies first, then accounts in slot order, searchable by slot, alias, email, plan and usage text. Picking the active account does nothing. A modal confirmation precedes every switch (`cswapManager.confirmSwitch`, default on). Account rows in the tree have an inline "Switch to This Account" action.
- Status bar (`cswapManager.statusBar.mode`: `slotUsage` default, `slot`, `nameUsage`, `hidden`): level icon + warning/error background, `$(history)` when stale, spinner while switching; at most two windows are shown, otherwise the fullest. Account text is sanitized so it cannot inject `$(icon)` syntax; the tooltip is an untrusted Markdown summary.
- `AutoRefreshController` runs the scheduler while any consumer (Accounts view visible, status bar shown) needs data and the window is focused. The extension activates `onStartupFinished` so the status bar is available without opening the view.

## Dashboard and account detail (Phase 4)
- `Cswap: Open Dashboard` (view toolbar, palette) opens one editor-tab webview inside VS Code; `Show Account Details` on a tree row opens it focused on that slot.
- **The host builds everything.** `core/presentation/dashboard.ts` turns the snapshot into a `DashboardModel` (localized strings, levels, tones, facts) defined in `src/shared/dashboardProtocol.ts`, which has no imports so the webview can share it. The webview (`src/webview/dashboard.ts`, bundled to `dist/webview/dashboard.js`) only renders it.
- **Webview security:** CSP `default-src 'none'`, nonce'd script only, styles/images/fonts from `webview.cspSource`; `localResourceRoots` limited to `dist/webview` and `media`; `enableCommandUris: false`. Rendering uses DOM APIs and `textContent` exclusively (no `innerHTML`), so CLI data cannot inject markup. Bar widths are set through CSSOM, which CSP does not block.
- **Message bridge:** webview → host messages pass `parseWebviewMessage`, an allow-list of `ready`, `refresh`, `switchToAccount{slot:int}`, `switchStrategy{best|next-available}`, `openSettings`, `showDiagnostics`. The host also rejects a switch for a slot not in the current snapshot. Switches reuse the Phase 3 flow (confirmation, single-flight, verification). The webview can never name a command.
- **UI:** summary cards (accounts, active, usage levels, data freshness), a searchable table with sortable column headers (`aria-sort`, missing values last), and a detail pane: header + badges + switch action, usage meters (`role="meter"`, value text includes the reset), pace/forecast and spend facts only when supplied, last-known usage clearly labelled as not current, fetch error/retry, plan, account (alias, rotation, per-account threshold) and freshness. Theme colours come only from VS Code CSS variables; forced-colors mode is handled; the layout collapses to one column below 900 px. Keyboard focus is preserved across re-renders.
- The panel counts as an auto-refresh consumer while visible and re-posts state every 30 s for relative times. UI state (selection, search, sort) is kept with `setState`; `retainContextWhenHidden` is off.
- A visual check was done once in light/dark themes and at 560 px width by loading the built `dashboard.js` + CSS in a temporary local page with stubbed VS Code theme variables (removed afterwards). It found and fixed a CSS ordering bug (status/note tone colours) and a focus-loss bug.

## Account management (Phase 5)
- Operations: set/remove alias, disable/enable in rotation, set/clear the per-account switch threshold, move to a slot (swaps when occupied). Each was verified against the CLI first (docs/CLI-CONTRACT.md, Phase 5).
- `CswapCli.manage(op)` builds arguments only from a positive integer slot, an alias that passed the CLI's own rules (`core/model/accountPolicy.ts` mirrors `normalize_alias`, so a value can never start with `-` and become a flag), or a threshold within 50–99.9. These commands print text only, so success means exit 0; failures carry cswap's redacted `Error:` line.
- `ManagementService` checks the account exists, runs the command, always refreshes, and verifies the effect on the **same account** (followed by email + organization) in the fresh `list --json` — `confirmed`, `mismatch` or `unverified` are reported as such.
- `OperationGate` is shared by switching and management, so no two cswap mutations ever overlap; the dashboard disables its buttons while the gate is busy.
- UI: tree row context menu (actions shown only when they apply, via `contextValue` flags such as `cswap.account:inactive:enabled:aliased:nothreshold`), `Cswap: Manage Account…` in the palette, and action buttons in the dashboard detail (`manageAccount` message, allow-listed action + known slot). Values are always typed into VS Code input boxes with live validation, never into the webview.
- Confirmations: modal for disabling (explains rotation, warns if it is the active account or the last one in rotation) and for moving (shows which account trades places and that numeric shortcuts change meaning). Alias, enable and threshold changes are reversible and not modal. The threshold prompt states that it changes cswap's auto-switch behaviour, unlike the display-only colour thresholds.

## Security review (Phase 6, 2026-11-24)
An independent read-only review covered process execution, executable resolution, the webview, UI text injection, secret/PII handling, state-changing operations, the test API and the packaged dependency surface. Overall risk: **low** (0 critical/high/medium, 4 low, 6 info). Fixed:
- **L1** CLI-derived text (error types, switch reasons, account names) could form `[label](command:…)` links in notifications. All such text now goes through `neutralizeLinks`; error types must look like class names and reasons like kebab-case codes, otherwise they are not shown.
- **L2** A workspace could disable switch confirmation. `cswapManager.confirmSwitch` is now `application`-scoped, read from user settings only, and listed in `restrictedConfigurations`.
- **L3** Usage text in the status bar is sanitized against `$(icon)` injection.
- **L4** Slot-addressed operations are refused (`account-changed`) if, after a fresh re-read just before running, the slot(s) no longer hold the account(s) the user confirmed.
- **I2/I3/I5/I6** base64 secrets and profile names with spaces are redacted; `ELECTRON_RUN_AS_NODE` is not passed to the CLI; JSON recovery is capped at 5 attempts; the webview CSP adds `base-uri 'none'` and `form-action 'none'`.
Accepted: reversible actions (remove alias, enable, clear threshold) run without a modal; absolute PATH entries are trusted as the user's shell trusts them. Dev-only dependencies (mocha, @vscode/test-cli, vsce) have 9 audit advisories (1 high in `serialize-javascript` via mocha) with no fix available; none of them ship in the VSIX, whose runtime dependency count is zero.

## Release validation (Phase 6)
`npm run package:vsix` produces `cswap-manager-<version>.vsix` (10 files, ~42 KB: bundled `dist/`, `media/`, `resources/`, README, CHANGELOG, manifest). The archive was scanned for usernames, local paths, emails and source maps (none), installed into an isolated VS Code profile, and the extension-host suite was run against the minified production bundle.

## Diagnostics
`Cswap: Show Diagnostics` runs only the three read-only probes and renders counts, keys, codes, exit codes and timings into an untitled Markdown document, with an optional copy-to-clipboard. Paths are shown relative to `~`; emails, organization names, UUIDs, scope names and raw output are never included, and the final text is redacted again.

## Decisions
- **TypeScript 5.9**: TS 7.0 (latest) is not yet supported by typescript-eslint (`<6.1.0`).
- **node:test** for unit tests (no VS Code needed). Extension-host tests use `@vscode/test-cli` (mocha, `tdd` UI) and can run against a local VS Code via `VSCODE_EXECUTABLE`; `activate()` returns a small test API only in `ExtensionMode.Test`.
- **esbuild** bundle to `dist/extension.js`; tests are compiled separately by `tsc` to `out/`.
- **Engine `^1.90.0`** with `@types/vscode ~1.90.0`; `@types/node ~20.19` matches the oldest supported extension-host Node.

## Known limitations
- Automatic refresh pauses while the window is unfocused; another VS Code window learns about a switch made elsewhere on its next refresh (focus or interval).
- Cross-account and strategy switches were not executed live during development; their handling is tested against fixtures derived from the CLI source.
- The dashboard does not survive a window reload (no `WebviewPanelSerializer`); reopen it with the command.
- The `spend` amounts are shown exactly as the CLI reports them (`used / limit currency`); their unit has not been verified.
- A real move/swap between two occupied slots has not been executed during development (fixture-tested only).
- The opt-in end-to-end test (`CSWAP_E2E_MUTATE=1 npm run test:integration`) sets and removes an alias on an inactive slot without one; it is skipped by default.
- Not implemented on purpose: priority, directory mappings, `cswap run`, add/remove/import/export, purge, and the auto-switch `--model`/API-key options (reasons in docs/CLI-CONTRACT.md). Auto-switch itself and its main rules are supported since 0.3.0.
- The webview DOM itself has no automated tests (host-side model, protocol validation and table logic are unit-tested; the panel/message bridge is covered by extension-host tests).
- The filter is not persisted across window reloads.
- Killing a timed-out process is best-effort (`child.kill()`); a process tree is not killed explicitly.
- Alias, `fiveHour`, switch JSON output and non-`ok` `usageStatus` values have not been observed.
- Published as `nguyenthanhdat.cswap-manager` under the MIT license; the extension ID must stay stable across releases.

## Localization and picker layout (0.2.0)
- Runtime strings go through one translator (`src/vscode/l10n.ts` → `localize`, exposed to the core as the injected `t`). Bundles live in `l10n/bundle.l10n.<lang>.json` keyed by the English text; `cswapManager.language` (`auto` → VS Code display language) picks the bundle, independently of VS Code's own language, and a change re-renders every surface. Contributions (command titles, settings, welcome views) use `package.nls.<lang>.json`, which VS Code applies only for its own display language.
- `test/unit/l10n.test.ts` extracts every translator call with the TypeScript compiler API and fails on non-literal keys, missing or stale translations, changed `{n}` placeholders, or altered `command:` links in `package.nls.vi.json`.
- Not translated on purpose: the diagnostics report (meant for support, kept in English), compact durations such as `4d 0h` (same notation as the cswap CLI), and cswap's own error messages.
- The Switch Account picker groups accounts (`quickSwitchGroup`): current; available sorted by highest usage ascending; at limit (critical threshold) sorted by soonest future reset; disabled or without usage last. Rows show text usage bars per window (10 cells for one window, 6 for several) and the next reset; plan, scopes and data age move to the detail line, and the subscription status is only shown when the plan has expired.

## Automatic switching (0.3.0)
- `AutoSwitchService` (core) schedules `cswap auto --once --json` every `autoswitch.intervalSeconds` (read from `cswap config`, minimum 15 s; first check 5 s after enabling). Each tick is a short process that exits by itself, so turning auto-switch off never kills cswap mid-switch. A real tick is treated as a mutation (no cancellation, ≥ 120 s timeout); a dry run as a read.
- Modes (`cswapManager.autoSwitch.mode`, `application` scope, read from user settings only, in `restrictedConfigurations`): `off` (default), `notify` (dry runs; notify once per would-be switch, with "Switch now"), `switch` (modal confirmation when turned on from the menu; after every switch a status-verified refresh confirms the new active account before the notification says so).
- Ticks run through the shared `OperationGate` (skipped while a manual switch or account change runs) and only in the window holding a `FileLease` (`globalStorage/auto-switch.lease.json`, heartbeat, stale after 3 × interval), so several VS Code windows do not all poll.
- Notices are de-duplicated: a would-be switch or "all accounts at limit" is reported once until the situation changes; errors only after 3 failed ticks in a row. Tick outcomes are logged without emails.
- Rules editor: only `autoswitch.threshold`, `weeklyThreshold`, `cooldownSeconds`, `intervalSeconds` and `strategy`, validated like cswap before `cswap config set/unset`, then re-read to confirm.
- Limitation: auto-switch only runs while VS Code is open (Windows has no cswap background service; the macOS menu bar app is out of scope).

## Quick settings and strategies (0.4.0)
- `src/vscode/quickSettings.ts` is a QuickPick over the common settings, labelled by the extension's own l10n (VS Code's Settings page only follows VS Code's display language). Row models and labels are pure (`src/core/presentation/quickSettings.ts`) and unit-tested. Toggles change in place; enum rows open a sub-picker with the current value highlighted and return to the list. Writes go to the user scope; if a workspace value still overrides a window-scoped setting, the user is told.
- `confirmSwitch` and `autoSwitch.mode` keep their user-scope-only reads; "Switch, don't ask again" writes `confirmSwitch=false` to user settings.
- Auto-switch strategies are cswap's (`cswap auto --strategy` choices, verified in the 1.2.0 source). The extension never ranks accounts for automatic switching itself; it stores `autoswitch.strategy` through `cswap config set` (verified by reading it back). The one-step "use quota before it resets" preset saves `consume-first` before turning `switch` mode on, so no tick runs with the old strategy.
- A manual one-shot `cswap auto --once --strategy …` from the switch picker was considered and left out: such a tick is subject to cswap's cooldown and thresholds, so a click would often end in "no action".
- Session impact (from cswap's source, `_print_switch_followup`): a restart is never required; Claude Code drops its cached token when the credentials file changes (next request) or after the macOS Keychain cache TTL (~30 s).

## Status bar customization (0.5.0)
- One progress bar style (`display.barStyle`) is used everywhere: sidebar rows, the switch picker and the status bar (`usageBar` in `format.ts`).
- `statusBar.mode` keeps its preset values (`slotUsage`, `slot`, `nameUsage`, `hidden`), now defined as fixed part lists; `custom` uses `statusBar.parts`. `buildStatusBarModel` renders parts in a fixed order and never produces an empty item.
- Buttons are separate status bar items (`cswapManager.button.*`) right of the account and auto-switch items, shown only while the account item is (so `hidden` still hides everything). Only actions the status bar cannot otherwise reach are offered: switching is the account item's own click, and filter/sort act on the Accounts view, so they are not buttons.
- Live preview: `StatusBarController.preview()` overrides the saved look in memory while a picker is open; ending the picker (save, Back, Esc) clears it, so nothing is written until Enter.
- Navigation: every screen opened from Quick Settings has VS Code's `QuickInputButtons.Back`; Esc (or focus moving away) closes everything, because a hidden QuickPick cannot tell Esc from focus loss.

## Auto-switch security review (0.3.1)
An independent read-only review of the 0.3.0 auto-switch code found 1 medium, 7 low and 6 info issues (no critical/high). All are fixed, each with a regression test in `test/unit/autoSwitch.test.ts`:
- **M1** A mode change while the lease file was being acquired could still start a real (non-dry-run) tick. The mode is now re-read inside the operation gate immediately before cswap starts, and only `switch` runs without `--dry-run`.
- **L1** Wrongly typed values from `cswap config` (e.g. a string interval) could produce a NaN interval: back-to-back ticks and a lease that every window treated as stale. Rule values are type-checked and the interval is clamped to 15 s – 1 h.
- **L2** An unwritable lease file caused an unhandled rejection every interval and no user-visible state. It now counts as a failed tick (reported after 3 in a row); lease release errors are ignored.
- **L3** A real switch (exit 0) without a readable `switch` event produced no notification. It is now verified and notified.
- **L4/L5** CLI error text in notifications is redacted and length-capped; the rules summary is link-neutralised and only shows cswap-style strategy codes.
- **L6** A real tick has a 10-minute safety timeout (manual switch: 2 minutes); after any real tick that does not end cleanly the state is refreshed.
- **L7** `cswapManager.autoSwitch.mode` has `ignoreSync: true`, so Settings Sync cannot turn automatic switching on on another machine.
- Info: a lease heartbeat far in the future counts as stale; a `mismatch` verification names the slot that is actually active; the rules editor compares the value it wrote with what cswap reports; the rules summary includes the check interval.
- Accepted: two windows starting at the same instant can both run one tick (write-then-verify is not a mutex); cswap's own state lock and cooldown prevent a double switch, so the cost is a duplicate poll. If VS Code exits during a real tick, the cswap process is left to finish on its own.
