// The native dev runner owns Vite so port 0 stays bound until Tauri exits.
// Tauri's beforeDevCommand is disabled only in the per-run config overlay.
import spawn from 'cross-spawn';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { standaloneDir, startDevVite, worktreeId } from './dev-run.mjs';
import { cleanStrayDevSidecars } from './clean-dev-sidecar.mjs';

export async function runDev(args) {
  // Before Cargo can rebuild into target/debug, not just before `dev:standalone`:
  // every route into a native dev run comes through here.
  cleanStrayDevSidecars();
  const [config, id] = await Promise.all([
    readFile(path.join(standaloneDir, 'src-tauri/tauri.conf.json'), 'utf8').then(JSON.parse),
    worktreeId(),
  ]);
  const logFile = process.env.DORMOUSE_LOG_FILE
    || path.join(standaloneDir, 'src-tauri/target/dormouse-dev.log');
  let vite;
  let child;
  let childClosed = Promise.resolve();
  let treeKilled;
  let stopping = false;

  // POSIX gives the CLI and its Cargo/app children one owned process group.
  // Windows needs taskkill /T: killing the pnpm .cmd shim alone leaves them live.
  async function stopTree(signal) {
    if (!child?.pid) return;
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, signal); } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
      return;
    }
    // taskkill /T /F takes the whole tree in one forceful pass, so Windows has
    // no graceful step to escalate from: later calls await the same kill.
    treeKilled ??= new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
    return treeKilled;
  }

  async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    // The CLI can exit before an app child that ignored SIGTERM, so the last
    // step always sweeps the group; the timer is that step on a deadline.
    // allSettled, not all: these are best-effort cleanups on the way out, and
    // one rejecting must not skip the rest or replace the caller's exit code.
    const exit = async () => { await stopTree('SIGKILL').catch(console.error); process.exit(code); };
    const backstop = setTimeout(exit, 3000);
    await Promise.allSettled([stopTree('SIGTERM'), vite?.close(), childClosed]);
    clearTimeout(backstop);
    await exit();
  }

  const fail = err => { console.error(err); return shutdown(1); };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0));
  try {
    // Native mode even when a browser-dev shell exported the harness's host var.
    const server = await startDevVite({ 'import.meta.env.VITE_DORMOUSE_BROWSER_DEV_HOST': 'undefined' });
    vite = server.vite;
    const devUrl = server.origin;
    const identifier = `${config.identifier}.dev.w${id}`;
    const overlay = { identifier, build: { beforeDevCommand: null, devUrl } };
    console.error(`[dev:standalone] app URL: ${devUrl}`);
    console.error(`[dev:standalone] app identifier: ${identifier}`);
    console.error(`[dev:standalone] log file: ${logFile}`);
    // Insert before Cargo/app args, after any caller-supplied config overlays.
    const separator = args.indexOf('--');
    const tauriArgs = args.toSpliced(
      separator < 0 ? args.length : separator, 0, '--config', JSON.stringify(overlay),
    );
    child = spawn('pnpm', ['exec', 'tauri', 'dev', ...tauriArgs], {
      cwd: standaloneDir,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: { ...process.env, DORMOUSE_LOG_FILE: logFile },
    });
    childClosed = new Promise(resolve => child.once('close', resolve));
    child.once('error', fail);
    child.once('exit', (code, signal) => shutdown(code ?? (signal ? 1 : 0)));
  } catch (err) {
    await fail(err);
  }
}
