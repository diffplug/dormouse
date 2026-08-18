/**
 * `DORMOUSE_BIND_HOST` must actually bound the listening socket, not merely be
 * recorded in config: the selfhost install fronts plain HTTP with a local TLS
 * proxy, so the plaintext port must not be reachable from the LAN or a tailnet
 * (docs/specs/server.md, "Configuration"). Spawns the real entrypoint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(here, '..', 'dist', 'index.js');

/** A non-loopback IPv4 of this machine, or undefined on an isolated runner. */
function externalIpv4() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

/** A port that was free a moment ago — good enough for a spawned child. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(extraEnv) {
  const port = await freePort();
  const stateDir = await mkdtemp(join(tmpdir(), 'dormouse-bind-'));
  const child = spawn(process.execPath, [ENTRYPOINT], {
    env: {
      ...process.env,
      DORMOUSE_SETUP_PASSWORD: 'correct horse battery staple',
      DORMOUSE_STATE_DIR: stateDir,
      DORMOUSE_POCKET_DIR: join(stateDir, 'no-pocket-build'),
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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

  return { port, stop: () => child.kill() };
}

/** Resolves true if /api/hello answers at `host` within a short budget. */
async function reachable(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}/api/hello`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

test('DORMOUSE_BIND_HOST=127.0.0.1 serves loopback only', async (t) => {
  const external = externalIpv4();
  const { port, stop } = await startServer({ DORMOUSE_BIND_HOST: '127.0.0.1' });
  t.after(stop);

  assert.equal(await reachable('127.0.0.1', port), true, 'loopback must answer');

  if (!external) {
    t.diagnostic('no non-loopback IPv4 on this machine; skipped the exposure half');
    return;
  }
  assert.equal(
    await reachable(external, port),
    false,
    `plaintext port must not be reachable at ${external}`,
  );
});

test('without DORMOUSE_BIND_HOST the server still listens on every interface', async (t) => {
  const external = externalIpv4();
  if (!external) {
    t.skip('no non-loopback IPv4 on this machine');
    return;
  }
  const { port, stop } = await startServer({});
  t.after(stop);

  assert.equal(await reachable('127.0.0.1', port), true);
  assert.equal(await reachable(external, port), true, 'the container default must be preserved');
});
