export interface CliVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Normalized `major.minor.patch` text. */
  readonly text: string;
}

export type CompatibilityLevel = 'tested' | 'untested' | 'unknown';

export interface CompatibilityAssessment {
  readonly level: CompatibilityLevel;
  readonly version?: CliVersion;
}

/**
 * CLI release lines verified against this extension (source review + live probes, see
 * docs/CLI-CONTRACT.md): 1.1.x was the development baseline, 1.2.0 was re-verified on upgrade.
 */
export const TESTED_CLI_LINES: ReadonlyArray<{ readonly major: number; readonly minor: number }> = [
  { major: 1, minor: 1 },
  { major: 1, minor: 2 },
];

/** Parses the output of `cswap --version` (observed: `cswap 1.1.0`). */
export function parseCliVersion(stdout: string): CliVersion | undefined {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?=$|[\s+-])/m.exec(stdout.trim());
  if (!match) {
    return undefined;
  }
  const [major, minor, patch] = [match[1], match[2], match[3]].map((part) => Number(part));
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return { major, minor, patch, text: `${major}.${minor}.${patch}` };
}

/**
 * Compatibility is advisory: parsing is tolerant, so an untested version is still used, but the UI
 * and diagnostics should say so.
 */
export function assessCompatibility(version: CliVersion | undefined): CompatibilityAssessment {
  if (version === undefined) {
    return { level: 'unknown' };
  }
  const tested = TESTED_CLI_LINES.some((line) => line.major === version.major && line.minor === version.minor);
  return { level: tested ? 'tested' : 'untested', version };
}

/** `1.3` for 1.3.0: a release line, as `TESTED_CLI_LINES` lists them. */
export function releaseLine(version: CliVersion): string {
  return `${version.major}.${version.minor}`;
}

/**
 * Whether moving to `latest` stays on ground this extension was tested on: a release line in
 * `TESTED_CLI_LINES`, or a patch of the line already in use. Several commands read cswap's text
 * output (add, priority, map, export, import), which a new line may change.
 */
export function upgradeTested(current: CliVersion, latest: CliVersion): boolean {
  return assessCompatibility(latest).level === 'tested' || releaseLine(latest) === releaseLine(current);
}
