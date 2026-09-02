/**
 * Process, port and log plumbing for the pairing walkthrough
 * (`scripts/pairing-walkthrough/README.md`).
 *
 * Nothing here is product code and nothing here listens: the harness only
 * *probes* ports with an outbound connect, so `scripts/loopback-lint.mjs` has
 * no listener to guard.
 */

import { createWriteStream } from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
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
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  /** Everything the child has written, newest last, for `waitForLine`. */
  const lines = [];
  let carry = '';
  const consume = (chunk) => {
    log.write(chunk);
    carry += chunk.toString('utf8');
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

/** Run a command to completion, capturing its output. Throws on non-zero exit. */
export function exec(command, args, { cwd, env, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stderr || stdout}`));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** SIGTERM the whole group, then SIGKILL what is left. Never throws. */
export async function killTree(handle, { graceMs = 3000 } = {}) {
  if (!handle || handle.exit) return;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-handle.child.pid, signal);
    } catch {
      try {
        handle.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
    const deadline = Date.now() + (signal === 'SIGTERM' ? graceMs : 1500);
    while (!handle.exit && Date.now() < deadline) await delay(100);
    if (handle.exit) return;
  }
}

/** Every handle `spawnLogged` created, newest first. */
export function spawnedHandles() {
  return [...started].reverse();
}

export { delay };
