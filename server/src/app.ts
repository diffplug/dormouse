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

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  API_ROUTES,
  HELLO_ROUTE,
  HostChallengeIssuer,
  SELFHOST_ACCOUNT_ID,
  fromBase64Url,
  getWebCrypto,
  helloResponse,
  toBase64Url,
  utf8Decode,
  verifyPasskeyAssertion,
} from 'server-lib-common';
import type {
  PasskeyAssertion,
  SetupBeginRequest,
  SetupBeginResponse,
  SetupFinishRequest,
  SetupFinishResponse,
  SigninBeginResponse,
  SigninFinishRequest,
  SigninFinishResponse,
} from 'server-lib-common';

import { AccountStore, DuplicateCredentialError } from './state.js';

/** Runtime configuration; see `index.ts` for how env maps onto this. */
export interface AppConfig {
  /** Gates account creation and passkey enrollment. */
  readonly setupPassword: string;
  /** External origin, e.g. `https://dormouse.tailnet.ts.net`; source of `rpId`. */
  readonly origin: string;
  /** Directory holding `account.json`. */
  readonly stateDir: string;
  /** Injectable clock (epoch ms) for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** A live sign-in session held in memory (server.md: everything transient is in memory). */
export interface Session {
  readonly accountId: string;
  readonly expiresAt: number;
}

type AppEnv = { Variables: { session: Session } };

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
  /** Middleware for session-gated routes (slice 2's `/api/hosts`, etc.). */
  readonly requireSession: MiddlewareHandler<AppEnv>;
}

export function createApp(config: AppConfig): CreatedApp {
  const now = config.now ?? (() => Date.now());
  const rpId = new URL(config.origin).hostname;
  const accounts = new AccountStore(config.stateDir, now);
  const sessions = new SessionStore(now);
  // Separate issuers per flow: a setup challenge cannot be redeemed at sign-in.
  const setupChallenges = new HostChallengeIssuer({ now });
  const signinChallenges = new HostChallengeIssuer({ now });

  // Precompute a fixed-length digest of the expected password so the
  // constant-time compare never has to branch on length (timingSafeEqual
  // throws on unequal-length buffers).
  const expectedPasswordHash = sha256(config.setupPassword);
  const passwordOk = (provided: unknown): boolean =>
    typeof provided === 'string' && timingSafeEqual(sha256(provided), expectedPasswordHash);

  const app = new Hono<AppEnv>();

  // GET / — stub landing page; slice 5 replaces this with the Pocket web app.
  app.get('/', (c) => c.text('Dormouse selfhost server'));

  // Shared greeting, kept from the skeleton so `lib` and `server` stay agreed.
  app.get(HELLO_ROUTE, (c) => c.json(helloResponse()));

  // --- Setup: password-gated passkey registration -------------------------

  app.post(API_ROUTES.setupBegin, async (c) => {
    const body = await readJson<SetupBeginRequest>(c);
    if (!body || !passwordOk(body.password)) {
      await delay(PASSWORD_FAILURE_DELAY_MS);
      return c.json({ error: 'invalid setup password' }, 401);
    }
    const { challenge } = setupChallenges.issue();
    const res: SetupBeginResponse = { challenge, rpId, accountId: SELFHOST_ACCOUNT_ID };
    return c.json(res);
  });

  app.post(API_ROUTES.setupFinish, async (c) => {
    const body = await readJson<SetupFinishRequest>(c);
    if (!body || !passwordOk(body.password)) {
      await delay(PASSWORD_FAILURE_DELAY_MS);
      return c.json({ error: 'invalid setup password' }, 401);
    }

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
    if (clientData.origin !== config.origin) {
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
      origin: config.origin,
      rpId,
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

  // Exported for slice 2: gate a route on a valid `Authorization: Bearer` token.
  const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    const session = match ? sessions.validate(match[1]!) : null;
    if (!session) return c.json({ error: 'unauthorized' }, 401);
    c.set('session', session);
    await next();
  };

  return { app, sessions, requireSession };
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
