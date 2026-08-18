/**
 * Process entrypoint: read the environment via {@link readConfig} and bind a
 * port. Kept separate from `app.ts` so the app itself stays testable without
 * touching env or the network.
 */

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { ConfigError, readConfig } from './config.js';

function loadConfig() {
  try {
    return readConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

const { port, bindHost, ...appConfig } = loadConfig();

const { app, injectWebSocket } = createApp(appConfig);

// `hostname` is omitted rather than passed as undefined so @hono/node-server
// keeps its listen-on-every-interface default (what a container wants).
const server = serve({ fetch: app.fetch, port, ...(bindHost ? { hostname: bindHost } : {}) }, (info) => {
  console.log(
    `server listening on http://${bindHost ?? 'localhost'}:${info.port} (origin ${appConfig.origin})`,
  );
});

// Bind the relay's WS upgrade handler onto the running server (@hono/node-ws).
injectWebSocket(server);
