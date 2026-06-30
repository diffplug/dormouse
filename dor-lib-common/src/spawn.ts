import spawn from 'cross-spawn';

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
 */
export function spawnAndCapture(binary: string, args: readonly string[]): Promise<SpawnCaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    // Latch on the first terminal event so the error-vs-exit/close race can't
    // double-resolve; clearTimeout drops the grace timer once we've settled.
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      apply();
    };
    child.stdout?.on('data', (chunk: unknown) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk: unknown) => { stderr += String(chunk); });
    child.on('error', (error: NodeJS.ErrnoException) =>
      settle(() => resolve({ ok: false, error: { code: error.code, message: error.message } })));
    const finish = (code: number | null, out: string, err: string): void =>
      settle(() => resolve({ ok: true, exitCode: code ?? 1, stdout: out, stderr: err }));
    // 'close' is the clean path (process exited and stdio drained). Fall back to
    // 'exit' for the daemon-holds-the-pipe case where 'close' never fires; the
    // grace lets 'close' win first so a normal command's full output flushes, and
    // the exit-time snapshot keeps post-exit daemon noise out of the result.
    child.on('close', (code: number | null) => finish(code, stdout, stderr));
    child.on('exit', (code: number | null) => {
      const out = stdout;
      const err = stderr;
      graceTimer = setTimeout(() => finish(code, out, err), CLOSE_GRACE_MS);
    });
  });
}
