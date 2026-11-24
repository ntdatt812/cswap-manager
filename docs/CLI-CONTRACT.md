# CLI contract — observations and verification status

## Environment
- Observed executable: `%USERPROFILE%\.local\bin\cswap.exe`
- Observed version: `cswap 1.1.0`
- OS: Windows
- Shell: PowerShell 5.1

## Observed commands
From user-provided `cswap --help`:
- `cswap list`
- `cswap status`
- `cswap switch` (rotate)
- `cswap switch <num|email>`
- `cswap add`
- `cswap add-token`
- `cswap remove <num|email>`
- `cswap disable <num|email>`
- `cswap enable <num|email>`
- `cswap threshold <num|email> <pct>` and `--unset`
- `cswap threshold` (list global/default and overrides)
- `cswap priority <num|email> <tier>`
- `cswap priority` (list)
- `cswap run <num|email> [-- ...]`
- `cswap map <num|email> [path]`, `cswap map` (list)
- `cswap unmap [path]`
- `cswap alias <num|email> <name>` and `--unset`; `cswap alias` list
- `cswap swap <a> <b>`
- `cswap move <a> <slot>`
- `cswap auto`
- `cswap config [set KEY VALUE]`
- `cswap unclaimed [--purge ID]`
- `cswap export <path>`
- `cswap import <path>`
- `cswap import-usage <path>`
- `cswap tui`, `cswap watch`
- `cswap upgrade`
- `cswap purge` (extension must not implement)

## Observed options
- `--json` for list, status, switch
- `--strategy {best,next-available}` for bare switch
- `--model NAMES` with strategy
- `--slot NUM` with add/add-token
- `--email EMAIL`
- `--alias NAME` with add
- `--force` (including switch force activation without backup, and import overwrite)
- `--full` for export
- `--hold SECONDS` for import-usage
- `--version`
- `--debug`
- `--token-status` with list
- `--auto-switch`/`--no-auto-switch` for menubar contexts (macOS-specific)

## JSON
Observed sample command:
- `cswap list --json`: schemaVersion, activeAccountNumber, accounts[].
- `cswap status --json`: schemaVersion, active, totalManagedAccounts.
- switch supports JSON according to help, but its exact output and exit codes are not yet observed.

## Verification status
- List JSON shape: observed in user samples.
- Status JSON shape: observed in user samples.
- Switch target syntax: observed in CLI help; execution and switch JSON response not yet validated.
- Switch strategies: help observed; output and semantics not independently tested.
- Other listed operations: listed in help only; behavior/output/schema not independently tested.
- Treat all non-observed behaviors as unverified. Do not implement until validated.

## Phase 1 verification (2026-11-24, cswap 1.1.0, Windows 11, Node 24)
Probed with read-only commands only (`--version`, `--help`, `list --json`, `status --json`, `alias`); output was viewed redacted.
- `cswap --version` → stdout `cswap 1.1.0`, exit 0.
- `cswap list --json` → exit 0, ~260–330 ms, empty stderr. Fields observed per account: `number`, `email`, `organizationName`, `organizationUuid`, `isOrganization`, `active`, `usageStatus` (`ok`), `usage` { `sevenDay` {...}, `scoped[]` { ..., `name` } }, `loginExpiresAt`, `plan` { `label`, `tier`, `organizationType`, `billingType`, `subscriptionStatus`, `planDisplayName`, `expired`, `fetchedAt` }, `usageFetchedAt`, `usageAgeSeconds`.
  - Only the `sevenDay` window was present (no `fiveHour`), even though `--help` mentions 5h/7d quotas.
  - `projectedExhaustionAt` is absent from some scoped entries — optional fields really are optional.
  - Timestamps mix `Z` and `+00:00` offsets and include microseconds (`2026-11-24T07:59:59.701829+00:00`); V8 `Date.parse` accepts them.
- `cswap status --json` → exit 0. `active` has `number`, `email`, org fields, `managed`, `usageStatus`, `usage`, `usageFetchedAt`, `usageAgeSeconds`; **no** `plan`, `loginExpiresAt` or boolean `active`. `totalManagedAccounts` at top level.
- `list` and `status` agreed on the active slot (`activeAccountNumber` = flagged account = `status.active.number`).
- The "newer version available" notice is written to **stderr** with ANSI colour codes; it did not appear on stdout in JSON mode.
- Argument errors (`--bogusflag`, unknown command) → exit code **2**, stdout empty, argparse `usage:` + `cswap: error: ...` on stderr.
- `cswap alias` → `No aliases set`. Whether `list --json` carries an alias field is therefore **unverified**; the parser does not read one.
- Executable: `~/.local/bin/cswap.exe` is a 47 KB uv-tool trampoline (`claude-swap.exe` is an identical sibling). Node `spawn(..., { shell: false })` runs it by bare name, backslash path or forward-slash path. A `.cmd` path throws `EINVAL` synchronously (Node's CVE-2024-27980 hardening); a missing path emits `ENOENT` asynchronously.

## Phase 3 verification — switch (2026-11-24)
Sources: the installed package's README (`claude_swap-1.1.0.dist-info/METADATA`, "JSON output for scripting") and source (`claude_swap/cli.py`, `switcher.py`, `json_output.py`), read without touching credential files; plus two live probes.
- `cswap switch <num> --json` and `cswap switch --strategy {best,next-available} --json` print one JSON object: `schemaVersion`, `switched` (bool), `from`/`to` (`{number, email}` or `null`), `strategy` (`direct` for a slot switch), `reason`, `message`, `warnings[]`, and optionally `models`/`modelSource`.
- Reasons seen in source: `switched`, `already-active`, `already-best`, `candidates-exhausted`, `only-one-account`, `usage-unavailable`, `unmanaged-account`, `no-valid-target` (and `activated` with `--force`, which the extension never uses).
- Exit codes: `0` for a switch **and** for a no-op; `1` for a handled error with `{"schemaVersion":1,"error":{"type","message"}}` on stdout; `2` argparse error; `130` cancelled. The update notice is suppressed in JSON mode.
- In JSON mode a bare/strategy switch never auto-adds an unmanaged login (it reports `unmanaged-account`); without `--json` it would.
- Switching to the already-active slot short-circuits before any write when the live login matches the slot's backup (it may reconcile a diverged login — cswap's own safe path).
- **Live probe 1:** `cswap switch 5 --json` with slot 5 active → exit 0, `switched:false`, `reason:"already-active"`, `strategy:"direct"`, empty stderr, active unchanged.
- **Live probe 2:** `cswap switch 99 --json` → exit 1, `{"error":{"type":"AccountNotFoundError","message":"Account-99 does not exist"}}`, active unchanged.
- **Not run live:** a cross-account switch and strategy switches (they would change the login used by running Claude Code sessions). Covered by fixture tests built from the source shape.
- `list --json` optional row fields found in source: `alias`, `disabled`, `threshold`, `lastGoodUsage`/`lastGoodFetchedAt`/`lastGoodAgeSeconds`, `usageError`/`usageRetryAt`; `usage` may contain `fiveHour`, `sevenDay`, `spend`, `scoped`. `usageStatus` values: `ok`, `token_expired`, `api_key`, `keychain_unavailable`, `relogin_required`, `foreign_credential`, `no_credentials`, `unavailable`. The extension now reads `alias` and `disabled`.

## Phase 5 verification — account policy (2026-11-24)
Sources: `claude_swap/cli.py` (`_alias_command`, `_threshold_command`, `_swap_command`, `_move_command`, main dispatch for `disable`/`enable`), `switcher.py` (`set_alias`, `unset_alias`, `set_account_threshold`, `set_account_disabled`, `swap_accounts`, `move_account`, `_refuse_session_shell`) and `models.py` (`normalize_alias`, `normalize_account_threshold`). Plus reversible live probes on non-active slot 1, with the before/after policy state compared (identical).

| Command | Output | Verified behaviour |
|---|---|---|
| `alias <num> <name>` | text, exit 0 | stored lower-cased (`Cswap-Probe2` → `cswap-probe2`); renames an existing alias; `^[a-z0-9_.-]+$`, not all digits, not starting with `-`; duplicate alias → error |
| `alias <num> --unset` | text, exit 0 | idempotent |
| `threshold <num> <pct>` / `--unset` | text, exit 0 | 50–99.9 only (150 and 10 → exit 1 naming the range); same value is a no-op; affects cswap auto-switch for that account |
| `disable <num>` / `enable <num>` | text, exit 0 | idempotent; disabled accounts are skipped by auto-switch, rotation and the best/next-available strategies but remain direct switch targets |
| `move <num> <slot>` | text, exit 0 | same slot → "Already in slot" no-op; slot must be a positive integer; occupied slot → swap |
| `swap <a> <b>` | text, exit 0 | unknown slot → exit 1 |

- Errors: exit 1 with `Error: …` on stderr (no JSON envelope for these commands). The update notice may precede it on stderr.
- `list --json` reflects `alias`, `disabled` and `threshold` immediately, so the extension verifies every change through it. `priority` is **not** in `list --json`.
- All mutating commands refuse to run inside a `cswap run` session shell (`CLAUDE_CONFIG_DIR` inside a session profile).
- A swap/move between two different occupied slots was **not** executed live (it renames per-slot credential backups); per source it runs under the account file lock, and aliases, backups and session history move with the account; directory mappings key on email/org and are unaffected.
- Deferred at Phase 5; `priority`, `map`/`unmap`, `run`, `add`, `remove`, `import` and `export` were added later (see "Account lifecycle, per-project accounts and transfer" below). `purge` is never implemented.

## cswap 1.2.0 re-verification (2026-11-24)
Upgraded with `uv tool upgrade claude-swap` (1.1.0 → 1.2.0; `platformdirs` 4.14.5 → 4.14.8). The account roster and policy state were identical before and after the upgrade.
- **Source diff 1.1.0 → 1.2.0:** `json_output.py` unchanged and `SCHEMA_VERSION` still 1. Changes are in `cli.py` (`cswap run` now writes its notices to stderr; a new `interactive` flag used only by the macOS Keychain migration and always off with `--json`), `models.py`/`switcher.py` `list`/`status` **text** output (org-tag display; the `--json` paths are untouched), usage/credential internals (`oauth.py`, `migrations.py`, `session.py`, `autoswitch.py`, a new usage error reason `live-login`), `settings.py` and the TUI.
- **Help text:** identical.
- **Live probes:** `list --json` and `status --json` key shapes identical to 1.1.0; argparse error → exit 2; `switch <active> --json` → `switched:false`, `reason:"already-active"`, same key set; `switch 99 --json` → exit 1 with the same `AccountNotFoundError` envelope; the full reversible alias/threshold/disable/enable/move/swap probe set behaved exactly as on 1.1.0 and restored the state.
- The "newer version available" stderr notice no longer appears (1.2.0 is the latest release at the time of testing).
- Result: the 1.2 line is marked **tested** in `core/cli/version.ts`; 1.3+ and 2.x are reported as untested (still parsed tolerantly).

## Safety
Do not invoke purge. Do not use add-token with a raw token in a process argument. Avoid exposing token diagnostics. For risky commands, require explicit confirmation and preview.

## Auto-switch verification (cswap 1.2.0, 2026-11-24)
Sources: `cswap auto --help`, `cswap config --help`, `claude_swap/autoswitch.py` (event classes, no-switch reasons, state lock) and live probes.
- `cswap auto --once --json` evaluates once and exits: **0** switched · **1** error · **2** no action · **3** blocked. Each line on stdout is one JSON event: `poll` (active `{number,email}`, `threshold`, `headroomPct`, `windowsPct`), `switch` (`trigger`, `from`, `to`, `warnings`, `dryRun`), `no-switch` (`reason`, `detail`), `account-quarantined` / `account-unquarantined` (`number`, `email`, `reason`), `all-exhausted` (`earliestResetAt`), `error` (`message`, `transient`), `config-warning`, and `sleep` (loop mode only).
- `--dry-run` "evaluates and reports, but never switches or writes state". Live probe: exit 2, `poll` + `no-switch` (`below-threshold`), active account unchanged.
- No-switch reasons in source: `below-threshold`, `cooldown`, `no-qualifying-candidate`, `no-viable-target`, `no-candidates`, `stale-usage`, `active-usage-unknown`, `reset-unknown`, `no-comparison`, `unmanaged-active-account`, `no-active-account`, `active-idle`, `active-api-key`, `already-active`, `already-consuming-soonest`, `already-consuming-priority`.
- A state file lock serialises concurrent engines (loop and cron `--once`), so overlapping ticks make one decision; the extension still runs ticks from a single window.
- `cswap config --json list` → `{schemaVersion, path, settings:[{key, value, isSet}], unrecognized}`. `path` contains the home directory and is never read by the extension. `config set autoswitch.threshold 85` / `config --json get` / `config unset` worked and were reverted (config identical afterwards). Invalid values exit 1: threshold outside 50–99.9; strategy outside `best, weekly-first, consume-first, priority-consume-first`.
- Not used: the long-running `cswap auto` loop (stopping it would mean killing a process that may be mid-switch), the `--model` flag (the extension sets `autoswitch.model` instead), `--include-api-key-accounts`.

## Account lifecycle, per-project accounts and transfer (cswap 1.2.0, 2026-11-24)
Sources: `cli.py` (argument checks and dispatch), `switcher.py`, `mappings.py`, `transfer.py`; live probes only where they change nothing (listed below). None of these commands has `--json`; the extension reads the fixed English lines quoted here and refuses anything else (`unexpected-shape`).
- **`priority`** — `priority` lists `Account priorities (higher first; default 0):` then `  Account-N  <email>  <tier>`; `priority <slot> <0–1000>` sets, `priority <slot> --unset` clears. Not in `list --json`, so the extension reads the list back after each change and matches by email.
- **`autoswitch.model`** — `config set autoswitch.model <names|all>`; names match `usage.scoped[].name` case-insensitively, `all` means every per-model window. Used by `switch --strategy best|next-available` and `auto`. The extension accepts `all` or up to 10 comma-separated plain names (letters, digits, space, `.`, `_`, `-`).
- **`add [--slot N] [--alias A]`** — prints `Added Account N`, `Updated credentials for Account N` or `Moved from slot X → N`. It prompts only when `--slot` is occupied ("Cancelled" otherwise); the extension offers free slots only.
- **`remove <slot>`** — always prompts `[y/N]` with no flag to skip it; prints `Removed Account-N`. The extension confirms in a modal first, then answers `y` on stdin (stdin is otherwise closed). Refused while a session-mode claude uses the account.
- **`map <slot> <path>` / `unmap <path>` / `map`** — list: `Directory mappings:` then `  <path> → N: <email>` or `(account removed)`, or `No directory mappings yet.` Paths are stored lower-case with backslashes on Windows; the longest mapped parent wins. Paths passed by the extension are absolute and never start with `-`.
- **`run [slot]`** — starts claude with `CLAUDE_CONFIG_DIR` under `<backup>\sessions\…`; the global login is unchanged. Refuses API-key accounts; claude must be on `PATH`. Inside such a session `add`, `remove`, `switch`, `alias`, `swap` and `move` are refused. The extension starts it as the terminal's own process (no shell).
- **`upgrade`** — on Windows it does not upgrade; it prints the `uv tool upgrade claude-swap` command and exits 1. The extension checks `https://pypi.org/pypi/claude-swap/json` (final releases only) and opens a terminal with the command for the detected installer.
- **`export <path> [--account N] [--full]`** — writes the JSON envelope (format 1, `encrypted:false`, OAuth logins included) atomically with owner-only permissions, not following a symlink at the destination; `-` writes to stdout. Summary on **stderr**: one `Skipping Account-N (…)` line per slot without stored login/config, then `Exported N account(s) to <path>`. `--full` adds the whole `~/.claude.json` and credential blob (MCP/plugin OAuth state, device token); the extension never passes `--full` or `-`.
- **`import <path> [--force]`** — validates every entry before writing anything. Existing accounts (same email + organization) are skipped unless `--force`; a slot whose stored login is quarantined as dead is replaced without it. Stderr: `Imported … → slot N`, `Skipped … (already exists, use --force)`, `Overwrote …`, `Replaced …`, then `Done: A imported, B overwritten, C skipped[, D replaced (dead token)]`, and `Note: … — activate the imported credentials with: cswap --switch-to N --force` when the live login's slot was rewritten. The extension never passes `-`.
- **`import-usage <path> [--hold S]`** — reads another machine's `list --json` (`schemaVersion` 1); rows with `usageStatus` "ok" are matched by email + organization and adopted unless the local reading is newer. `--hold S` stops local fetching for those accounts for S seconds (0 lifts a hold). Stderr ends with `Done: A adopted, B kept, C skipped[; …]`.
- All three transfer commands exit 1 with `Error: <message>` on stderr on failure. Probes run (nothing read or written): `import-usage <missing file> --hold 600` → `Error: usage file not found: …`; `import <missing file> --force` → `Error: import file not found: …`; `export <file> --account 999` → `Error: account not found: 999`.
- Still not used: `purge` (never), `add-token` (a token would sit in a process argument), `unclaimed`, `tui`/`watch`, `menubar` (macOS).
