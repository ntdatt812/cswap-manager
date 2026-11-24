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
