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

// Install the packaged VSIX. VS Code installs by renaming the extension folder,
// and on Windows a running VS Code instance keeps the current extension's native
// modules (node-pty) loaded, locking that folder — so the rename fails with EPERM
// and a cryptic retry/stack trace. Capture the output and, on that lock, print a
// plain "close VS Code and retry" instead of the raw error.
function installVsix() {
  const result = spawnSync('code --install-extension dormouse.vsix --force', {
    cwd: extDir,
    shell: true,
    env: codeEnv,
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status === 0) return;

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (/EPERM|operation not permitted|restart VS ?Code/i.test(output)) {
    console.error('\n──────────────────────────────────────────────────────────────');
    console.error("Couldn't install: VS Code is holding the old Dormouse extension");
    console.error('files open (its node-pty native modules lock the extension dir).');
    console.error('→ Quit ALL VS Code windows, then re-run `pnpm dogfood:vscode`.');
    console.error('  The .vsix is already built at vscode-ext/dormouse.vsix.');
    console.error('──────────────────────────────────────────────────────────────');
  }
  process.exit(result.status ?? 1);
}

// Remove the legacy extension if present; ignore failure when it isn't installed.
run('code --uninstall-extension diffplug.mouseterm', { ignoreFailure: true, stdio: 'ignore', env: codeEnv });

run('pnpm package');
installVsix();

rmSync(vsix, { force: true });

console.log('Reload VSCode window (Cmd+Shift+P then Reload Window) to pick up the new extension.');
