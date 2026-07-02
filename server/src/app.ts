import { Hono } from 'hono';
import { HELLO_ROUTE, helloResponse } from 'server-lib-common';

/**
 * The Hono application. Built here — separate from the `serve()` entrypoint in
 * `index.ts` — so tests can exercise routes via `app.request()` without binding
 * a port.
 */
export const app = new Hono();

app.get('/', (c) => c.text('Hello from Hono!'));

// The route path and response shape both come from `server-lib-common`, the
// package `lib` (frontend) and `server` (backend) share, so the two sides can
// never drift out of agreement.
app.get(HELLO_ROUTE, (c) => c.json(helloResponse()));
