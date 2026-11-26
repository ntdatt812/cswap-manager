import * as os from 'node:os';
import * as vscode from 'vscode';
import {
  CSWAP_PYPI_URL,
  UV_INSTALL_URL,
  describeInstallStep,
  installCommandByName,
  installStep,
  locateInstallTools,
  locateTool,
  planCswapInstall,
  type InstallStep,
  type InstallTool,
} from '../core/cli/cswapInstall';
import type { CachedExecutableResolver, ResolverEnvironment } from '../core/cli/executableResolver';
import type { RefreshService } from '../core/service/refreshService';
import { confirm } from './confirm';
import type { Logger } from './logger';
import { t } from './presentation';
import { createGuardedTerminal } from './terminals';

/** How often the extension looks for cswap while an install runs. */
const CHECK_INTERVAL_MS = 5_000;
/** How long it keeps looking after a step starts. */
const CHECK_LIMIT_MS = 10 * 60_000;

export interface CswapInstallerDependencies {
  readonly resolver: CachedExecutableResolver;
  readonly environment: ResolverEnvironment;
  readonly refreshService: RefreshService;
  readonly logger: Logger;
}

/** `failed`: the step's program exited, cswap was not found and there is no next step to run. */
type RunEnd =
  | { readonly kind: 'installed' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed'; readonly step: InstallStep; readonly code: number | undefined };

/**
 * Installs cswap when it is missing, never silently: the user confirms the exact programs (full
 * paths) and arguments, and each step's terminal runs that program itself, without a shell, so
 * nothing in the terminal's environment can put another `uv` or `winget` in its place. Until cswap
 * shows up the extension checks every few seconds (no shell: the same file checks as the executable
 * resolver); when a step's program exits it locates the next one (uv after winget or Homebrew) and
 * starts it, and it refreshes once cswap is found. The first time a refresh cannot find cswap, the
 * window in front offers the install once per session.
 */
export class CswapInstaller implements vscode.Disposable {
  private run: InstallRun | undefined;
  private offered = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: CswapInstallerDependencies) {
    this.disposables.push(
      deps.refreshService.onDidChange(() => this.offerIfMissing()),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.offerIfMissing();
        }
      }),
    );
    this.offerIfMissing();
  }

  async install(): Promise<void> {
    if (this.run !== undefined) {
      this.run.show();
      return;
    }
    const { resolver, environment } = this.deps;
    resolver.invalidate();
    if ((await resolver.resolve()).ok) {
      void vscode.window.showInformationMessage(t('cswap is already installed.'));
      void this.deps.refreshService.refresh({ trigger: 'configuration', requireFresh: true });
      return;
    }
    const tools = await locateInstallTools(environment);
    const plan = planCswapInstall(environment.platform, (tool) => tools.get(tool));
    if (plan.kind === 'manual') {
      await showManualInstructions();
      return;
    }
    if (!(await confirmInstall(plan.first, plan.next)) || this.run !== undefined) {
      return;
    }
    this.run = new InstallRun(plan.first, plan.next, this.deps, (end) => this.onRunEnded(end));
  }

  dispose(): void {
    this.run?.dispose();
    this.run = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private offerIfMissing(): void {
    if (this.offered || this.run !== undefined || !vscode.window.state.focused) {
      return;
    }
    if (this.deps.refreshService.getState().lastError?.kind !== 'executable-not-found') {
      return;
    }
    this.offered = true;
    const install = t('Install cswap…');
    const choosePath = t('Choose its path…');
    void vscode.window
      .showInformationMessage(t('cswap (claude-swap) is not installed. Cswap Manager needs it to manage Claude Code accounts.'), install, choosePath)
      .then((choice) => {
        if (choice === install) {
          void vscode.commands.executeCommand('cswapManager.installCswap');
        } else if (choice === choosePath) {
          void vscode.commands.executeCommand('cswapManager.quickSettings', 'cliPath');
        }
      });
  }

  private onRunEnded(end: RunEnd): void {
    this.run?.dispose();
    this.run = undefined;
    this.deps.logger.info(`Install cswap: ${end.kind}${end.kind === 'failed' ? ` (${end.step.tool} exited with ${end.code ?? 'no code'})` : ''}.`);
    if (end.kind === 'installed') {
      void this.deps.refreshService.refresh({ trigger: 'configuration', requireFresh: true });
      const addAccount = t('Add Account…');
      void vscode.window.showInformationMessage(t('cswap is installed. Next: log in to an account with /login in Claude Code and add it.'), addAccount).then((choice) => {
        if (choice === addAccount) {
          void vscode.commands.executeCommand('cswapManager.addAccount');
        }
      });
    } else if (end.kind === 'timeout') {
      const refresh = t('Refresh');
      void vscode.window.showInformationMessage(t('cswap has not appeared yet. When the installation in the terminal finishes, refresh the Accounts view.'), refresh).then((choice) => {
        if (choice === refresh) {
          void vscode.commands.executeCommand('cswapManager.refresh');
        }
      });
    } else if (end.kind === 'failed') {
      // The terminal closes with its program, so its output is gone: say how to see it.
      const choosePath = t('Choose its path…');
      const code = end.code === undefined ? '?' : String(end.code);
      void vscode.window
        .showWarningMessage(t('The installation ended (exit code {0}) and cswap was not found. To see what went wrong, run "{1}" in a terminal.', code, installCommandByName(end.step.tool)), choosePath)
        .then((choice) => {
          if (choice === choosePath) {
            void vscode.commands.executeCommand('cswapManager.quickSettings', 'cliPath');
          }
        });
    }
  }
}

/** Modal: the exact programs (full paths) and arguments, what they accept and what they install. */
async function confirmInstall(first: InstallStep, next: InstallTool | undefined): Promise<boolean> {
  const installer = first.tool === 'brew' ? 'Homebrew' : first.tool;
  const programs =
    next === undefined
      ? [t('Cswap Manager starts this program directly (no shell) in a terminal you can watch:'), describeInstallStep(first)]
      : [
          t('Cswap Manager starts these programs directly (no shell), one after the other, in terminals you can watch:'),
          `1. ${describeInstallStep(first)}`,
          `2. ${t('{0}, with the uv that {1} installs (located when step 1 ends; its full path is shown in the terminal)', installCommandByName(next), installer)}`,
        ];
  const detail = [
    programs.join('\n'),
    ...(first.tool === 'winget' ? [t('With these arguments winget accepts the uv package\'s license agreement and the winget source\'s agreements on your behalf.')] : []),
    t('It installs the Python package claude-swap (the cswap command) for this user only.'),
    ...(next === undefined
      ? []
      : [t('uv (the Python tool installer from Astral) is installed first with {0}. When it is ready, claude-swap is installed with uv in a second terminal.', installer)]),
    t('Cswap Manager looks for cswap for up to 10 minutes and refreshes when it is ready.'),
  ];
  const install = t('Install');
  return (await confirm({ question: t('Install claude-swap (the cswap command)?'), detail }, install)) === install;
}

async function showManualInstructions(): Promise<void> {
  const guide = t('How to install uv');
  const pypi = t('claude-swap on PyPI');
  const choice = await vscode.window.showWarningMessage(
    t('No installer for cswap was found (uv or pipx). Install uv, run "uv tool install claude-swap" in a terminal, then refresh.'),
    guide,
    pypi,
  );
  if (choice === guide) {
    await vscode.env.openExternal(vscode.Uri.parse(UV_INSTALL_URL));
  } else if (choice === pypi) {
    await vscode.env.openExternal(vscode.Uri.parse(CSWAP_PYPI_URL));
  }
}

/** The terminal was closed (by the user, an extension or the window) before its program exited: nothing follows. */
function closedBeforeExit(exit: vscode.TerminalExitStatus): boolean {
  return exit.reason === vscode.TerminalExitReason.User || exit.reason === vscode.TerminalExitReason.Extension || exit.reason === vscode.TerminalExitReason.Shutdown;
}

/** One install: the current step's terminal (its process is the step's program) and the checks for cswap. */
class InstallRun implements vscode.Disposable {
  private step: InstallStep;
  private terminal: vscode.Terminal | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly closeListener: vscode.Disposable;
  private deadline = 0;
  private checking = false;
  private recheck = false;
  private ended = false;

  constructor(
    first: InstallStep,
    /** The program the first step installs; located once that step has ended. */
    private next: InstallTool | undefined,
    private readonly deps: CswapInstallerDependencies,
    private readonly onEnd: (end: RunEnd) => void,
  ) {
    this.step = first;
    this.closeListener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === this.terminal) {
        void this.check();
      }
    });
    this.startStep(first);
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  show(): void {
    this.terminal?.show();
  }

  dispose(): void {
    this.ended = true;
    clearInterval(this.timer);
    this.closeListener.dispose();
  }

  private startStep(step: InstallStep): void {
    this.step = step;
    const shown = describeInstallStep(step);
    // The terminal's process is the located program itself (absolute path, fixed arguments), so no
    // shell looks anything up; it starts in the home folder, and the guarded terminal keeps the
    // current folder out of the programs' own lookups on Windows.
    this.terminal = createGuardedTerminal({
      name: step.tool === 'uv' || step.tool === 'pipx' ? t('Cswap: install cswap') : t('Cswap: install uv'),
      cwd: os.homedir(),
      shellPath: step.program,
      shellArgs: [...step.args],
      message: t('Cswap Manager runs: {0}', shown),
    });
    this.terminal.show();
    this.deadline = Date.now() + CHECK_LIMIT_MS;
    this.deps.logger.info(`Install cswap: ${shown} started in a terminal.`);
  }

  private async check(): Promise<void> {
    if (this.ended) {
      return;
    }
    if (this.checking) {
      this.recheck = true;
      return;
    }
    this.checking = true;
    try {
      await this.checkOnce();
    } finally {
      this.checking = false;
    }
    if (this.recheck && !this.ended) {
      this.recheck = false;
      await this.check();
    }
  }

  private async checkOnce(): Promise<void> {
    const { resolver, environment } = this.deps;
    resolver.invalidate();
    if ((await resolver.resolve()).ok) {
      this.end({ kind: 'installed' });
      return;
    }
    if (this.ended) {
      return;
    }
    // Set once the step's program has exited (the terminal then closes) or its terminal was closed.
    const exit = this.terminal?.exitStatus;
    if (exit === undefined) {
      if (Date.now() >= this.deadline) {
        this.end({ kind: 'timeout' });
      }
      return;
    }
    if (closedBeforeExit(exit)) {
      this.end({ kind: 'closed' });
      return;
    }
    const next = this.next;
    this.next = undefined;
    if (next !== undefined) {
      // The installer has exited, so the program it installed is fully written.
      const program = await locateTool(next, environment);
      if (this.ended) {
        return;
      }
      if (program !== undefined) {
        this.startStep(installStep(next, program));
        return;
      }
    }
    this.end({ kind: 'failed', step: this.step, code: exit.code });
  }

  private end(end: RunEnd): void {
    if (!this.ended) {
      this.dispose();
      this.onEnd(end);
    }
  }
}
