import { isRecord } from '../model/json';
import { parseCliVersion, type CliVersion } from './version';

/** PyPI JSON API for the package cswap is published as (the same source cswap's own check uses). */
export const PYPI_URL = 'https://pypi.org/pypi/claude-swap/json';

/** Reads `info.version` from the PyPI JSON; pre-releases are ignored, like cswap does for final releases. */
export function latestFromPypi(body: string): CliVersion | undefined {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return undefined;
  }
  const info = isRecord(root) ? root['info'] : undefined;
  const version = isRecord(info) ? info['version'] : undefined;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version.trim())) {
    return undefined;
  }
  return parseCliVersion(version);
}

export function isNewer(candidate: CliVersion, current: CliVersion): boolean {
  if (candidate.major !== current.major) {
    return candidate.major > current.major;
  }
  if (candidate.minor !== current.minor) {
    return candidate.minor > current.minor;
  }
  return candidate.patch > current.patch;
}

/** Which installers hold a claude-swap environment on this machine (their tool folders exist). */
export interface InstalledWith {
  readonly uv: boolean;
  readonly pipx: boolean;
}

/**
 * The upgrade command cswap itself recommends (`cswap upgrade` cannot replace its own running .exe
 * on Windows, so it only prints this). A path inside an installer's folder decides; uv and pipx both
 * put launchers in `~/.local/bin`, so there the installer whose environment exists decides, and
 * nothing is suggested when that is ambiguous.
 */
export function upgradeCommand(executablePath: string, installed: InstalledWith): string | undefined {
  const normalized = executablePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/pipx/')) {
    return 'pipx upgrade claude-swap';
  }
  if (normalized.includes('/uv/')) {
    return 'uv tool upgrade claude-swap';
  }
  if (normalized.includes('/.local/bin/') && installed.uv !== installed.pipx) {
    return installed.uv ? 'uv tool upgrade claude-swap' : 'pipx upgrade claude-swap';
  }
  return undefined;
}
