import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CswapCli } from '../core/cli/cswapCli';
import { isNewer, latestFromPypi, PYPI_URL, upgradeCommand, type InstalledWith } from '../core/cli/cswapUpdate';
import type { CachedExecutableResolver } from '../core/cli/executableResolver';
import type { CliVersion } from '../core/cli/version';
import type { Logger } from './logger';
import { t } from './presentation';
import { createGuardedTerminal } from './terminals';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'cswapManager.cswapUpdate.lastCheck';
const DISMISSED_KEY = 'cswapManager.cswapUpdate.dismissed';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Whether uv's or pipx's tool folder holds claude-swap (folder existence only; nothing is read). */
function installedWith(): InstalledWith {
  const home = os.homedir();
  const env = process.env;
  const dataHome = env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
  const uvDirs = [
    env.UV_TOOL_DIR,
    process.platform === 'win32' && env.APPDATA !== undefined ? path.join(env.APPDATA, 'uv', 'tools') : undefined,
    path.join(dataHome, 'uv', 'tools'),
  ];
  const pipxDirs = [env.PIPX_HOME, path.join(home, 'pipx'), path.join(home, '.local', 'pipx'), path.join(dataHome, 'pipx')].map((dir) =>
    dir === undefined ? undefined : path.join(dir, 'venvs'),
  );
  const holds = (dirs: ReadonlyArray<string | undefined>): boolean => dirs.some((dir) => dir !== undefined && fs.existsSync(path.join(dir, 'claude-swap')));
  return { uv: holds(uvDirs), pipx: holds(pipxDirs) };
}

/** One GET with a deadline for the whole request (the socket timeout alone only limits idle time). */
function fetchText(url: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      request.destroy();
      resolve(undefined);
    }, timeoutMs);
    const finish = (value: string | undefined): void => {
      clearTimeout(deadline);
      resolve(value);
    };
    const request = https.get(url, { timeout: timeoutMs, headers: { Accept: 'application/json', 'User-Agent': 'cswap-manager-vscode' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(undefined);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          request.destroy();
          finish(undefined);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      response.on('error', () => finish(undefined));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => finish(undefined));
  });
}

export interface CswapUpdateState {
  readonly current?: CliVersion;
  readonly latest?: CliVersion;
}

/**
 * Checks PyPI for a newer cswap at most once a day (`cswapManager.checkCswapUpdates`), and offers to
 * run the upgrade in a terminal the user can watch. Sends nothing but a plain GET for the package.
 */
export class CswapUpdateCheck {
  private state: CswapUpdateState = {};

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cli: CswapCli,
    private readonly resolver: CachedExecutableResolver,
    private readonly logger: Logger,
    private readonly enabled: () => boolean,
  ) {}

  getState(): CswapUpdateState {
    return this.state;
  }

  /** `force` ignores the daily limit and the "skip this version" choice (from Quick Settings). */
  async check(force = false): Promise<CswapUpdateState> {
    if (!force && !this.enabled()) {
      return this.state;
    }
    const last = this.context.globalState.get<number>(LAST_CHECK_KEY, 0);
    if (!force && Date.now() - last < CHECK_INTERVAL_MS) {
      return this.state;
    }
    // Recorded first, so windows that start together do not all check; the two reads run side by side.
    await this.context.globalState.update(LAST_CHECK_KEY, Date.now());
    const [version, body] = await Promise.all([this.cli.version(), fetchText(PYPI_URL, 5000)]);
    const current = version.ok ? version.value : undefined;
    const latest = body === undefined ? undefined : latestFromPypi(body);
    this.state = { ...(current === undefined ? {} : { current }), ...(latest === undefined ? {} : { latest }) };
    if (current === undefined || latest === undefined) {
      this.logger.info('cswap update check: version unavailable.');
      return this.state;
    }
    const dismissed = this.context.globalState.get<string>(DISMISSED_KEY);
    if (isNewer(latest, current) && (force || dismissed !== latest.text)) {
      void this.offer(current, latest);
    }
    return this.state;
  }

  async upgrade(): Promise<void> {
    const resolution = await this.resolver.resolve();
    const command = resolution.ok ? upgradeCommand(resolution.path, installedWith()) : undefined;
    if (command === undefined) {
      void vscode.window.showInformationMessage(t('Update cswap with the tool you installed it with, for example "uv tool upgrade claude-swap".'));
      return;
    }
    // A visible terminal: the user sees the upgrade and its result. The command is a fixed string. It
    // starts in the home folder, and the guarded terminal never runs a `uv`/`pipx` from the project.
    const terminal = createGuardedTerminal({ name: t('Cswap: update cswap'), cwd: os.homedir() });
    terminal.show();
    terminal.sendText(command, true);
    void vscode.window.showInformationMessage(t('When the update finishes in the terminal, refresh Cswap to use the new version.'));
  }

  private async offer(current: CliVersion, latest: CliVersion): Promise<void> {
    const update = t('Update');
    const skip = t('Skip this version');
    const choice = await vscode.window.showInformationMessage(t('cswap {0} is available (you have {1}).', latest.text, current.text), update, skip);
    if (choice === update) {
      await this.upgrade();
    } else if (choice === skip) {
      await this.context.globalState.update(DISMISSED_KEY, latest.text);
    }
  }
}
