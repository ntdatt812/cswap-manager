import { defineConfig } from '@vscode/test-cli';
import * as os from 'node:os';
import * as path from 'node:path';

// Set VSCODE_EXECUTABLE to an installed VS Code (e.g. ...\Microsoft VS Code\Code.exe) to avoid a download.
const executable = process.env.VSCODE_EXECUTABLE;

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  ...(executable ? { useInstallation: { fromPath: executable } } : { version: 'stable' }),
  launchArgs: ['--disable-extensions', `--user-data-dir=${path.join(os.tmpdir(), 'cswap-manager-vscode-test')}`],
  mocha: { ui: 'tdd', timeout: 60_000 },
});
