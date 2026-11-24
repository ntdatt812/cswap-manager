# Implementation plan

## Phase 0 — repository reconnaissance
- Inspect workspace, Git state, existing code, Node, VS Code tooling.
- If no existing extension, create scaffold.
- Read all project docs.
- Report proposed file structure and phase-1 scope.
**Gate:** user agrees or explicitly instructs proceed.

## Phase 1 — core adapter and tests
- CLI path/config discovery.
- Safe process runner with timeout, cancellation, output bounds and errors.
- Parse list/status JSON tolerantly.
- Normalize account and dynamic usage windows/scopes.
- Merge status/list only by reliable slot/identity.
- Test parsing, schema drift, execution errors, timeout, path handling.
- Implement diagnostics command.
**Acceptance:** compile/tests pass; no secret leakage; can read live CLI list/status using configured path; stale-data/error states defined.

## Phase 2 — sidebar account tree
- Account tree provider.
- Active account prominent.
- Rows and detail tooltips.
- Refresh and empty/error/stale states.
- Search/filter if appropriate.
**Acceptance:** accurate live accounts, stable slot order, dynamic usage, refresh and failure states.

## Phase 3 — status bar and quick switch
- Configurable status bar display.
- QuickPick searchable list.
- Switch by account and strategy.
- Verify post-switch using fresh list/status.
- Progress/errors; avoid duplicate switch operations.
**Acceptance:** switching tested, status reflects verified active account.

## Phase 4 — dashboard and detail
- Webview dashboard.
- Summary and table.
- Dynamic usage.
- Account detail and freshness.
- Safe message bridge and accessible design.
**Acceptance:** theme-aware, responsive, secure webview, consistent data.

## Phase 5 — verified account management
Select operations one by one only after CLI behavior and safety verified:
- alias
- enable/disable
- threshold
- priority
- swap/move
- mapping
- run workflow (assess terminal API and scope)
- auto-switch config
Add/remove/import/export remain deferred until their security and workflows are well understood. Do not implement purge or token-based onboarding.

## Phase 6 — release quality
- Tests, lint, compile, package VSIX.
- Security review.
- README, usage, troubleshooting, changelog.
- VSIX install instructions and known limitations.
**Acceptance:** VSIX artifact created and validated, tests/results documented.
