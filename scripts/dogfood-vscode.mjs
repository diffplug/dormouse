import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(scriptDir, '..', 'vscode-ext');
const vsix = resolve(extDir, 'dormouse.vsix');

// The VS Code CLI emits internal Node deprecation warnings (e.g. DEP0169);
// silence them so dogfood output stays focused on what matters.
const codeEnv = { ...process.env, NODE_NO_WARNINGS: '1' };

// `code` and `pnpm` are `.cmd` shims on Windows, so run through a shell to
// resolve them on PATH. Args are static and shell-safe.
function run(command, { ignoreFailure = false, stdio = 'inherit', env = process.env } = {}) {
  const result = spawnSync(command, { cwd: extDir, stdio, shell: true, env });
  if (!ignoreFailure && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

// Remove the legacy extension if present; ignore failure when it isn't installed.
run('code --uninstall-extension diffplug.mouseterm', { ignoreFailure: true, stdio: 'ignore', env: codeEnv });

run('pnpm package');
run('code --install-extension dormouse.vsix --force', { env: codeEnv });

rmSync(vsix, { force: true });

console.log('Reload VSCode window (Cmd+Shift+P then Reload Window) to pick up the new extension.');
