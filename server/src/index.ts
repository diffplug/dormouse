/**
 * Process entrypoint: translate environment variables (docs/specs/server.md,
 * "Configuration") into an {@link AppConfig} and bind a port. Kept separate from
 * `app.ts` so the app itself stays testable without touching env or the network.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);

const setupPassword = process.env.DORMOUSE_SETUP_PASSWORD;
if (!setupPassword) {
  console.error(
    'DORMOUSE_SETUP_PASSWORD is required — it gates account creation and host enrollment.',
  );
  process.exit(1);
}

const origin = process.env.DORMOUSE_ORIGIN ?? `http://localhost:${port}`;
const stateDir = process.env.DORMOUSE_STATE_DIR ?? './data';

// Default to `lib/dist-pocket` resolved from this compiled file's location
// (server/dist/index.js → repo root two levels up), so it works regardless of
// the process's cwd. Override with DORMOUSE_POCKET_DIR.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pocketDir = process.env.DORMOUSE_POCKET_DIR ?? join(repoRoot, 'lib', 'dist-pocket');

const { app, injectWebSocket } = createApp({ setupPassword, origin, stateDir, pocketDir });

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port} (origin ${origin})`);
});

// Bind the relay's WS upgrade handler onto the running server (@hono/node-ws).
injectWebSocket(server);
