import * as vscode from 'vscode';

/**
 * Every terminal the extension starts goes through here. On Windows a program name is otherwise
 * looked up in the current folder first (cmd.exe, and Python's `shutil.which` inside cswap), so a
 * `claude.cmd` or `uv.bat` placed in a project could run instead of the real tool; this keeps the
 * current folder out of that search.
 */
export function createGuardedTerminal(options: vscode.TerminalOptions): vscode.Terminal {
  return vscode.window.createTerminal({
    ...options,
    ...(process.platform === 'win32' ? { env: { ...options.env, NoDefaultCurrentDirectoryInExePath: '1' } } : {}),
  });
}
