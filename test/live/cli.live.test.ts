/**
 * Opt-in smoke test against the real, locally installed cswap (`npm run test:live`).
 * Runs only read-only commands and prints structural facts — never emails, UUIDs or raw output.
 */
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { describe, it } from 'node:test';
import { CswapCli } from '../../src/core/cli/cswapCli';
import { nodeResolverEnvironment, resolveCswapExecutable } from '../../src/core/cli/executableResolver';
import { NodeProcessRunner } from '../../src/core/cli/processRunner';
import { assessCompatibility } from '../../src/core/cli/version';
import { collectDiagnostics, formatDiagnosticsReport } from '../../src/core/diagnostics/diagnostics';
import { RefreshService } from '../../src/core/service/refreshService';

const homeDir = os.homedir();
const cli = new CswapCli({
  runner: new NodeProcessRunner(),
  resolveExecutable: () => resolveCswapExecutable(process.env.CSWAP_PATH, nodeResolverEnvironment()),
  settings: () => ({ timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 }),
  workingDirectory: homeDir,
  baseEnv: process.env,
  homeDir,
});

describe('live cswap CLI (read-only)', () => {
  it('reads the version', async () => {
    const outcome = await cli.version();
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.error.kind);
    console.log(`version ${outcome.value.text}; compatibility ${assessCompatibility(outcome.value).level}; source ${outcome.meta.executableSource}`);
  });

  it('reads and normalizes list --json and status --json via the refresh service', async () => {
    const service = new RefreshService({ cli });
    const result = await service.refresh({ trigger: 'manual', verifyActive: true });
    assert.ok(result.ok, result.ok ? '' : result.error.kind);
    const { snapshot } = result;
    assert.ok(snapshot.accounts.length > 0);
    assert.equal(snapshot.active.verifiedWithStatus, true);
    const windows = new Set(snapshot.accounts.flatMap((account) => account.usage?.windows.map((window) => window.key) ?? []));
    console.log(
      `accounts ${snapshot.accounts.length}; slots ${snapshot.accounts.map((a) => a.slot).join(',')}; active slot ${snapshot.active.slot ?? '?'} (${snapshot.active.consistency}); windows ${[...windows].join(',')}; warnings ${snapshot.warnings.length}`,
    );
  });

  it('produces a diagnostics report without personal data', async () => {
    const report = await collectDiagnostics({
      environment: { extensionVersion: 'test', vscodeVersion: 'n/a', platform: process.platform, osRelease: os.release(), arch: process.arch, nodeVersion: process.version },
      settings: { cliPathSetting: '', timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 },
      homeDir,
      resolveExecutable: () => resolveCswapExecutable(undefined, nodeResolverEnvironment()),
      cli,
      now: Date.now,
    });
    const text = formatDiagnosticsReport(report, homeDir);
    assert.equal(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), false, 'no email in report');
    assert.equal(text.includes(homeDir), false, 'home directory redacted');
    console.log(text);
  });
});
