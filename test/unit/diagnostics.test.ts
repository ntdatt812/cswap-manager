import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CliOutcome } from '../../src/core/cli/cswapCli';
import { assessCompatibility, parseCliVersion, type CliVersion } from '../../src/core/cli/version';
import { collectDiagnostics, formatDiagnosticsReport, type DiagnosticsDependencies } from '../../src/core/diagnostics/diagnostics';
import { parseListOutput, parseStatusOutput } from '../../src/core/model/parsers';
import type { ListPayload, StatusPayload } from '../../src/core/model/types';
import { fail, fixture, ok } from '../helpers/fixtures';

const HOME = 'C:\\Users\\dev';

function deps(overrides: Partial<DiagnosticsDependencies['cli']> = {}, cliPathSetting = ''): DiagnosticsDependencies {
  const list = parseListOutput(fixture('list-v1.json'));
  const status = parseStatusOutput(fixture('status-v1.json'));
  assert.ok(list.ok && status.ok);
  const version = parseCliVersion('cswap 1.1.0');
  assert.ok(version);
  const withNotice = <T>(outcome: CliOutcome<T>): CliOutcome<T> =>
    outcome.ok ? { ...outcome, meta: { ...outcome.meta, stderrNotice: 'A newer version of claude-swap is available (1.2.0).' } } : outcome;
  return {
    environment: { extensionVersion: '0.0.1', vscodeVersion: '1.99.0', platform: 'win32', osRelease: '10.0', arch: 'x64', nodeVersion: 'v20.0.0' },
    settings: { cliPathSetting, timeoutMs: 30_000, maxOutputBytes: 2_097_152 },
    homeDir: HOME,
    resolveExecutable: () => Promise.resolve({ ok: true, path: `${HOME}\\.local\\bin\\cswap.exe`, source: 'path' }),
    cli: {
      version: () => Promise.resolve(ok<CliVersion>('version', version)),
      list: () => Promise.resolve(withNotice(ok<ListPayload>('list', list.value))),
      status: () => Promise.resolve(ok<StatusPayload>('status', status.value)),
      ...overrides,
    },
    refreshState: () => ({ refreshing: false }),
    now: () => Date.parse('2026-11-24T04:00:00Z'),
  };
}

describe('diagnostics', () => {
  it('reports structure, timings and consistency without personal data', async () => {
    const report = await collectDiagnostics(deps());
    const text = formatDiagnosticsReport(report, HOME);

    assert.equal(report.list.accountCount, 2);
    assert.deepEqual(report.list.windowKeys, ['sevenDay']);
    assert.equal(report.version.compatibility, 'tested');
    assert.equal(report.active?.consistency, 'consistent');
    assert.match(text, /Resolved: ~\\\.local\\bin\\cswap\.exe \(via path\)/);
    assert.match(text, /`cswap list --json`: OK/);
    assert.match(text, /CLI notice \(redacted\): A newer version/);
    assert.match(text, /freshness: none/);

    for (const forbidden of ['@example.com', 'Example Org', '00000000-0000-4000-8000', 'C:\\Users\\dev', 'ModelA']) {
      assert.equal(text.includes(forbidden), false, `report leaked ${forbidden}`);
    }
  });

  it('reports failures by kind and redacts a configured path', async () => {
    const report = await collectDiagnostics(
      deps({ list: () => Promise.resolve(fail<ListPayload>('list', 'timeout')) }, 'C:\\Users\\dev\\tools\\cswap.exe'),
    );
    const text = formatDiagnosticsReport(report, HOME);
    assert.match(text, /`cswap list --json`: FAILED \(timeout\)/);
    assert.match(text, /cliPath: ~\\tools\\cswap\.exe/);
    assert.equal(report.active, undefined);
  });

  it('reports an unresolved executable', async () => {
    const base = deps({
      version: () => Promise.resolve(fail<CliVersion>('version', 'executable-not-found')),
      list: () => Promise.resolve(fail<ListPayload>('list', 'executable-not-found')),
      status: () => Promise.resolve(fail<StatusPayload>('status', 'executable-not-found')),
    });
    const report = await collectDiagnostics({ ...base, resolveExecutable: () => Promise.resolve({ ok: false, reason: 'not-found' }) });
    const text = formatDiagnosticsReport(report, HOME);
    assert.match(text, /Not resolved: not-found/);
    assert.match(text, /compatibility: unknown/);
  });
});

describe('compatibility', () => {
  it('treats the verified 1.1 and 1.2 lines as tested and others as untested', () => {
    assert.equal(assessCompatibility(parseCliVersion('cswap 1.1.0')).level, 'tested');
    assert.equal(assessCompatibility(parseCliVersion('cswap 1.2.0')).level, 'tested');
    assert.equal(assessCompatibility(parseCliVersion('cswap 1.2.7')).level, 'tested');
    assert.equal(assessCompatibility(parseCliVersion('cswap 1.3.0')).level, 'untested');
    assert.equal(assessCompatibility(parseCliVersion('cswap 2.0.0')).level, 'untested');
    assert.equal(assessCompatibility(undefined).level, 'unknown');
  });
});

describe('version parsing', () => {
  it('parses observed and variant formats', () => {
    assert.equal(parseCliVersion('cswap 1.1.0')?.text, '1.1.0');
    assert.equal(parseCliVersion('cswap v2.0.10\n')?.major, 2);
    assert.equal(parseCliVersion('1.2.3-beta')?.patch, 3);
    assert.equal(parseCliVersion('cswap'), undefined);
  });
});
