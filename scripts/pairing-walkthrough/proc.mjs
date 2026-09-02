/**
 * Process, port and log plumbing for the pairing walkthrough
 * (`scripts/pairing-walkthrough/README.md`).
 *
 * Nothing here is product code and nothing here listens: the harness only
 * *probes* ports with an outbound connect, so `scripts/loopback-lint.mjs` has
 * no listener to guard.
 *
 * `docs/specs/dor-cli.md` -> "Spawning External Binaries" requires product code
 * to spawn through `spawnAndCapture`; this file spawns raw on purpose. It is a
 * dependency-free script outside the pnpm workspace (nothing to import from),
 * it needs `cwd`/`env`/stdin/timeouts that helper does not take, and it is
 * POSIX-only by construction — process groups below, `pgrep` in `run.mjs`.
 */

import { createWriteStream } from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';

/** Every child this run started, newest first, so teardown is reverse order. */
const started = [];

/**
 * Spawn a long-running child in its own process group, tee its output into
 * `logPath`, and hand back a handle whose `lines` the caller can poll.
 *
 * **Its own process group, always.** `pnpm dev:pocket-server` and
 * `pnpm dev:standalone:ab` each fan out into a tree (pnpm → node → vite →
 * esbuild), and killing only the pnpm shim orphans everything under it.
 * `detached: true` plus a `process.kill(-pid)` at teardown takes the group.
 */
export function spawnLogged(command, args, { cwd, env, logPath, prefix }) {
  const log = createWriteStream(logPath, { flags: 'a' });
  // A write stream with no `error` listener throws an uncaught exception on a
  // full or vanished run directory — losing the log is survivable, so it is
  // reported and the run carries on.
  log.on('error', (err) => console.error(`[${prefix}] ${logPath}: ${err.message}`));
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  /** Everything the child has written, newest last, for `waitForLine`. */
  const lines = [];
  // A decoder rather than `chunk.toString()`, so a multi-byte character split
  // across two reads survives into `lines`.
  const decoder = new StringDecoder('utf8');
  let carry = '';
  const consume = (chunk) => {
    log.write(chunk);
    carry += decoder.write(chunk);
    const parts = carry.split('\n');
    carry = parts.pop() ?? '';
    for (const line of parts) lines.push(line);
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);

  let exit = null;
  child.on('exit', (code, signal) => {
    exit = { code, signal };
    log.end(`\n[${prefix}] exited code=${code} signal=${signal}\n`);
  });

  const handle = { prefix, child, lines, logPath, get exit() { return exit; } };
  started.push(handle);
  return handle;
}

/** Resolve with the first line matching `re`, or throw after `timeoutMs`. */
export async function waitForLine(handle, re, { timeoutMs = 300_000, what = String(re) } = {}) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  while (Date.now() < deadline) {
    while (cursor < handle.lines.length) {
      const match = re.exec(handle.lines[cursor++]);
      if (match) return match;
    }
    if (handle.exit) {
      throw new Error(`${handle.prefix} exited before ${what} (see ${handle.logPath})`);
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for ${what} from ${handle.prefix} (see ${handle.logPath})`);
}

/**
 * Poll `probe` until it returns something truthy.
 *
 * The value is returned, so a probe can double as the read that follows it —
 * which is what keeps "wait for the QR, then measure it" from being two
 * round trips that can disagree.
 *
 * **A probe's throw is "not yet", which is why one needs a way to say "never".**
 * `err.fatal` is rethrown at once: a browser that exited is not going to open
 * its port on the next poll, and waiting the deadline out reports the timeout
 * instead of the death that caused it.
 */
export async function waitFor(probe, { timeoutMs = 60_000, intervalMs = 400, what }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
      last = null;
    } catch (err) {
      if (err?.fatal) throw err;
      last = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
    }
    await delay(intervalMs);
  }
}

/**
 * Whether nothing is listening on `port`.
 *
 * An outbound connect rather than a trial bind: a bind-and-close would put a
 * loopback listener in this file, which `scripts/loopback-lint.mjs` reads as a
 * product listener needing a guard, and the answer would be no more accurate.
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const settle = (free) => {
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => settle(false));
    socket.once('timeout', () => settle(true));
    socket.once('error', () => settle(true));
  });
}

/** The first free port at or above `start`. */
export async function findFreePort(start) {
  for (let port = start; port < start + 200; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free port in [${start}, ${start + 200})`);
}

/**
 * Run a command to completion, capturing its output. Throws on non-zero exit.
 *
 * `binary: true` keeps stdout as a `Buffer` — what `ffmpeg -f rawvideo` writes
 * is samples, not text. Everything else (the timeout, the `exited N` message)
 * is the same either way, which is the reason there is one of these.
 */
export function exec(command, args, { cwd, env, input, binary = false, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    // Decoded once, at the end, never chunk by chunk: a multi-byte character
    // straddling a 64 KiB boundary would otherwise come back as two replacement
    // characters — and the page text this captures is full of `·`, `—` and `‹`,
    // so the corruption lands in a JSON payload that then fails to parse.
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(out);
      const stdout = binary ? bytes : bytes.toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stderr || stdout}`));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/**
 * SIGTERM, wait, SIGKILL, wait — the ladder every teardown here climbs.
 *
 * `send` reports whether the signal reached anything and `isGone` answers
 * whether the target is dead; both sides of the harness's teardown have their
 * own answers (a process group and its exit event, a daemon pid and `kill 0`)
 * and nothing else differs. Never throws.
 */
export async function signalUntilGone(send, isGone, { graceMs = 3000, killMs = 1500 } = {}) {
  for (const [signal, waitMs] of [['SIGTERM', graceMs], ['SIGKILL', killMs]]) {
    if (isGone()) return true;
    if (!send(signal)) return true;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (isGone()) return true;
      await delay(100);
    }
  }
  return isGone();
}

/** SIGTERM the whole group, then SIGKILL what is left. Never throws. */
export function killTree(handle, { graceMs = 3000 } = {}) {
  if (!handle) return Promise.resolve(true);
  const group = handle.child.pid ? -handle.child.pid : null;
  /**
   * **Gone means the whole group, not the leader.** `pnpm` routinely exits
   * before the vite/esbuild/sidecar tree it started, so a check on
   * `handle.exit` would answer "already dead" and return without signalling
   * anything — orphaning exactly the tree `detached: true` exists to reach.
   * Signal 0 to the group answers whether any member is left.
   */
  const isGone = () => {
    if (group === null) return handle.exit !== null;
    try {
      process.kill(group, 0);
      return false;
    } catch {
      return true;
    }
  };
  return signalUntilGone(
    (signal) => {
      try {
        process.kill(group, signal);
        return true;
      } catch {
        try {
          handle.child.kill(signal);
          return true;
        } catch {
          return false;
        }
      }
    },
    isGone,
    { graceMs },
  );
}

/** Every handle `spawnLogged` created, newest first. */
export function spawnedHandles() {
  return [...started].reverse();
}

export { delay };
