import * as https from 'node:https';
import * as vscode from 'vscode';
import type { CswapCli } from '../core/cli/cswapCli';
import { describeInstallStep } from '../core/cli/cswapInstall';
import {
  PYPI_URL,
  UPGRADE_MAX_OUTPUT_BYTES,
  UPGRADE_TIMEOUT_MS,
  decideUpdate,
  describeUpgradeFailure,
  latestFromPypi,
  planCswapUpgrade,
  upgradeCommandByName,
  upgradeEnvironment,
  upgradeProcessOutcome,
  upgradeRunningElsewhere,
  verifyUpgrade,
  type UpgradeFailure,
  type UpgradePlan,
  type UpgradeProcessOutcome,
  type UpgradeStep,
  type UpgradeTool,
} from '../core/cli/cswapUpdate';
import type { CachedExecutableResolver, ResolverEnvironment } from '../core/cli/executableResolver';
import type { PausableRunner } from '../core/cli/pausableRunner';
import { NodeProcessRunner, type ProcessRunner } from '../core/cli/processRunner';
import { releaseLine, upgradeTested, type CliVersion } from '../core/cli/version';
import type { OperationGate } from '../core/service/operationGate';
import type { RefreshService } from '../core/service/refreshService';
import type { Logger } from './logger';
import { t } from './presentation';
import { ProgramTerminal } from './programTerminal';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'cswapManager.cswapUpdate.lastCheck';
const DISMISSED_KEY = 'cswapManager.cswapUpdate.dismissed';
/** When a window started an upgrade (shared by the windows); cleared when it ends. */
const RUNNING_KEY = 'cswapManager.cswapUpdate.running';
/** Longer than an upgrade can take with its waits, so a window closed mid-way blocks others briefly. */
const RUNNING_STALE_MS = 10 * 60_000;
/** How long the upgrade waits for a switch or account change to finish. */
const GATE_WAIT_MS = 60_000;
/** How long it lets cswap commands already running finish before replacing cswap. */
const DRAIN_MS = 60_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

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

export interface CswapUpdateCheckDependencies {
  readonly context: Pick<vscode.ExtensionContext, 'globalState'>;
  readonly cli: Pick<CswapCli, 'version'>;
  readonly resolver: Pick<CachedExecutableResolver, 'resolve' | 'invalidate'>;
  /** For locating uv / pipx without a shell, like the installer. */
  readonly environment: ResolverEnvironment;
  readonly gate: OperationGate;
  /** The runner cswap's own commands go through; paused while cswap is replaced. */
  readonly cswapRunner: Pick<PausableRunner, 'pauseWhile'>;
  readonly refreshService: Pick<RefreshService, 'refresh'>;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly homeDir: string;
  /** `cswapManager.checkCswapUpdates`. */
  readonly enabled: () => boolean;
  /** `cswapManager.autoUpdateCswap`. */
  readonly automatic: () => boolean;
  /** Starts uv / pipx (a NodeProcessRunner by default). */
  readonly runner?: ProcessRunner;
  /** The latest final release (PyPI by default). */
  readonly fetchLatest?: () => Promise<CliVersion | undefined>;
}

async function latestOnPypi(): Promise<CliVersion | undefined> {
  const body = await fetchText(PYPI_URL, 5000);
  return body === undefined ? undefined : latestFromPypi(body);
}

/** `running`: this window is already updating; `elsewhere`: another window is. */
type Exclusive<T> = { readonly kind: 'ran'; readonly value: T } | { readonly kind: 'busy' } | { readonly kind: 'running' } | { readonly kind: 'elsewhere' };

function exitCodeText(code: number | null): string {
  return code === null ? '?' : String(code);
}

function failureMessage(failure: UpgradeFailure, tool: UpgradeTool): string {
  switch (failure.kind) {
    case 'exited':
      return failure.detail === undefined
        ? t('cswap was not updated: {0} exited with code {1}.', tool, exitCodeText(failure.exitCode))
        : t('cswap was not updated: {0} exited with code {1}: {2}', tool, exitCodeText(failure.exitCode), failure.detail);
    case 'timeout':
      return t('cswap was not updated: {0} did not finish within {1} minutes and was stopped.', tool, UPGRADE_TIMEOUT_MS / 60_000);
    case 'not-started':
      return t('cswap was not updated: {0} could not be started.', tool);
    case 'output-limit':
      return t('cswap was not updated: {0} wrote more output than expected and was stopped.', tool);
    case 'busy':
      return t('cswap was not updated: a switch or account change kept Cswap busy. Try again in a moment.');
    case 'unchanged':
      return t('{0} finished, but cswap still reports {1}.', tool, failure.version);
    case 'unverified':
      return t('{0} finished, but the cswap version could not be read afterwards.', tool);
  }
}

/** A running cswap locks its files on Windows, which is the usual reason an upgrade fails there. */
function lockHint(): string {
  return t('On Windows, a running cswap (such as a "cswap run" terminal) can block the update: close it, then try again.');
}

/**
 * Checks PyPI for a newer cswap at most once a day (`cswapManager.checkCswapUpdates`; sends nothing
 * but a plain GET for the package) and updates it: in the background when `autoUpdateCswap` is on,
 * else after the user picks *Update*. The upgrade starts the uv or pipx that installed cswap by its
 * absolute path (located without a shell), with fixed arguments, from the home folder; it waits for
 * switches and account changes to finish and holds cswap's own commands meanwhile, and only one
 * window runs it at a time.
 */
export class CswapUpdateCheck {
  private state: CswapUpdateState = {};
  private upgrading = false;
  private readonly runner: ProcessRunner;

  constructor(private readonly deps: CswapUpdateCheckDependencies) {
    this.runner = deps.runner ?? new NodeProcessRunner();
  }

  getState(): CswapUpdateState {
    return this.state;
  }

  /** `force`: the user asked (Quick Settings, command): no daily limit, and a skipped version is offered again. */
  async check(force = false): Promise<CswapUpdateState> {
    if (!force && !this.deps.enabled()) {
      return this.state;
    }
    if (this.upgrading) {
      if (force) {
        void vscode.window.showInformationMessage(t('cswap is already being updated.'));
      }
      return this.state;
    }
    const { globalState } = this.deps.context;
    const last = globalState.get<number>(LAST_CHECK_KEY, 0);
    if (!force && Date.now() - last < CHECK_INTERVAL_MS) {
      return this.state;
    }
    // Recorded first, so windows that start together do not all check; the two reads run side by side.
    await globalState.update(LAST_CHECK_KEY, Date.now());
    const [version, latest] = await Promise.all([this.deps.cli.version(), (this.deps.fetchLatest ?? latestOnPypi)()]);
    const current = version.ok ? version.value : undefined;
    this.state = { ...(current === undefined ? {} : { current }), ...(latest === undefined ? {} : { latest }) };
    if (current === undefined || latest === undefined) {
      this.deps.logger.info('cswap update check: version unavailable.');
      return this.state;
    }
    const skipped = globalState.get<string>(DISMISSED_KEY);
    const decision = decideUpdate({ current, latest, automatic: this.deps.automatic(), requested: force, skipped });
    if (decision === 'upgrade') {
      void this.upgradeAutomatically(current, latest, force, skipped === latest.text);
    } else if (decision === 'offer') {
      void this.offer(current, latest);
    }
    return this.state;
  }

  /**
   * Automatic updates: run it now; when the installer cannot be started, say how to update instead
   * (not for a version the user skipped, unless they asked for this check).
   */
  private async upgradeAutomatically(current: CliVersion, latest: CliVersion, requested: boolean, skipped: boolean): Promise<void> {
    const plan = await this.plan();
    if (plan.kind === 'run') {
      await this.upgrade(plan.step, current, latest, requested);
      return;
    }
    this.deps.logger.info(`cswap update: ${latest.text} is available; the installer was ${plan.tool === undefined ? 'not determined' : `${plan.tool}, not found`}.`);
    if (skipped && !requested) {
      return;
    }
    const skip = t('Skip this version');
    const message = `${t('cswap {0} is available (you have {1}).', latest.text, current.text)} ${manualInstructions(plan.tool)}`;
    if ((await vscode.window.showInformationMessage(message, skip)) === skip) {
      await this.deps.context.globalState.update(DISMISSED_KEY, latest.text);
    }
  }

  /**
   * Asks before updating; for a release line this extension was not tested with (`upgradeTested`)
   * it says so, also why an automatic update did not install it.
   */
  private async offer(current: CliVersion, latest: CliVersion): Promise<void> {
    const tested = upgradeTested(current, latest);
    const update = tested ? t('Update') : t('Update anyway');
    const skip = t('Skip this version');
    const available = t('cswap {0} is available (you have {1}).', latest.text, current.text);
    const untested = this.deps.automatic()
      ? t('Cswap Manager has not been tested with cswap {0} yet, so it was not installed automatically; some features may not work with it.', releaseLine(latest))
      : t('Cswap Manager has not been tested with cswap {0} yet; some features may not work with it.', releaseLine(latest));
    const choice = await vscode.window.showInformationMessage(tested ? available : `${available} ${untested}`, update, skip);
    if (choice === update) {
      await this.upgradeOnRequest(current, latest);
    } else if (choice === skip) {
      await this.deps.context.globalState.update(DISMISSED_KEY, latest.text);
    }
  }

  private async upgradeOnRequest(current: CliVersion, latest: CliVersion): Promise<void> {
    const plan = await this.plan();
    if (plan.kind === 'run') {
      await this.upgrade(plan.step, current, latest, true);
    } else {
      void vscode.window.showInformationMessage(manualInstructions(plan.tool));
    }
  }

  private async plan(): Promise<UpgradePlan> {
    const resolution = await this.deps.resolver.resolve();
    return planCswapUpgrade(resolution.ok ? resolution.path : undefined, this.deps.environment);
  }

  /** `requested`: the user asked for it, so say why nothing runs when another update is under way. */
  private async upgrade(step: UpgradeStep, from: CliVersion, to: CliVersion, requested: boolean): Promise<void> {
    const ran = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('Cswap: updating cswap {0} → {1}…', from.text, to.text) }, () =>
      this.exclusive(() => this.runInstaller(step)),
    );
    if (ran.kind === 'running' || ran.kind === 'elsewhere') {
      this.deps.logger.info(`cswap update: skipped, ${ran.kind === 'running' ? 'already running in this window' : 'running in another window'}.`);
      if (requested) {
        void vscode.window.showInformationMessage(ran.kind === 'running' ? t('cswap is already being updated.') : t('cswap is being updated in another window.'));
      }
      return;
    }
    if (ran.kind === 'busy') {
      this.reportFailure({ kind: 'busy' }, step, from, to);
      return;
    }
    if (!ran.value.ok) {
      this.reportFailure(ran.value.failure, step, from, to);
      return;
    }
    const after = await this.afterUpgrade(to);
    if (after.outcome.ok && after.version !== undefined) {
      void vscode.window.showInformationMessage(t('cswap was updated: {0} → {1}.', from.text, after.version.text));
    } else if (!after.outcome.ok) {
      this.reportFailure(after.outcome.failure, step, from, to);
    }
  }

  /**
   * Runs `work` as the only cswap update: not while this or another window runs one, after any
   * switch or account change (waiting up to a minute), and with cswap's own commands held.
   */
  private async exclusive<T>(work: () => Promise<T>, onWait?: () => void): Promise<Exclusive<T>> {
    const { globalState } = this.deps.context;
    if (this.upgrading) {
      return { kind: 'running' };
    }
    if (upgradeRunningElsewhere(globalState.get<unknown>(RUNNING_KEY), Date.now(), RUNNING_STALE_MS)) {
      return { kind: 'elsewhere' };
    }
    this.upgrading = true;
    try {
      await globalState.update(RUNNING_KEY, Date.now());
      if (this.deps.gate.isBusy()) {
        onWait?.();
      }
      const ran = await this.deps.gate.runWhenFree(
        async () => ({
          value: await this.deps.cswapRunner.pauseWhile(async (drained) => {
            if (!drained) {
              this.deps.logger.info('cswap update: a cswap command was still running; updating anyway.');
            }
            return work();
          }, DRAIN_MS),
        }),
        GATE_WAIT_MS,
      );
      return ran === undefined ? { kind: 'busy' } : { kind: 'ran', value: ran.value };
    } finally {
      this.upgrading = false;
      await globalState.update(RUNNING_KEY, undefined);
    }
  }

  private async runInstaller(step: UpgradeStep): Promise<UpgradeProcessOutcome> {
    this.deps.logger.info(`cswap update: ${upgradeCommandByName(step.tool)} started.`);
    const result = await this.runner.run(step.program, step.args, {
      timeoutMs: UPGRADE_TIMEOUT_MS,
      maxOutputBytes: UPGRADE_MAX_OUTPUT_BYTES,
      cwd: this.deps.homeDir,
      env: upgradeEnvironment(process.env, process.platform),
    });
    const ended = result.kind === 'exited' ? `exited with ${exitCodeText(result.exitCode)}` : result.failure;
    this.deps.logger.info(`cswap update: ${step.tool} ${ended} in ${result.durationMs} ms.`);
    return upgradeProcessOutcome(result, this.deps.homeDir);
  }

  /** cswap was replaced: find it again, read its version, refresh the accounts. */
  private async afterUpgrade(to: CliVersion): Promise<{ readonly outcome: UpgradeProcessOutcome; readonly version?: CliVersion }> {
    this.deps.resolver.invalidate();
    const read = await this.deps.cli.version();
    const version = read.ok ? read.value : undefined;
    if (version !== undefined) {
      this.state = { ...this.state, current: version };
    }
    void this.deps.refreshService.refresh({ trigger: 'configuration', requireFresh: true });
    const outcome = verifyUpgrade(version, to);
    this.deps.logger.info(`cswap update: ${outcome.ok ? `cswap is now ${version?.text ?? '?'}` : `failed: ${describeUpgradeFailure(outcome.failure)}`}.`);
    return { outcome, ...(version === undefined ? {} : { version }) };
  }

  private reportFailure(failure: UpgradeFailure, step: UpgradeStep, from: CliVersion, to: CliVersion): void {
    this.deps.logger.warn(`cswap update failed: ${describeUpgradeFailure(failure)}.`);
    const message = failure.kind === 'exited' && process.platform === 'win32' ? `${failureMessage(failure, step.tool)} ${lockHint()}` : failureMessage(failure, step.tool);
    const tryAgain = t('Try again');
    const openTerminal = t('Open in terminal');
    void vscode.window.showWarningMessage(message, tryAgain, openTerminal).then((choice) => {
      if (choice === tryAgain) {
        void this.upgradeOnRequest(from, to);
      } else if (choice === openTerminal) {
        void this.openInTerminal(step, from, to);
      }
    });
  }

  /** The same program and arguments in a terminal that shows their output and stays open. */
  private async openInTerminal(step: UpgradeStep, from: CliVersion, to: CliVersion): Promise<void> {
    const view = new ProgramTerminal(t('Cswap: update cswap'));
    view.terminal.show();
    view.writeLine(t('Cswap Manager runs: {0}', describeInstallStep(step)));
    const ran = await this.exclusive(
      () => view.run(step.program, step.args, { cwd: this.deps.homeDir, env: upgradeEnvironment(process.env, process.platform) }),
      () => view.writeLine(t('Waiting for a switch or account change to finish…')),
    );
    switch (ran.kind) {
      case 'running':
        view.writeLine(t('cswap is already being updated.'));
        return;
      case 'elsewhere':
        view.writeLine(t('cswap is being updated in another window.'));
        return;
      case 'busy':
        view.writeLine(failureMessage({ kind: 'busy' }, step.tool));
        return;
      case 'ran':
        break;
    }
    const end = ran.value;
    this.deps.logger.info(`cswap update (terminal): ${step.tool} ${end.kind === 'exited' ? `exited with ${exitCodeText(end.code)}` : end.kind}.`);
    if (end.kind === 'closed') {
      return;
    }
    if (end.kind === 'not-started') {
      view.writeLine(failureMessage({ kind: 'not-started' }, step.tool));
      return;
    }
    if (end.code !== 0) {
      view.writeLine('');
      view.writeLine(failureMessage({ kind: 'exited', exitCode: end.code }, step.tool));
      if (process.platform === 'win32') {
        view.writeLine(lockHint());
      }
      return;
    }
    const after = await this.afterUpgrade(to);
    view.writeLine('');
    if (after.outcome.ok && after.version !== undefined) {
      const done = t('cswap was updated: {0} → {1}.', from.text, after.version.text);
      view.writeLine(done);
      void vscode.window.showInformationMessage(done);
    } else if (!after.outcome.ok) {
      view.writeLine(failureMessage(after.outcome.failure, step.tool));
    }
  }
}

/** What to run by hand when the installer's program cannot be started from here. */
function manualInstructions(tool: UpgradeTool | undefined): string {
  return tool === undefined
    ? t('Update cswap with the tool you installed it with, for example "uv tool upgrade claude-swap".')
    : t('{0} was not found. Update cswap by running "{1}" in a terminal, then refresh.', tool, upgradeCommandByName(tool));
}
