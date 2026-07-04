/**
 * The selfhost POC server (docs/specs/server.md), slice 1: accounts & passkeys.
 *
 * Built as a factory — `createApp(config)` — rather than a module-level
 * singleton so tests can spin up an isolated server (its own state dir, its own
 * in-memory challenge/session stores, its own injectable clock) per case, and
 * so `index.ts` stays a thin env-to-config adapter.
 *
 * "WebAuthn without a WebAuthn library" (server.md): registration trusts the
 * browser-provided SPKI public key and only sanity-checks `clientDataJSON`;
 * assertions are verified by `verifyPasskeyAssertion` from `server-lib-common`,
 * the exact same verifier the Host uses, so Server and Host cannot disagree on
 * what a valid assertion is. Challenges are minted by `HostChallengeIssuer`
 * (a generic single-use/TTL store despite the name). Setup and sign-in get
 * SEPARATE issuers so a challenge minted for one flow can never be redeemed in
 * the other.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context, MiddlewareHandler } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import type { NodeWebSocket } from '@hono/node-ws';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  API_ROUTES,
  HELLO_ROUTE,
  HostChallengeIssuer,
  SELFHOST_ACCOUNT_ID,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  fromBase64Url,
  getWebCrypto,
  helloResponse,
  toBase64Url,
  utf8Decode,
  verifyPasskeyAssertion,
} from 'server-lib-common';
import type {
  HostEnrollRequest,
  HostEnrollResponse,
  HostsResponse,
  PasskeyAssertion,
  SetupBeginRequest,
  SetupBeginResponse,
  SetupFinishRequest,
  SetupFinishResponse,
  SigninBeginResponse,
  SigninFinishRequest,
  SigninFinishResponse,
} from 'server-lib-common';

import { Handshake } from './handshake.js';
import { RelayHub } from './relay.js';
import type { ClientConn, HostConn } from './relay.js';
import { AccountStore, DuplicateCredentialError, HostStore } from './state.js';
import type { StoredHost } from './state.js';

/** Runtime configuration; see `index.ts` for how env maps onto this. */
export interface AppConfig {
  /** Gates account creation and passkey enrollment. */
  readonly setupPassword: string;
  /** External origin, e.g. `https://dormouse.tailnet.ts.net`; source of `rpId`. */
  readonly origin: string;
  /**
   * Demand the authenticator's user-verification flag (biometric/PIN) on the
   * relay's connection-handshake assertions, mirroring the Host's
   * `ConnectionPolicy.requireUserVerification` so Server and Host cannot disagree
   * on what a valid assertion is. Omitted/false keeps the current presence-only
   * behavior; a deployment opts in explicitly (env → config in `index.ts`).
   */
  readonly requireUserVerification?: boolean;
  /** Directory holding `account.json`. */
  readonly stateDir: string;
  /**
   * Directory of the built Pocket web app (`lib`'s `dist-pocket`). When it
   * exists it is served statically at `/*`; otherwise `GET /` is a stub telling
   * you how to build it. API and `/ws` routes always take precedence.
   */
  readonly pocketDir?: string;
  /** Injectable clock (epoch ms) for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** A live sign-in session held in memory (server.md: everything transient is in memory). */
export interface Session {
  readonly accountId: string;
  readonly expiresAt: number;
}

type AppEnv = { Variables: { session: Session; host: StoredHost } };

/** Sessions live 12 hours (server.md: "hours-scale TTL"). */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** A small fixed delay on password failure — the extent of POC brute-force hardening. */
const PASSWORD_FAILURE_DELAY_MS = 250;

/**
 * In-memory session store. Exposed on the created app so slice 2's WS path can
 * validate a raw `token` query param, and the `requireSession` middleware can
 * validate a `Bearer` header, against one shared source of truth.
 */
export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** Mint a fresh session token (32 random bytes, base64url) for an account. */
  mint(accountId: string): { token: string; session: Session } {
    const token = toBase64Url(randomBytes(32));
    const session: Session = { accountId, expiresAt: this.#now() + SESSION_TTL_MS };
    this.#sessions.set(token, session);
    return { token, session };
  }

  /** Validate a raw token; returns the session or `null` if unknown/expired. */
  validate(token: string): Session | null {
    const session = this.#sessions.get(token);
    if (!session) return null;
    if (this.#now() >= session.expiresAt) {
      this.#sessions.delete(token);
      return null;
    }
    return session;
  }
}

/** What {@link createApp} hands back: the Hono app plus its auth internals. */
export interface CreatedApp {
  readonly app: Hono<AppEnv>;
  readonly sessions: SessionStore;
  /** Middleware for session-gated routes (`/api/hosts`, etc.). */
  readonly requireSession: MiddlewareHandler<AppEnv>;
  /** The relay hub; exposed so `/api/hosts` presence and tests can read it. */
  readonly hub: RelayHub;
  /**
   * Bind the WS relay onto the http server returned by `serve()`. `index.ts`
   * (and tests) MUST call this after `serve()`, per the `@hono/node-ws` pattern
   * — the WebSocket routes are inert until the upgrade handler is injected.
   */
  readonly injectWebSocket: NodeWebSocket['injectWebSocket'];
}

export function createApp(config: AppConfig): CreatedApp {
  const now = config.now ?? (() => Date.now());
  const originUrl = new URL(config.origin);
  const origin = originUrl.origin;
  const rpId = originUrl.hostname;
  const accounts = new AccountStore(config.stateDir, now);
  const hostStore = new HostStore(config.stateDir, now);
  const sessions = new SessionStore(now);
  // Server-side handshake policy layered on the transport-dumb hub (slice 3).
  const handshake = new Handshake(accounts, {
    origin,
    rpId,
    requireUserVerification: config.requireUserVerification,
    now,
  });
  const hub = new RelayHub(handshake);
  // Separate issuers per flow: a setup challenge cannot be redeemed at sign-in.
  const setupChallenges = new HostChallengeIssuer({ now });
  const signinChallenges = new HostChallengeIssuer({ now });

  // Precompute a fixed-length digest of the expected password so the
  // constant-time compare never has to branch on length (timingSafeEqual
  // throws on unequal-length buffers).
  const expectedPasswordHash = sha256(config.setupPassword);
  const passwordOk = (provided: unknown): boolean =>
    typeof provided === 'string' && timingSafeEqual(sha256(provided), expectedPasswordHash);

  // Read a JSON body and enforce the setup password. Returns the parsed body, or
  // a ready 401 `Response` (after the standard failure delay) the caller returns
  // as-is — so the three password-gated routes share one policy.
  async function readPasswordGated<T extends { password: unknown }>(
    c: Context<AppEnv>,
  ): Promise<T | Response> {
    const body = await readJson<T>(c);
    if (!body || !passwordOk(body.password)) {
      await delay(PASSWORD_FAILURE_DELAY_MS);
      return c.json({ error: 'invalid setup password' }, 401);
    }
    return body;
  }

  const app = new Hono<AppEnv>();
  // The WS relay routes need the http server that `serve()` builds later, so the
  // adapter is created here and `injectWebSocket` is handed back to the caller.
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  // The Host (standalone webview) and dev Pocket builds call the API from
  // other origins, so preflights must succeed. Permissive CORS is safe here:
  // every endpoint is gated by the setup password or a bearer token, and no
  // cookies exist for a foreign origin to ride on.
  app.use('/api/*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization'] }));

  // Shared greeting, kept from the skeleton so `lib` and `server` stay agreed.
  app.get(HELLO_ROUTE, (c) => c.json(helloResponse()));

  // --- Setup: password-gated passkey registration -------------------------

  app.post(API_ROUTES.setupBegin, async (c) => {
    const body = await readPasswordGated<SetupBeginRequest>(c);
    if (body instanceof Response) return body;
    const { challenge } = setupChallenges.issue();
    const res: SetupBeginResponse = { challenge, rpId, accountId: SELFHOST_ACCOUNT_ID };
    return c.json(res);
  });

  app.post(API_ROUTES.setupFinish, async (c) => {
    const body = await readPasswordGated<SetupFinishRequest>(c);
    if (body instanceof Response) return body;

    // Decode and sanity-check clientDataJSON — we do NOT parse attestation
    // (attestation: 'none'); the browser already handed us the public key.
    const clientData = decodeClientData(body.clientDataJSON);
    if (!clientData) return c.json({ error: 'malformed clientDataJSON' }, 400);
    if (clientData.type !== 'webauthn.create') {
      return c.json({ error: 'clientData type must be webauthn.create' }, 400);
    }
    if (typeof clientData.challenge !== 'string' || !setupChallenges.consume(clientData.challenge)) {
      return c.json({ error: 'unrecognized or expired challenge' }, 400);
    }
    if (clientData.origin !== origin) {
      return c.json({ error: 'origin mismatch' }, 400);
    }

    // Reject any key we could not verify assertions against later.
    if (!(await importableSpkiP256(body.publicKey))) {
      return c.json({ error: 'unimportable public key' }, 400);
    }

    try {
      await accounts.appendPasskey({
        credentialId: body.credentialId,
        publicKey: body.publicKey,
        label: typeof body.label === 'string' ? body.label : '',
      });
    } catch (err) {
      if (err instanceof DuplicateCredentialError) {
        return c.json({ error: 'credential already registered' }, 409);
      }
      throw err;
    }

    const res: SetupFinishResponse = {
      accountId: SELFHOST_ACCOUNT_ID,
      credentialId: body.credentialId,
    };
    return c.json(res);
  });

  // --- Sign-in: passkey assertion → session token -------------------------

  app.post(API_ROUTES.signinBegin, (c) => {
    const { challenge } = signinChallenges.issue();
    const res: SigninBeginResponse = { challenge, rpId };
    return c.json(res);
  });

  app.post(API_ROUTES.signinFinish, async (c) => {
    const body = await readJson<SigninFinishRequest>(c);
    const assertion = body?.assertion;
    if (!assertion || typeof assertion.credentialId !== 'string') {
      return c.json({ error: 'malformed assertion' }, 400);
    }

    const stored = await accounts.findPasskey(assertion.credentialId);
    if (!stored) return c.json({ error: 'unknown credential' }, 404);

    // Pull the challenge out of the assertion's own clientDataJSON so we can
    // consume it (single-use) before verifying. Consuming first guarantees a
    // captured assertion can never be replayed even if verification succeeds.
    const clientData = decodeClientData(assertion.clientDataJSON);
    if (!clientData || typeof clientData.challenge !== 'string') {
      return c.json({ error: 'malformed clientDataJSON' }, 400);
    }
    const challenge = clientData.challenge;
    if (!signinChallenges.consume(challenge)) {
      return c.json({ error: 'unrecognized or expired challenge' }, 400);
    }

    const result = await verifyPasskeyAssertion(assertion as PasskeyAssertion, stored.publicKey, {
      challenge,
      origin,
      rpId,
      // Same server-wide UV policy the connect handshake enforces, so sign-in
      // is not a softer path than a remote connect when UV is required.
      requireUserVerification: config.requireUserVerification,
    });
    if (!result.ok) {
      return c.json({ error: `assertion rejected: ${result.reason}` }, 401);
    }

    const { token, session } = sessions.mint(SELFHOST_ACCOUNT_ID);
    const res: SigninFinishResponse = {
      sessionToken: token,
      accountId: session.accountId,
      expiresAt: session.expiresAt,
    };
    return c.json(res);
  });

  // --- Host enrollment: password-gated, appends to hosts.json --------------

  app.post(API_ROUTES.hostEnroll, async (c) => {
    const body = await readPasswordGated<HostEnrollRequest>(c);
    if (body instanceof Response) return body;
    const label = typeof body.label === 'string' ? body.label : '';
    const host = await hostStore.enroll(label);
    // The Host enforces `origin`/`rpId` as its ConnectionPolicy (server.md).
    const res: HostEnrollResponse = {
      hostId: host.hostId,
      hostToken: host.hostToken,
      origin,
      rpId,
    };
    return c.json(res);
  });

  // Gate a route on a valid `Authorization: Bearer` session token.
  const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    const session = match ? sessions.validate(match[1]!) : null;
    if (!session) return c.json({ error: 'unauthorized' }, 401);
    c.set('session', session);
    await next();
  };

  // --- Host presence: enrolled hosts + whether each is connected -----------

  app.get(API_ROUTES.hosts, requireSession, async (c) => {
    const hosts = await hostStore.list();
    const res: HostsResponse = {
      hosts: hosts.map((h) => ({
        hostId: h.hostId,
        label: h.label,
        online: hub.isHostOnline(h.hostId),
      })),
    };
    return c.json(res);
  });

  // --- The relay: one host socket per hostId, many client sockets ----------
  // Auth rides the `token` query param (browsers cannot set WS headers). A bad
  // token short-circuits with 401 here, so `injectWebSocket` never upgrades it.

  app.get(
    WS_ROUTES.host,
    async (c, next) => {
      const token = c.req.query(WS_TOKEN_PARAM);
      const host = token ? await hostStore.findByToken(token) : undefined;
      if (!host) return c.json({ error: 'unknown host token' }, 401);
      c.set('host', host);
      return next();
    },
    upgradeWebSocket((c) => {
      // The auth middleware above ran on this same context and stashed `host`.
      const host = (c as Context<AppEnv>).get('host');
      let conn: HostConn | undefined;
      return {
        onOpen: (_evt, ws) => {
          conn = hub.registerHost(host.hostId, ws);
        },
        onMessage: (evt) => {
          if (conn && typeof evt.data === 'string') hub.onHostFrame(conn, evt.data);
        },
        onClose: () => {
          if (conn) hub.unregisterHost(conn);
        },
      };
    }),
  );

  app.get(
    WS_ROUTES.client,
    (c, next) => {
      const token = c.req.query(WS_TOKEN_PARAM);
      const session = token ? sessions.validate(token) : null;
      if (!session) return c.json({ error: 'unauthorized' }, 401);
      return next();
    },
    upgradeWebSocket(() => {
      let conn: ClientConn | undefined;
      // `onClientFrame` is async (pair/connect2 verification), so serialize
      // frames from this socket through a promise chain — a client's frames
      // must be processed in the order they arrived, not raced by the gate.
      let chain: Promise<void> = Promise.resolve();
      return {
        onOpen: (_evt, ws) => {
          conn = hub.registerClient(ws);
        },
        onMessage: (evt) => {
          if (conn && typeof evt.data === 'string') {
            const c = conn;
            const data = evt.data;
            chain = chain.then(() => hub.onClientFrame(c, data)).catch(() => undefined);
          }
        },
        onClose: () => {
          if (conn) hub.unregisterClient(conn);
        },
      };
    }),
  );

  // --- Static Pocket app: GET /* fallback, registered LAST so every API and
  //     /ws route above wins. Missing build → a stub with the build command.
  registerPocketServing(app, config.pocketDir);

  return { app, sessions, requireSession, hub, injectWebSocket };
}

/** Message shown at `GET /` when the Pocket app has not been built yet. */
const POCKET_MISSING_MESSAGE =
  'Dormouse selfhost server. The Pocket web app is not built yet — run ' +
  '`pnpm --filter dormouse-lib build:pocket` (or set DORMOUSE_POCKET_DIR).';

/**
 * Serve the built Pocket app from `pocketDir` at `/*`, falling back to
 * `index.html` for any non-file GET (the app is a single page). When the
 * directory or its `index.html` is absent, keep the old stub at `GET /`.
 */
function registerPocketServing(app: Hono<AppEnv>, pocketDir?: string): void {
  const indexHtmlPath = pocketDir ? join(pocketDir, 'index.html') : null;
  if (!pocketDir || !indexHtmlPath || !existsSync(indexHtmlPath)) {
    app.get('/', (c) => c.text(POCKET_MISSING_MESSAGE));
    return;
  }
  // `serveStatic` joins its `root` onto the request path relative to cwd, so a
  // path relative to cwd is the portable way to point it at an arbitrary dir.
  const root = relative(process.cwd(), pocketDir) || '.';
  app.get('/*', serveStatic({ root }));
  // Re-read the SPA shell per deep-link fallback: a Pocket rebuild swaps in an
  // index.html referencing new content-hashed assets, and a cached copy would
  // keep pointing at deleted files until the server restarts. The fallback is
  // not a hot path, and a read failure degrades to a 404 instead of a crash.
  app.get('*', async (c) => {
    const html = await readFile(indexHtmlPath, 'utf8').catch(() => null);
    return html ? c.html(html) : c.notFound();
  });
}

// ---------------------------------------------------------------------------
// Helpers

/** SHA-256 of a UTF-8 string, as a fixed 32-byte buffer. */
function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson<T>(c: { req: { json(): Promise<unknown> } }): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

/** Decode base64url clientDataJSON to its parsed object, or `null` if malformed. */
function decodeClientData(
  clientDataJSON: unknown,
): { type?: unknown; challenge?: unknown; origin?: unknown } | null {
  if (typeof clientDataJSON !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(utf8Decode(fromBase64Url(clientDataJSON)));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True if `publicKey` (base64url SPKI) imports as an ECDSA P-256 verify key. */
async function importableSpkiP256(publicKey: unknown): Promise<boolean> {
  if (typeof publicKey !== 'string') return false;
  try {
    await getWebCrypto().subtle.importKey(
      'spki',
      fromBase64Url(publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
    return true;
  } catch {
    return false;
  }
}
