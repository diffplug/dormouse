/**
 * Spawning the real entrypoint, shared by the tests that need a live server.
 *
 * Two suites had grown near-identical copies of this, and the copies had
 * already diverged in the one place it matters: only one wrapped the
 * wait-for-listening in a `catch` that kills the child. Nobody else holds a
 * handle to it until this resolves, so without that, a timeout orphans a
 * process holding the port for the rest of `node --test`. Sharing it makes that
 * class of divergence impossible rather than fixed twice.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PASSWORD } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The built entrypoint. These suites spawn it rather than importing the app. */
export const ENTRYPOINT = join(here, '..', 'dist', 'index.js');

/** A port that was free a moment ago — good enough for a spawned child. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Spawn the entrypoint and resolve once it reports listening.
 *
 * `extraEnv` is merged last, so a caller can override any default — including
 * `PORT`, though the returned `port` is then no longer the truth.
 */
export async function startServer(extraEnv = {}) {
  const port = await freePort();
  const stateDir = await mkdtemp(join(tmpdir(), 'dormouse-test-'));
  const child = spawn(process.execPath, [ENTRYPOINT], {
    env: {
      ...process.env,
      DORMOUSE_SETUP_PASSWORD: PASSWORD,
      // Before `extraEnv`, so a case can opt out with `''` (which `readConfig`
      // reads as unset) and every other case is loopback: `PASSWORD` is checked
      // in, and unset would stand that on the LAN and the tailnet for the
      // length of the test (`docs/specs/server.md` -> Configuration).
      DORMOUSE_BIND_HOST: '127.0.0.1',
      DORMOUSE_STATE_DIR: stateDir,
      DORMOUSE_POCKET_DIR: join(stateDir, 'no-pocket-build'),
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not report listening')), 15_000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('server listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited early with code ${code}`));
      });
    });
  } catch (error) {
    // Nobody else has a handle on this child yet — the caller registers its
    // cleanup only once this resolves — so a rejection here would leave a
    // server holding `port` for the rest of the run.
    child.kill();
    throw error;
  }

  return { child, port, stateDir, stop: () => child.kill() };
}

/** Stop a spawned server and wait for it to actually go. */
export async function stopServer(child) {
  // A child killed by a signal keeps `exitCode === null` and sets `signalCode`.
  // Checking only the former falls through to a no-op `kill` and then awaits an
  // `'exit'` that already fired — the test hangs instead of failing.
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
}
