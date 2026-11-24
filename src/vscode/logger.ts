import * as vscode from 'vscode';
import type { CommandMeta } from '../core/cli/cswapCli';
import type { CliError } from '../core/cli/cliErrors';
import { redactText } from '../core/security/redact';

/** Log output that only ever receives redacted metadata — never raw CLI output. */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor(private readonly homeDir: string) {
    this.channel = vscode.window.createOutputChannel('Cswap Manager', { log: true });
  }

  info(message: string): void {
    this.channel.info(redactText(message, { homeDir: this.homeDir }));
  }

  warn(message: string): void {
    this.channel.warn(redactText(message, { homeDir: this.homeDir }));
  }

  commandFinished(meta: CommandMeta, error?: CliError): void {
    const timing = meta.durationMs === undefined ? '' : ` in ${meta.durationMs} ms`;
    const exit = meta.exitCode === undefined ? '' : ` (exit ${String(meta.exitCode)})`;
    if (error === undefined) {
      this.info(`cswap ${meta.command} succeeded${exit}${timing}`);
    } else {
      this.warn(`cswap ${meta.command} failed: ${error.kind}${exit}${timing}${error.detail ? ` — ${error.detail}` : ''}`);
    }
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
