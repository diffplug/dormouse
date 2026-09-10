#!/usr/bin/env node
// Dev alone owns an OS-assigned listener. Keep readConfig/start's deployment
// defaults intact: production still rejects PORT=0 and binds its configured port.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../dist/config.js';
import { startRelay } from '../dist/start.js';

const env = {
  ...process.env,
  DORMOUSE_BIND_HOST: process.env.DORMOUSE_BIND_HOST?.trim() || '127.0.0.1',
  DORMOUSE_STATE_DIR: process.env.DORMOUSE_STATE_DIR
    ?? fileURLToPath(new URL('../data', import.meta.url)),
};
const rawPort = env.PORT?.trim();
// Validate explicit ports with the production parser; only dev interprets 0
// (or an absent/blank PORT) as automatic. Validate other settings before binding.
const automatic = !rawPort || rawPort === '0';
const config = readConfig({ ...env, PORT: automatic ? '3000' : rawPort });
const server = createServer();
try {
  server.listen(automatic ? 0 : config.port, config.bindHost);
  await once(server, 'listening');
  const port = server.address().port;
  // Re-parse using the bound port so WebAuthn, enrollment, and Pocket all see
  // the real origin. An explicit external origin remains the caller's choice.
  await startRelay(readConfig({ ...env, PORT: String(port) }), server);
  console.log(`[dev:relay] state directory: ${config.stateDir}`);
} catch (err) {
  console.error(err);
  server.closeAllConnections();
  server.close();
  process.exitCode = 1;
}
