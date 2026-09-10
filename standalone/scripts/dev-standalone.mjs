// The native dev runner owns Vite so port 0 stays bound until Tauri exits.
// Tauri's beforeDevCommand is disabled only in the per-run config overlay.
import { createServer } from 'vite';
import spawn from 'cross-spawn';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const standaloneDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(standaloneDir, '..');

export async function runDev(args) {
  const config = JSON.parse(await readFile(path.join(standaloneDir, 'src-tauri/tauri.conf.json'), 'utf8'));
  const worktreeId = createHash('sha256').update(await realpath(repoRoot)).digest('hex').slice(0, 16);
  const logFile = process.env.DORMOUSE_LOG_FILE || path.join(standaloneDir, 'src-tauri/target/dormouse-dev.log');
  let vite;
  let child;
  let stopping = false;

  // POSIX gives the CLI and its Cargo/app children one owned process group.
  // Windows needs taskkill /T: killing the pnpm .cmd shim alone leaves them live.
  async function stopTree(signal) {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.once('error', resolve);
        killer.once('close', resolve);
      });
    } else {
      try { process.kill(-child.pid, signal); } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
    }
  }

  async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(async () => {
      await stopTree('SIGKILL');
      process.exit(code);
    }, 3000);
    const closed = child && child.exitCode === null && child.signalCode === null
      ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve();
    await Promise.all([stopTree('SIGTERM'), vite?.close(), closed]);
    // The CLI may exit before an app child which ignored SIGTERM. Reap any
    // remaining members of its process group before dropping the backstop.
    await stopTree('SIGKILL');
    clearTimeout(timeout);
    process.exit(code);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  try {
    vite = await createServer({
      root: standaloneDir,
      define: { 'import.meta.env.VITE_DORMOUSE_BROWSER_DEV_HOST': 'undefined' },
      server: {
        host: '127.0.0.1',
        port: Number(process.env.DORMOUSE_BROWSER_DEV_VITE_PORT || 0),
        strictPort: true,
        hmr: { host: 'localhost', port: 0, protocol: 'ws' },
      },
    });
    await vite.listen();
    const devUrl = `http://localhost:${vite.httpServer.address().port}`;
    const identifier = `${config.identifier}.dev.w${worktreeId}`;
    const overlay = { identifier, build: { beforeDevCommand: null, devUrl } };
    console.error(`[dev:standalone] app URL: ${devUrl}`);
    console.error(`[dev:standalone] app identifier: ${identifier}`);
    console.error(`[dev:standalone] log file: ${logFile}`);
    // Insert before Cargo/app args, after any caller-supplied config overlays.
    const separator = args.indexOf('--');
    const split = separator < 0 ? args.length : separator;
    child = spawn('pnpm', [
      'exec', 'tauri', 'dev', ...args.slice(0, split),
      '--config', JSON.stringify(overlay), ...args.slice(split),
    ], {
      cwd: standaloneDir,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: { ...process.env, DORMOUSE_LOG_FILE: logFile },
    });
    child.once('error', err => { console.error(err); shutdown(1); });
    child.once('exit', (code, signal) => shutdown(code ?? (signal ? 1 : 0)));
  } catch (err) {
    console.error(err);
    await shutdown(1);
  }
}
