#!/usr/bin/env node
/**
 * The dev runner. Dev alone owns an OS-assigned listener: it binds first, then
 * derives the origin from the port it actually got, so WebAuthn, enrollment and
 * Pocket all agree without anyone pinning a port. `readConfig`'s deployment
 * defaults are untouched — production still rejects `PORT=0` and binds the port
 * it was configured with.
 *
 * **No `--watch`**, which an earlier version had: it watched `dist/`, nothing in
 * the repo runs `tsc -w`, so it fired only for someone already running one by
 * hand. Add it back here rather than in `package.json` if that loop is ever
 * wanted — Node's watcher follows the imports below.
 *
 * **Unset `DORMOUSE_BIND_HOST` means every interface** (`relay/src/config.ts`) —
 * right for a container, where the namespace is the boundary, and wrong for a
 * laptop, where it publishes the plaintext port to the LAN and the tailnet
 * (`docs/specs/security-remote.md` -> "Network posture (self-hosted)"). `start`
 * keeps the shipped default; only this dev path opts into loopback, and an
 * explicit value still wins.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';

import { loadConfig } from '../dist/config.js';
import { startRelay } from '../dist/start.js';
import { DEV_STATE_DIR } from './dev-paths.mjs';

const env = {
  ...process.env,
  DORMOUSE_BIND_HOST: process.env.DORMOUSE_BIND_HOST?.trim() || '127.0.0.1',
  DORMOUSE_STATE_DIR: process.env.DORMOUSE_STATE_DIR ?? DEV_STATE_DIR,
};
// Only dev reads unset, blank or `0` as "any free port"; anything else goes
// through the production parser first, so a bad one fails before the bind.
const rawPort = env.PORT?.trim();
const automatic = !rawPort || rawPort === '0';

console.log(`[dev:relay] state directory: ${env.DORMOUSE_STATE_DIR}`);
const server = createServer();
try {
  server.listen(automatic ? 0 : loadConfig(env).port, env.DORMOUSE_BIND_HOST);
  await once(server, 'listening');
  // Re-read with the bound port so every port-derived field — origin, and the
  // VAPID subject derived from it — is consistent. An explicit `DORMOUSE_ORIGIN`
  // still wins. The listener stays bound throughout app initialization.
  await startRelay(loadConfig({ ...env, PORT: String(server.address().port) }), server);
} catch (err) {
  console.error(err);
  server.closeAllConnections();
  server.close();
  process.exitCode = 1;
}
