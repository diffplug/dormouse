import spawn from 'cross-spawn';
import path from 'node:path';

export interface SpawnCaptureSuccess {
  readonly ok: true;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnCaptureFailure {
  readonly ok: false;
  /** Spawn-level failure — the process never ran (e.g. ENOENT). */
  readonly error: { readonly code?: string; readonly message: string };
}

export type SpawnCaptureResult = SpawnCaptureSuccess | SpawnCaptureFailure;

/** The `error.code` of a spawn that `timeoutMs` ended. */
export const SPAWN_TIMEOUT_CODE = 'ETIMEDOUT';

/**
 * How a timed-out child is ended, or null for a plain SIGKILL of the child.
 * Windows ends the whole tree: cross-spawn runs a `.cmd` shim through
 * `cmd.exe`, so the child is the shell and the real CLI is its descendant,
 * which killing the shell would leave running. `taskkill` is named by its
 * absolute path for the same reason every other spawn is (a bare name is
 * searched in the cwd first). Takes `isWindows` so both branches are testable
 * off Windows.
 */
export function treeKillCommand(
  pid: number,
  env: { readonly [key: string]: string | undefined },
  isWindows: boolean,
): { binary: string; args: string[] } | null {
  if (!isWindows) return null;
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  return { binary: path.win32.join(systemRoot, 'System32', 'taskkill.exe'), args: ['/PID', String(pid), '/T', '/F'] };
}

// Grace window for 'close' to win after 'exit' before we resolve anyway. Long
// enough that a normal command's stdio drains (its output is written before the
// process exits), short enough that the daemon-holds-the-pipe case (see below)
// doesn't feel like a hang.
const CLOSE_GRACE_MS = 250;

/**
 * Spawn an external binary and capture its stdout/stderr — the single home for
 * the hard-won Windows recipe `dor` and the agent-browser host both need. See
 * docs/specs/dor-cli.md → "Spawning External Binaries".
 *
 *  - cross-spawn resolves PATHEXT and routes `.cmd`/`.bat` through cmd.exe; Node's
 *    own spawn ENOENTs on a bare name and (>=22) EINVALs on a `.cmd` by full path.
 *  - windowsHide stops a console window flashing and stealing focus per spawn.
 *  - resolve on 'exit' (not 'close') with a grace + an exit-time output snapshot:
 *    `agent-browser open` leaves a daemon that on Windows inherits our stdio
 *    pipes, so 'close' never fires (waiting on it alone hangs forever) and the
 *    daemon's post-exit scribbles would otherwise leak into the captured output.
 *
 * Never throws: a spawn-level failure resolves as `{ ok: false, error }`.
 *
 * `timeoutMs` bounds the whole call: past it the child is killed (its tree on
 * Windows, `treeKillCommand`) and the call resolves `{ ok: false }` with
 * `SPAWN_TIMEOUT_CODE`, without waiting for the kill.
 */
export function spawnAndCapture(
  binary: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<SpawnCaptureResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: options.cwd, env: options.env });
    } catch (error) {
      // Invalid argv (for example a NUL in an eval string) throws before a child
      // exists; preserve the same result contract as an asynchronous ENOENT.
      const cause = error as NodeJS.ErrnoException;
      resolve({ ok: false, error: { code: cause.code, message: cause.message } });
      return;
    }
    let stdout = '';
    let stderr = '';
    // Latch on the first terminal event so the error-vs-exit/close race can't
    // double-resolve; clearTimeout drops the grace timer once we've settled.
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      // Capture is over. In the grace fallback a daemon still owns the write
      // ends: leaving our readers open retains both the caller's event loop and
      // the data listeners that keep accumulating ignored output.
      child.stdout?.destroy();
      child.stderr?.destroy();
      apply();
    };
    // Decode across pipe chunks so a split UTF-8 sequence stays one character.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error: NodeJS.ErrnoException) =>
      settle(() => resolve({ ok: false, error: { code: error.code, message: error.message } })));
    const finish = (code: number | null, out: string, err: string): void =>
      settle(() => resolve({ ok: true, exitCode: code ?? 1, stdout: out, stderr: err }));
    // 'close' is the clean path (process exited and stdio drained). Fall back to
    // 'exit' for the daemon-holds-the-pipe case where 'close' never fires; the
    // grace lets 'close' win first so a normal command's full output flushes, and
    // the exit-time snapshot keeps post-exit daemon noise out of the result.
    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        settle(() => resolve({
          ok: false,
          error: { code: SPAWN_TIMEOUT_CODE, message: `${binary} did not finish within ${options.timeoutMs} ms` },
        }));
        const killer = child.pid === undefined ? null : treeKillCommand(child.pid, process.env, process.platform === 'win32');
        if (!killer) {
          child.kill('SIGKILL');
          return;
        }
        const taskkill = spawn(killer.binary, killer.args, { stdio: 'ignore', windowsHide: true });
        // Best effort: a failed tree kill still leaves the shell to end.
        taskkill.on('error', () => child.kill('SIGKILL'));
      }, Math.max(0, options.timeoutMs));
    }
    child.on('close', (code: number | null) => finish(code, stdout, stderr));
    child.on('exit', (code: number | null) => {
      const out = stdout;
      const err = stderr;
      graceTimer = setTimeout(() => finish(code, out, err), CLOSE_GRACE_MS);
    });
  });
}
