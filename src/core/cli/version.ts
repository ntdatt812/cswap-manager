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

/** The CLI version this extension was developed and verified against. */
export const TESTED_CLI_VERSION: CliVersion = { major: 1, minor: 1, patch: 0, text: '1.1.0' };

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
 * and diagnostics should say so. Only the 1.x line with minor >= 1 has been observed.
 */
export function assessCompatibility(version: CliVersion | undefined): CompatibilityAssessment {
  if (version === undefined) {
    return { level: 'unknown' };
  }
  const tested =
    version.major === TESTED_CLI_VERSION.major && version.minor === TESTED_CLI_VERSION.minor;
  return { level: tested ? 'tested' : 'untested', version };
}
