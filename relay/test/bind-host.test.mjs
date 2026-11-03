/**
 * `DORMOUSE_BIND_HOST` must actually bound the listening socket, not merely be
 * recorded in config: the selfhost install fronts plain HTTP with a local TLS
 * proxy, so the plaintext port must not be reachable from the LAN or a tailnet
 * (docs/specs/relay.md, "Configuration"). Spawns the real entrypoint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';

import { startRelay, stopRelay } from './spawn-relay.mjs';

/** A non-loopback IPv4 of this machine, or undefined on an isolated runner. */
function externalIpv4() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

/** Resolves true if /api/hello answers at `burrow` within a short budget. */
async function reachable(burrow, port) {
  try {
    const res = await fetch(`http://${burrow}:${port}/api/hello`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

test('DORMOUSE_BIND_HOST=127.0.0.1 serves loopback only', async (t) => {
  const external = externalIpv4();
  const { port, stop } = await startRelay({ DORMOUSE_BIND_HOST: '127.0.0.1' });
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

test('without DORMOUSE_BIND_HOST the Relay still listens on every interface', async (t) => {
  const external = externalIpv4();
  if (!external) {
    t.skip('no non-loopback IPv4 on this machine');
    return;
  }
  // Blank, not absent: the helper pins loopback, and `readConfig` reads an
  // empty value as unset — which is the shipped default this case is about.
  const { port, stop } = await startRelay({ DORMOUSE_BIND_HOST: '' });
  t.after(stop);

  assert.equal(await reachable('127.0.0.1', port), true);
  assert.equal(await reachable(external, port), true, 'the container default must be preserved');
});

/** What the Relay wrote to stderr from its start until it stopped. */
async function startupWarnings(env) {
  const { child } = await startRelay(env);
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const closed = new Promise((resolve) => child.on('close', resolve));
  await stopRelay(child);
  await closed;
  return stderr;
}

test('an https origin warns of a plaintext port on every interface only while the bind host is unset', async () => {
  const origin = 'https://relay.example.test';
  assert.match(
    await startupWarnings({ DORMOUSE_BIND_HOST: '', DORMOUSE_ORIGIN: origin }),
    /DORMOUSE_BIND_HOST is unset/,
  );
  assert.doesNotMatch(
    await startupWarnings({ DORMOUSE_BIND_HOST: '127.0.0.1', DORMOUSE_ORIGIN: origin }),
    /DORMOUSE_BIND_HOST/,
  );
  assert.doesNotMatch(await startupWarnings({ DORMOUSE_BIND_HOST: '' }), /DORMOUSE_BIND_HOST/);
});
