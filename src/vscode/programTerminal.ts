import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';

/** The terminal shows at most this much of the program's output (it is never stored or logged). */
const MAX_SHOWN_BYTES = 1024 * 1024;

/** `closed`: the terminal was closed before the program started, so it never did. */
export type ProgramEnd =
  | { readonly kind: 'exited'; readonly code: number | null }
  | { readonly kind: 'not-started'; readonly errorCode?: string }
  | { readonly kind: 'closed' };

export interface ProgramRunOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

function errorCodeOf(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/**
 * A terminal that shows one program's output and stays open after it exits, so the user can read
 * it (a terminal whose process is the program closes with it, output and all). The extension starts
 * the program itself, without a shell (absolute path, argument array), so nothing in a terminal's
 * environment can put another program in its place. Closing the terminal only stops showing the
 * output: stopping an installer half-way could leave cswap broken.
 */
export class ProgramTerminal implements vscode.Disposable {
  readonly terminal: vscode.Terminal;
  private readonly output = new vscode.EventEmitter<string>();
  private readonly opened: Promise<boolean>;
  private markOpened: ((open: boolean) => void) | undefined;
  /** Text written before VS Code opened the terminal (it ignores writes until then). */
  private pending: string[] | undefined = [];
  private closed = false;

  constructor(name: string) {
    this.opened = new Promise((resolve) => {
      this.markOpened = resolve;
    });
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.output.event,
      open: () => {
        const pending = this.pending ?? [];
        this.pending = undefined;
        for (const text of pending) {
          this.output.fire(text);
        }
        this.markOpened?.(true);
      },
      close: () => this.close(),
    };
    this.terminal = vscode.window.createTerminal({ name, pty });
  }

  /** Writes a line of the extension's own text. */
  writeLine(text: string): void {
    this.write(`${text}\n`);
  }

  /** Starts `program` once the terminal is open and resolves when it ends. */
  async run(program: string, args: readonly string[], options: ProgramRunOptions): Promise<ProgramEnd> {
    if (!(await this.opened) || this.closed) {
      return { kind: 'closed' };
    }
    return new Promise<ProgramEnd>((resolve) => {
      let settled = false;
      const finish = (end: ProgramEnd): void => {
        if (!settled) {
          settled = true;
          resolve(end);
        }
      };
      let child: ChildProcess;
      try {
        child = spawn(program, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd, env: options.env });
      } catch (error) {
        const errorCode = errorCodeOf(error);
        finish({ kind: 'not-started', ...(errorCode === undefined ? {} : { errorCode }) });
        return;
      }
      let shown = 0;
      const show = (chunk: string): void => {
        if (shown >= MAX_SHOWN_BYTES) {
          return;
        }
        shown += Buffer.byteLength(chunk);
        this.write(shown >= MAX_SHOWN_BYTES ? `${chunk}\n…\n` : chunk);
      };
      child.stdout?.setEncoding('utf8').on('data', show);
      child.stderr?.setEncoding('utf8').on('data', show);
      child.on('error', (error) => {
        const errorCode = errorCodeOf(error);
        finish({ kind: 'not-started', ...(errorCode === undefined ? {} : { errorCode }) });
      });
      child.on('close', (code) => finish({ kind: 'exited', code }));
    });
  }

  dispose(): void {
    this.terminal.dispose();
    this.close();
  }

  private write(text: string): void {
    if (this.closed) {
      return;
    }
    const shown = text.replace(/\r?\n/g, '\r\n');
    if (this.pending === undefined) {
      this.output.fire(shown);
    } else {
      this.pending.push(shown);
    }
  }

  private close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.markOpened?.(false);
    this.output.dispose();
  }
}
