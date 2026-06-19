import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(scriptDir, '..', 'vscode-ext');
const vsix = resolve(extDir, 'dormouse.vsix');

// `code` and `pnpm` are `.cmd` shims on Windows, so run through a shell to
// resolve them on PATH. Args are static and shell-safe.
function run(command, { ignoreFailure = false, stdio = 'inherit' } = {}) {
  const result = spawnSync(command, { cwd: extDir, stdio, shell: true });
  if (!ignoreFailure && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

// Remove the legacy extension if present; ignore failure when it isn't installed.
run('code --uninstall-extension diffplug.mouseterm', { ignoreFailure: true, stdio: 'ignore' });

run('pnpm package');
run('code --install-extension dormouse.vsix --force');

rmSync(vsix, { force: true });

console.log('Reload VSCode window (Cmd+Shift+P then Reload Window) to pick up the new extension.');
