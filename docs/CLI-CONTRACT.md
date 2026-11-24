# CLI contract — observations and verification status

## Environment
- Observed executable: `C:\Users\ntdat\.local\bin\cswap.exe`
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
- Deferred (not implemented): `priority` (not visible in JSON; only used by `auto --strategy priority-consume-first`), `map`/`unmap` (text-only output), `run` (marked `[EXPERIMENTAL]` by cswap and interactive), `auto`/`config` (daemon/settings; must not be changed implicitly), `add`/`add-token`/`remove`/`import`/`export` (per plan), `purge` (never).

## Safety
Do not invoke purge. Do not use add-token with a raw token in a process argument. Avoid exposing token diagnostics. For risky commands, require explicit confirmation and preview.
