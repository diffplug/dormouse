/**
 * Relay routing at the socket level (docs/specs/relay.md, "Routing"): real
 * in-process WebSockets through the hub, with no ceremony behind them.
 *
 * The cases are the ones every Relay passes, shared with Hosted's Durable
 * Object suite in `remote-lib-common/test/harness/relay-parity.mjs`; this file
 * is the self-host driver for them. The envelope driven by real Noise
 * ceremonies is `e2e-relay.test.mjs`.
 */

import { test } from 'node:test';

import { WS_ROUTES, WS_TOKEN_PARAM } from 'remote-lib-common';

import { enrollBurrow, freshApp, ownerSession, startRelay, wsConnect } from './helpers.mjs';
import { socketCases } from '../../remote-lib-common/test/harness/relay-parity.mjs';

/** A real server and the parity driver over it; every test tears its Relay down in `finally`. */
async function relay() {
  const created = await freshApp();
  const server = await startRelay(created);
  const { sessionToken } = await ownerSession(created.app);
  const burrowSocket = async (burrowToken) => {
    const socket = wsConnect(`${server.wsUrl}${WS_ROUTES.burrow}?${WS_TOKEN_PARAM}=${burrowToken}`);
    await socket.ready;
    return socket;
  };
  const openClient = () =>
    wsConnect(`${server.wsUrl}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${sessionToken}`);
  const driver = {
    async connectBurrow() {
      const { body } = await enrollBurrow(created.app);
      return { ...body, socket: await burrowSocket(body.burrowToken) };
    },
    reconnectBurrow: burrowSocket,
    openClient,
    async connectClient() {
      const socket = openClient();
      await socket.ready;
      return socket;
    },
  };
  return { driver, close: () => server.close() };
}

for (const { name, run } of socketCases) {
  test(name, async () => {
    const { driver, close } = await relay();
    try {
      await run(driver);
    } finally {
      await close();
    }
  });
}
