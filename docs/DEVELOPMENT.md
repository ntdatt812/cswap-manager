# Development notes

## Purpose and approach
Build a modern, reliable, security-conscious VS Code GUI for `cswap`, with account overview, usage, switching, account settings and diagnostics. The CLI stays the only backend; the extension never reads or writes cswap's or Claude Code's files directly.

The work was done phase by phase (see `IMPLEMENTATION-PLAN.md`), starting with the CLI adapter, parsing and tests, then the Activity Bar tree, status bar and quick switch, dashboard, account management and release.

## Environment the extension was verified on
- Windows 11, PowerShell 5.1
- `cswap` 1.1.0 (development baseline), re-verified on 1.2.0, installed with `uv tool` at `%USERPROFILE%\.local\bin\cswap.exe`
- Node.js 24, VS Code 1.147
- Verified CLI commands and outputs: `docs/CLI-CONTRACT.md`

## Commands
Requires Node.js 20.19+ and VS Code 1.90+.

| Command | Purpose |
|---|---|
| `npm install` | install dev dependencies |
| `npm run compile` | type-check (extension + webview) and bundle to `dist/` |
| `npm run lint` | ESLint (type-aware) |
| `npm test` | unit tests (`node:test`, no CLI needed) |
| `npm run test:live` | read-only smoke test against the installed `cswap` (`CSWAP_PATH` overrides the path) |
| `npm run test:integration` | extension-host tests; set `VSCODE_EXECUTABLE` to a local `Code.exe` to avoid downloading VS Code; `CSWAP_E2E_MUTATE=1` also runs a reversible switch-threshold set/clear on an inactive account |
| `npm run package:vsix` | production bundle + `cswap-manager-<version>.vsix` in the project root |
| `npm run l10n:extract` | regenerate `l10n/bundle.l10n.json` (English source strings) and list missing/unused keys per translation; `npm test` fails if a translation is missing or loses a `{n}` placeholder |
| F5 ("Run Extension") | launch an Extension Development Host |
| `python scripts/build-usage-bar-icons.py` | regenerate `media/usage-bars.woff`, the slanted usage-bar cells (`cswap-slant-0…8` icons); needs `python -m pip install fonttools`, only when the cell shapes change |

## Documents
- `docs/SPEC.md`: product and UX specification
- `docs/CLI-CONTRACT.md`: observed CLI contract, verification log and deferred commands
- `docs/ARCHITECTURE.md`: structure, decisions, security design and known limitations
- `docs/IMPLEMENTATION-PLAN.md`: phased roadmap and acceptance checks
