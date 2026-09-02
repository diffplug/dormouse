/**
 * Selfhost server factory (`docs/specs/server.md`). Each app owns isolated
 * challenge/session stores and an injectable clock; `index.ts` only maps env.
 */

import { randomBytes } from 'node:crypto';
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
  DELIVERY_ID_LENGTH,
  HELLO_ROUTE,
  HostChallengeIssuer,
  MAX_PUSH_QUERY_DELIVERY_IDS,
  SELFHOST_ACCOUNT_ID,
  SETUP_TOKEN_INVALID_ERROR,
  UNAUTHORIZED_ERROR,
  WS_ROUTES,
  PUSH_SEND_DEADLINE_MS,
  WS_TOKEN_PARAM,
  fromBase64Url,
  getWebCrypto,
  helloResponse,
  isExactBase64Url,
  isOrigin,
  isPresenceBinding,
  presenceChallenge,
  toBase64Url,
  utf8Decode,
  boundedPushText,
  verifyPasskeyAssertion,
} from 'server-lib-common';
import type {
  HostEnrollRequest,
  HostEnrollResponse,
  HostsResponse,
  PasskeyAssertion,
  PresenceBinding,
  PushConfigResponse,
  PushDevicesResponse,
  PushSendRequest,
  PushSendResponse,
  PushSubscribeRequest,
  PushSubscribeResponse,
  PushSubscriptionPayload,
  PushSubscriptionsQueryRequest,
  PushSubscriptionsQueryResponse,
  ReauthBeginRequest,
  ReauthBeginResponse,
  ReauthFinishRequest,
  ReauthFinishResponse,
  SetupBeginRequest,
  SetupBeginResponse,
  SetupFinishRequest,
  SetupFinishResponse,
  SetupRetireRequest,
  SetupTokenResponse,
  SigninBeginResponse,
  SigninFinishRequest,
  SigninFinishResponse,
} from 'server-lib-common';

import { invalidateEnrollOffer, redeemEnrollToken } from './enroll-token.js';
import { RelayHub } from './relay.js';
import type { ClientConn, HostConn } from './relay.js';
import { secretEquals } from './secrets.js';
import { SetupTokenIssuer } from './setup-token.js';
import type { SetupTokenEntry } from './setup-token.js';
import {
  AccountStore,
  DuplicateCredentialError,
  HostStore,
  PushSubscriptionStore,
} from './state.js';
import type { StoredHost, StoredPushSubscription } from './state.js';
import { sendWithinDeadline } from './push.js';
import type { PushSender } from './push.js';
import { isPublicHttpsPushEndpoint } from './push-endpoint.js';

/** Runtime configuration; see `index.ts` for how env maps onto this. */
export interface AppConfig {
  /**
   * Gates Host enrollment (`POST /api/host/enroll`). It no longer registers a
   * passkey: `/api/setup/*` takes a Host-minted setup token only.
   */
  readonly setupPassword: string;
  /**
   * External origin, e.g. `https://dormouse.tailnet.ts.net`; source of `rpId`.
   * **Must already be bare** — `readConfig` normalizes it, {@link createApp}
   * rejects anything else, and every compare here is a string compare against
   * this value.
   */
  readonly origin: string;
  /**
   * Demand the authenticator's user-verification flag (biometric/PIN) on every
   * assertion this Server verifies, and mirror it to each Host as its
   * `ConnectionPolicy.requireUserVerification` so the two cannot disagree on
   * what a valid assertion is. Omitted/false keeps the presence-only behavior;
   * a deployment opts in explicitly (env → config in `index.ts`).
   */
  readonly requireUserVerification?: boolean;
  /** Directory holding the JSON state files (docs/specs/server.md, "State files"). */
  readonly stateDir: string;
  /**
   * Absolute path of the installer's `EnrollmentOffer`. Absent or `null` — the
   * default everywhere but an installed server — refuses every `enrollToken`.
   */
  readonly enrollTokenFile?: string | null;
  /**
   * Directory of the built Pocket web app (`lib`'s `dist-pocket`). When it
   * exists it is served statically at `/*`; otherwise `GET /` is a stub telling
   * you how to build it. API and `/ws` routes always take precedence.
   */
  readonly pocketDir?: string;
  /** Injectable clock (epoch ms) for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Delay before answering a rejected credential; defaults to
   * {@link CREDENTIAL_FAILURE_DELAY_MS}. Injectable for the same reason as
   * `pushSendDeadlineMs` — a suite that pays the real delay on every rejection
   * spends most of its wall time asleep — and never mapped from env: shortening
   * it is a test affordance, not a deployment knob.
   */
  readonly credentialFailureDelayMs?: number;
  /**
   * Base64url VAPID public key handed to browsers so they can subscribe. Absent
   * disables push: the config route reports `null` and subscribe/send 503,
   * rather than letting a phone register against a key the server cannot sign
   * with.
   */
  readonly vapidPublicKey?: string;
  /**
   * Web Push delivery. Injectable for the same reason as `now` — the send route
   * is testable without a real push service. `index.ts` supplies the `web-push`
   * implementation.
   */
  readonly pushSender?: PushSender;
  /**
   * Wall-clock bound on a single delivery attempt; defaults to
   * `PUSH_SEND_DEADLINE_MS`. Injectable for the same reason as `now` — a test
   * cannot wait out the real one.
   */
  readonly pushSendDeadlineMs?: number;
}

/** A live sign-in session held in memory (server.md: everything transient is in memory). */
export interface Session {
  readonly accountId: string;
  readonly expiresAt: number;
}

type AppEnv = { Variables: { session: Session; host: StoredHost } };

/** Sessions live 12 hours (server.md: "hours-scale TTL"). */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * How long a presence nonce stays redeemable. The same two minutes a Host
 * challenge lasts: both bound one ceremony's WebAuthn prompt, and a longer
 * window would only widen the gap between "the user touched the sensor" and
 * "the Host believed it".
 */
const REAUTH_NONCE_TTL_MS = 2 * 60 * 1000;
/**
 * How many unredeemed presence nonces the process will hold.
 *
 * `POST /api/reauth/begin` needs only a session token, so without a cap one
 * signed-in caller can grow this map for the process's lifetime by asking —
 * exactly the reason `HostChallengeIssuer.issue` sweeps. Far above any real
 * use: a phone holds one nonce at a time, per ceremony.
 */
const MAX_PENDING_REAUTH_NONCES = 64;
/** A small fixed delay on a rejected credential — the extent of POC brute-force hardening. */
const CREDENTIAL_FAILURE_DELAY_MS = 250;
/** The one answer to a wrong setup password, wherever it is supplied. */
const BAD_PASSWORD_ERROR = 'invalid setup password';

/** The credential fields `pickCredential` reads. */
type CredentialBody = { password?: unknown; enrollToken?: unknown };

/** Internal control flow out of HostStore's serialized pre-enrollment gate. */
class EnrollmentCredentialRejected extends Error {}
class EnrollmentOfferNotInvalidated extends Error {}

/**
 * In-memory session store. Exposed on the created app so the `/ws/client` path
 * can validate a raw `token` query param, and the `requireSession` middleware a
 * `Bearer` header, against one shared source of truth.
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

/** One outstanding presence nonce and the ceremony it was minted for. */
interface PendingPresenceNonce {
  readonly binding: PresenceBinding;
  readonly expiresAt: number;
}

/**
 * The server nonces `POST /api/reauth/begin` mints and `finish` consumes
 * (`docs/specs/remote-security-model.md` → Presence proofs).
 *
 * Not a {@link HostChallengeIssuer} — whose single-use and TTL rules this
 * otherwise shares — because the entry has to carry the *binding*, so `finish`
 * recomputes the challenge from what `begin` signed off on rather than from
 * whatever the caller sends back.
 */
class PresenceNonceStore {
  readonly #pending = new Map<string, PendingPresenceNonce>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** Hold `binding` against `serverNonce` for {@link REAUTH_NONCE_TTL_MS}. */
  remember(serverNonce: string, binding: PresenceBinding): void {
    const now = this.#now();
    for (const [nonce, entry] of this.#pending) {
      if (now >= entry.expiresAt) this.#pending.delete(nonce);
    }
    // Oldest first: Map iterates in insertion order and every entry carries the
    // same TTL, so the front of the map is the closest to expiring anyway.
    while (this.#pending.size >= MAX_PENDING_REAUTH_NONCES) {
      const oldest = this.#pending.keys().next();
      if (oldest.done) break;
      this.#pending.delete(oldest.value);
    }
    this.#pending.set(serverNonce, { binding, expiresAt: now + REAUTH_NONCE_TTL_MS });
  }

  /**
   * Spend `serverNonce`, or `null` when it is unknown or expired. Removed
   * either way, so it can never become valid again — single use is what stops
   * one WebAuthn prompt from proving presence for two ceremonies.
   */
  consume(serverNonce: unknown): PendingPresenceNonce | null {
    if (typeof serverNonce !== 'string') return null;
    const entry = this.#pending.get(serverNonce);
    if (entry === undefined) return null;
    this.#pending.delete(serverNonce);
    return this.#now() < entry.expiresAt ? entry : null;
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
  const origin = config.origin;
  // Enforced, not assumed: every compare below is a string compare against this
  // value, so a `https://host/` that slipped past `readConfig` (a direct caller,
  // a test) would fail each of them while reading as correct.
  if (!isOrigin(origin)) {
    throw new Error(`createApp needs a bare origin (scheme, host, port), got '${origin}'.`);
  }
  // The one parse, and only for the host part.
  const rpId = new URL(origin).hostname;
  const accounts = new AccountStore(config.stateDir, now);
  const hostStore = new HostStore(config.stateDir, now);
  const pushStore = new PushSubscriptionStore(config.stateDir, now);
  const sessions = new SessionStore(now);
  const hub = new RelayHub();
  // Separate issuers per flow: a setup challenge cannot be redeemed at sign-in.
  const setupChallenges = new HostChallengeIssuer({ now });
  const signinChallenges = new HostChallengeIssuer({ now });
  // The presence nonces of `/api/reauth/*`. Its own store for the same reason
  // the issuers above are separate — a nonce minted for one flow may never be
  // redeemed in another — and it holds the binding the challenge was derived
  // from, which an issuer cannot.
  const presenceNonces = new PresenceNonceStore(now);
  // Not an issuer: a setup token remembers the Host that minted it, so a
  // revoked Host's outstanding tokens die with it.
  const setupTokens = new SetupTokenIssuer({ now });

  const passwordOk = (provided: unknown): boolean =>
    typeof provided === 'string' && secretEquals(provided, config.setupPassword);

  const credentialFailureDelayMs = config.credentialFailureDelayMs ?? CREDENTIAL_FAILURE_DELAY_MS;

  // Every rejected credential answers 401 the same way, after the same delay.
  async function credentialFailure(c: Context<AppEnv>, error: string): Promise<Response> {
    await delay(credentialFailureDelayMs);
    return c.json({ error }, 401);
  }

  /**
   * The credential ladder behind `/api/host/enroll`: exactly one of `password`
   * or `enrollToken`, counted by presence rather than by type.
   *
   * Both-or-neither is a 400 rather than a try-each fallback because trying
   * them in turn would let a *spent* token fall through to the password and
   * still succeed, leaving which credential authorized the request ambiguous on
   * both sides. A lone credential of the wrong type is that branch's own delayed
   * 401 — never the 400 for shape.
   *
   * Answers `{ token }` with the caller's still-unverified token — the route
   * redeems it under the Host-store mutex — or `{ token: null }` once the
   * password has been checked here, or a ready `Response` to return as-is.
   */
  async function pickCredential(
    body: CredentialBody | null,
    c: Context<AppEnv>,
  ): Promise<{ token: string | null } | Response> {
    const password: unknown = body?.password;
    const token: unknown = body?.enrollToken;
    if ((password !== undefined) === (token !== undefined)) {
      return c.json({ error: 'supply exactly one of password or enrollToken' }, 400);
    }
    if (token !== undefined) {
      // The shared `UNAUTHORIZED_ERROR`: only a Host sends an enroll token, so
      // no Client recovery keys on it.
      if (typeof token !== 'string') return credentialFailure(c, UNAUTHORIZED_ERROR);
      return { token };
    }
    if (!passwordOk(password)) return credentialFailure(c, BAD_PASSWORD_ERROR);
    return { token: null };
  }

  /** A setup token the `finish` route has spent, kept so a failure can put it back. */
  interface SpentSetupToken {
    readonly token: string;
    readonly entry: SetupTokenEntry;
  }

  /**
   * Read a JSON body and resolve its setup token — the one credential these
   * routes take. `gate` is what separates them: `begin` peeks, while `finish`
   * CONSUMES up front — that delete is what makes a token single-use under
   * concurrency, so its caller must restore the entry on every failure after
   * this point (see the route).
   *
   * Either gate also re-checks that the minting Host is still enrolled, since a
   * revoked Host's outstanding tokens must die with it rather than stay
   * redeemable for the rest of their TTL. Absent, mistyped, unknown, expired,
   * spent and revoked-minter are one delayed 401: none of them may tell a caller
   * which one it hit.
   */
  async function readSetupGated<T extends { setupToken?: unknown }>(
    c: Context<AppEnv>,
    gate: 'peek' | 'consume',
  ): Promise<{ body: T; spent: SpentSetupToken | null } | Response> {
    const body = await readJson<T>(c);
    const token: unknown = body?.setupToken;
    if (typeof token !== 'string') return credentialFailure(c, SETUP_TOKEN_INVALID_ERROR);
    const entry = gate === 'consume' ? setupTokens.consume(token) : setupTokens.peek(token);
    if (!entry) return credentialFailure(c, SETUP_TOKEN_INVALID_ERROR);
    // Nothing is restored here: a revoked minter's token is dead, not unlucky.
    if (!(await hostStore.has(entry.hostId))) {
      return credentialFailure(c, SETUP_TOKEN_INVALID_ERROR);
    }
    return { body: body as T, spent: gate === 'consume' ? { token, entry } : null };
  }

  const app = new Hono<AppEnv>();
  // The WS relay routes need the http server that `serve()` builds later, so the
  // adapter is created here and `injectWebSocket` is handed back to the caller.
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  // The Host (standalone webview) and dev Pocket builds call the API from
  // other origins, so preflights must succeed. Permissive CORS is safe here:
  // every endpoint is gated by a credential — the setup password, a setup
  // token, or a bearer token — and no cookies exist for a foreign origin to
  // ride on.
  app.use('/api/*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization'] }));

  // Shared greeting, kept from the skeleton so `lib` and `server` stay agreed.
  app.get(HELLO_ROUTE, (c) => c.json(helloResponse()));

  // --- Setup: token-gated passkey registration -----------------------------
  // The credential is a Host's single-use setup token and nothing else: the
  // only way to register a passkey is off a QR an enrolled Host displayed.
  // `begin` is what mints the WebAuthn registration challenge, so both routes
  // gate identically and neither is the softer path.

  app.post(API_ROUTES.setupBegin, async (c) => {
    const gated = await readSetupGated<SetupBeginRequest>(c, 'peek');
    if (gated instanceof Response) return gated;
    const { challenge } = setupChallenges.issue();
    const account = await accounts.load();
    // The registered credential ids ride back so the browser can exclude them,
    // and only a caller that already passed the gate above ever sees them.
    const res: SetupBeginResponse = {
      challenge,
      rpId,
      accountId: SELFHOST_ACCOUNT_ID,
      existingCredentialIds: account?.passkeys.map((p) => p.credentialId) ?? [],
    };
    return c.json(res);
  });

  app.post(API_ROUTES.setupFinish, async (c) => {
    // The token is spent at the gate, before any of the checks below run: that
    // delete is what makes it single-use under concurrency, so of two finishes
    // racing one token only one can ever reach `appendPasskey`. The cost is
    // that every failure below has to put it back — an ordinary rejected
    // attempt must leave the QR scannable — which the `finally` does.
    const gated = await readSetupGated<SetupFinishRequest>(c, 'consume');
    if (gated instanceof Response) return gated;
    const { body, spent } = gated;
    let registered = false;
    try {
      // Decode and sanity-check clientDataJSON — we do NOT parse attestation
      // (attestation: 'none'); the browser already handed us the public key.
      const clientData = decodeClientData(body.clientDataJSON);
      if (!clientData) return c.json({ error: 'malformed clientDataJSON' }, 400);
      if (clientData.type !== 'webauthn.create') {
        return c.json({ error: 'clientData type must be webauthn.create' }, 400);
      }
      const challenge = normalizeChallenge(clientData.challenge);
      if (!challenge || !setupChallenges.consume(challenge)) {
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
      registered = true;

      const res: SetupFinishResponse = {
        accountId: SELFHOST_ACCOUNT_ID,
        credentialId: body.credentialId,
      };
      return c.json(res);
    } finally {
      // Its original expiry rides along, so a retry never buys extra time.
      if (spent && !registered) setupTokens.restore(spent.token, spent.entry);
    }
  });

  // --- Sign-in: passkey assertion → session token -------------------------

  app.post(API_ROUTES.signinBegin, (c) => {
    const { challenge } = signinChallenges.issue();
    const res: SigninBeginResponse = { challenge, rpId };
    return c.json(res);
  });

  /**
   * Sign-in's verifier: pull the challenge out of the assertion's own
   * clientDataJSON and consume it (single-use, BEFORE verifying — a captured
   * assertion can never be replayed even if verification succeeds), then verify
   * against the STORED passkey for the asserted credential. Re-auth verifies
   * the same way but against a challenge it *derives*, so it cannot share this.
   */
  const verifyFreshAssertion = async (
    assertion: SigninFinishRequest['assertion'] | undefined,
  ): Promise<
    { ok: true; publicKey: string } | { ok: false; status: 400 | 401 | 404; error: string }
  > => {
    if (!assertion || typeof assertion.credentialId !== 'string') {
      return { ok: false, status: 400, error: 'malformed assertion' };
    }
    const stored = await accounts.findPasskey(assertion.credentialId);
    if (!stored) return { ok: false, status: 404, error: 'unknown credential' };

    const clientData = decodeClientData(assertion.clientDataJSON);
    if (!clientData || typeof clientData.challenge !== 'string') {
      return { ok: false, status: 400, error: 'malformed clientDataJSON' };
    }
    const challenge = normalizeChallenge(clientData.challenge);
    if (!challenge) {
      return { ok: false, status: 400, error: 'malformed clientDataJSON' };
    }
    if (!signinChallenges.consume(challenge)) {
      return { ok: false, status: 400, error: 'unrecognized or expired challenge' };
    }

    const result = await verifyPasskeyAssertion(assertion as PasskeyAssertion, stored.publicKey, {
      challenge,
      origin,
      rpId,
      // Same server-wide UV policy re-auth enforces, so sign-in is not a
      // softer path than a presence proof when UV is required.
      requireUserVerification: config.requireUserVerification,
    });
    if (!result.ok) {
      return { ok: false, status: 401, error: `assertion rejected: ${result.reason}` };
    }
    // The verified passkey's public key travels back to the caller. It is
    // public, and a Client needs it to build pair/connect requests — see
    // `SigninFinishResponse.passkeyPublicKey`.
    return { ok: true, publicKey: stored.publicKey };
  };

  app.post(API_ROUTES.signinFinish, async (c) => {
    const body = await readJson<SigninFinishRequest>(c);
    const verdict = await verifyFreshAssertion(body?.assertion);
    if (!verdict.ok) return c.json({ error: verdict.error }, verdict.status);

    const { token, session } = sessions.mint(SELFHOST_ACCOUNT_ID);
    const res: SigninFinishResponse = {
      sessionToken: token,
      accountId: session.accountId,
      expiresAt: session.expiresAt,
      passkeyPublicKey: verdict.publicKey,
    };
    return c.json(res);
  });

  // --- Host enrollment: credential-gated, appends to hosts.json ------------

  app.post(API_ROUTES.hostEnroll, async (c) => {
    const body = await readJson<HostEnrollRequest>(c);
    // The shape ladder runs out here, ahead of the gate below, which holds only
    // the redemption that has to be serialized.
    const picked = await pickCredential(body, c);
    if (picked instanceof Response) return picked;
    const enrollToken = picked.token;
    let host: StoredHost;
    try {
      host = await hostStore.enroll(async (firstEnrollment) => {
        if (enrollToken !== null) {
          if (!firstEnrollment) {
            // The offer is already dead by durable Server state. Best-effort
            // cleanup keeps an old installer file from continuing to advertise
            // it locally, but its outcome must not distinguish token guesses.
            await invalidateEnrollOffer(config.enrollTokenFile);
            throw new EnrollmentCredentialRejected();
          }
          // Unconfigured, absent, malformed, expired, wrong-shaped and wrong-
          // token are one rejection: none may tell a caller which one it hit.
          const redemption = await redeemEnrollToken(config.enrollTokenFile, enrollToken);
          if (redemption === 'rejected') throw new EnrollmentCredentialRejected();
          if (redemption === 'not-invalidated') throw new EnrollmentOfferNotInvalidated();
        } else if (firstEnrollment) {
          // A setup-password enrollment can win the same first-Host race. Take
          // the offer away before minting its sibling credential.
          if ((await invalidateEnrollOffer(config.enrollTokenFile)) === 'not-invalidated') {
            throw new EnrollmentOfferNotInvalidated();
          }
        }
      });
    } catch (err) {
      if (err instanceof EnrollmentCredentialRejected) {
        return credentialFailure(c, UNAUTHORIZED_ERROR);
      }
      if (err instanceof EnrollmentOfferNotInvalidated) {
        // Reached only after a valid bootstrap credential, so answering fast
        // would confirm it. Keep the same delay while retaining the operator-
        // visible 500: no Host was minted against an offer still on disk.
        await delay(credentialFailureDelayMs);
        return c.json({ error: 'could not invalidate the enroll token' }, 500);
      }
      throw err;
    }
    // The Host enforces `origin`/`rpId` as its ConnectionPolicy (server.md).
    const res: HostEnrollResponse = {
      hostId: host.hostId,
      hostToken: host.hostToken,
      origin,
      rpId,
      // Mirrored to the Host so both sides demand the same thing. The Host
      // is the final authority, so a Server that demands UV while the Host
      // does not would leave the weaker verifier deciding access.
      ...(config.requireUserVerification ? { requireUserVerification: true } : {}),
    };
    return c.json(res);
  });

  // Gate a route on a valid `Authorization: Bearer` session token.
  const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
    const token = bearerToken(c);
    const session = token ? sessions.validate(token) : null;
    if (!session) return c.json({ error: UNAUTHORIZED_ERROR }, 401);
    c.set('session', session);
    await next();
  };

  // Gate a route on a valid `Authorization: Bearer` host token. Mirrors
  // `requireSession`, resolving through the constant-time `findByToken`.
  const requireHost: MiddlewareHandler<AppEnv> = async (c, next) => {
    const token = bearerToken(c);
    const host = token ? await hostStore.findByToken(token) : undefined;
    if (!host) return c.json({ error: 'unauthorized' }, 401);
    c.set('host', host);
    await next();
  };

  // --- Re-auth: the presence proof for one end-to-end ceremony -------------
  // The challenge is derived, not random: `presenceChallenge(binding, nonce)`,
  // so an assertion produced for one pairing or connection authenticates
  // nothing anywhere else (remote-security-model.md, Presence proofs). The
  // Server learns only routing values and a handshake hash — which the relay
  // already sees — and the exchange extends nothing: the session's life and its
  // relay socket are untouched.

  app.post(API_ROUTES.reauthBegin, requireSession, async (c) => {
    const body = await readJson<Partial<ReauthBeginRequest>>(c);
    const binding: unknown = body?.binding;
    if (!isPresenceBinding(binding)) {
      return c.json({ error: 'malformed presence binding' }, 400);
    }
    // The binding's credential must be one this account can actually assert
    // with: it is the sole `allowCredentials` entry, so naming an unregistered
    // one could only ever produce an assertion `finish` has no key to check.
    if (!(await accounts.findPasskey(binding.passkeyCredentialId))) {
      return c.json({ error: 'unknown credential' }, 404);
    }
    const serverNonce = toBase64Url(randomBytes(32));
    let challenge: string;
    try {
      challenge = await presenceChallenge(binding, serverNonce);
    } catch {
      // A bounded-but-not-base64url field: the builder throws, and nothing is
      // remembered, so a broken binding costs a 400 rather than a map entry.
      return c.json({ error: 'malformed presence binding' }, 400);
    }
    presenceNonces.remember(serverNonce, binding);
    const res: ReauthBeginResponse = {
      challenge,
      rpId,
      serverNonce,
      // The one credential this ceremony may assert with. A `get()` that could
      // answer with any of the account's passkeys would let a synced credential
      // the Host never paired satisfy a proof bound to one it did.
      allowCredentials: [binding.passkeyCredentialId],
    };
    return c.json(res);
  });

  app.post(API_ROUTES.reauthFinish, requireSession, async (c) => {
    const body = await readJson<Partial<ReauthFinishRequest>>(c);
    const serverNonce: unknown = body?.serverNonce;
    // The shape first, so nothing below has to re-narrow it; every value that
    // could possibly be a nonce still reaches `consume`.
    if (typeof serverNonce !== 'string') {
      return c.json({ error: 'unrecognized or expired nonce' }, 400);
    }
    // Consumed FIRST, whatever the rest of this decides: single use is what
    // stops one WebAuthn prompt proving presence for a second ceremony.
    const pending = presenceNonces.consume(serverNonce);
    if (!pending) return c.json({ error: 'unrecognized or expired nonce' }, 400);
    const assertion = body?.assertion;
    if (!assertion || typeof assertion.credentialId !== 'string') {
      return c.json({ error: 'malformed assertion' }, 400);
    }
    // The assertion must be by the credential the binding named — the one the
    // Host will check the ACL against — not merely by some registered passkey.
    if (assertion.credentialId !== pending.binding.passkeyCredentialId) {
      return c.json({ error: 'assertion is for a different credential' }, 401);
    }
    const stored = await accounts.findPasskey(pending.binding.passkeyCredentialId);
    if (!stored) return c.json({ error: 'unknown credential' }, 404);
    // Recomputed from the binding this server stored, never from anything the
    // caller sent back with the assertion.
    const challenge = await presenceChallenge(pending.binding, serverNonce);
    const result = await verifyPasskeyAssertion(assertion, stored.publicKey, {
      challenge,
      origin,
      rpId,
      requireUserVerification: config.requireUserVerification,
    });
    if (!result.ok) return c.json({ error: `assertion rejected: ${result.reason}` }, 401);
    // It extends nothing: no session TTL, no presence stamp. The Host is what
    // consumes this proof, and it verifies the assertion itself.
    const res: ReauthFinishResponse = { verifiedAt: now() };
    return c.json(res);
  });

  // --- Host presence: enrolled hosts + whether each is connected -----------

  app.get(API_ROUTES.hosts, requireSession, async (c) => {
    const hosts = await hostStore.list();
    const res: HostsResponse = {
      hosts: hosts.map((h) => ({ hostId: h.hostId, online: hub.isHostOnline(h.hostId) })),
    };
    return c.json(res);
  });

  // --- Setup tokens: the credential behind a Host's QR ---------------------

  app.post(API_ROUTES.hostSetupToken, requireHost, (c) => {
    // The token only; the Host composes the QR's URL (`SetupTokenResponse`)
    // around the invitation it holds in memory, and redemption here no longer
    // flips anything on that side.
    const { token, expiresAt } = setupTokens.issue(c.get('host').hostId);
    const res: SetupTokenResponse = { token, expiresAt };
    return c.json(res);
  });

  /**
   * Retire a scanned token without registering anything: a phone that already
   * holds a session spends the code itself, so a photographed QR cannot
   * register a passkey afterwards.
   *
   * Every refusal — mistyped, unknown, expired, already spent, or minted by a
   * since-revoked Host — is the one delayed 401 the setup gates answer with,
   * for the same reason: none of them may tell a caller which one it hit.
   */
  app.post(API_ROUTES.setupRetire, requireSession, async (c) => {
    // The same gate `finish` runs, so the two cannot drift on what a spendable
    // token is. The spent entry is dropped rather than kept: retiring it is the
    // outcome the caller wanted, so there is no failure left to restore it for.
    const gated = await readSetupGated<SetupRetireRequest>(c, 'consume');
    if (gated instanceof Response) return gated;
    return c.body(null, 204);
  });

  // --- Web Push: subscriptions (client-facing) and delivery (host-facing) --
  // Two audiences, two credentials, and possession of the `deliveryId` is the
  // whole Client-facing authorization: `server-lib-common/src/remote/wire.ts`
  // -> "Web Push" states the contract, docs/specs/server.md -> Web Push the
  // rules these routes implement.

  app.get(API_ROUTES.pushConfig, (c) => {
    // The VAPID public key is public by construction — it ships to every
    // browser that subscribes — so this needs no auth.
    const res: PushConfigResponse = { applicationServerKey: config.vapidPublicKey ?? null };
    return c.json(res);
  });

  app.post(API_ROUTES.pushSubscribe, requireSession, async (c) => {
    if (!config.vapidPublicKey) return c.json({ error: 'push is not configured' }, 503);
    const body = await readJson<PushSubscribeRequest>(c);
    if (
      !body ||
      typeof body.hostId !== 'string' ||
      !isDeliveryId(body.deliveryId) ||
      !isSubscriptionPayload(body.subscription)
    ) {
      return c.json({ error: 'malformed request' }, 400);
    }

    // The server POSTs to this endpoint later. Reject obvious local/literal
    // targets now; the real sender also filters the DNS result used by its TLS
    // connection, closing hostname rebinding and mixed-answer bypasses.
    if (!isPublicHttpsPushEndpoint(body.subscription.endpoint)) {
      return c.json({ error: 'endpoint must be a public https URL' }, 400);
    }

    // Subscribing to a host that does not exist would strand a row no Host can
    // ever read or prune.
    if (!(await hostStore.has(body.hostId))) {
      return c.json({ error: 'unknown host' }, 404);
    }

    const stored = await pushStore.upsert({
      hostId: body.hostId,
      deliveryId: body.deliveryId,
      endpoint: body.subscription.endpoint,
      keys: body.subscription.keys,
      vapidPublicKey: config.vapidPublicKey,
    });
    // The state the mutation left behind, not the delta: a committed POST whose
    // response was lost is repaired by its own idempotent retry, which cannot
    // re-announce a deletion but can always answer what is there now.
    const res: PushSubscribeResponse = {
      subscribedAt: stored.subscription.subscribedAt,
      hostIds: [...stored.endpointHostIds],
    };
    return c.json(res);
  });

  // Registered before the `:deliveryId` route below. They differ by method, so
  // neither can shadow the other, but keeping the literal path first means a
  // future GET or POST on the parameterized route cannot silently swallow it.
  app.post(API_ROUTES.pushSubscriptionsQuery, requireSession, async (c) => {
    const body = await readJson<PushSubscriptionsQueryRequest>(c);
    const deliveryIds: unknown = body?.deliveryIds;
    if (
      !Array.isArray(deliveryIds) ||
      deliveryIds.length === 0 ||
      deliveryIds.length > MAX_PUSH_QUERY_DELIVERY_IDS ||
      // Every id is bounded here, as it is at subscribe: `readJson` caps
      // nothing, and a value no Host ever minted cannot match a row anyway.
      deliveryIds.some((id) => !isDeliveryId(id))
    ) {
      return c.json(
        { error: `deliveryIds must be 1..${MAX_PUSH_QUERY_DELIVERY_IDS} delivery ids` },
        400,
      );
    }
    // Parameterized by capability, never by identity: only rows whose id the
    // caller PRESENTED are reported, so this can never enumerate a row the
    // caller does not already hold the capability for. Current-VAPID only, for
    // the same reason the Host views are — a row under a rotated key cannot
    // receive a send signed by the current one, so reporting it would leave
    // Pocket believing push is on.
    const rows = await pushStore.listForDeliveryIds(deliveryIds as string[]);
    const res: PushSubscriptionsQueryResponse = {
      registered: rows
        .filter(isVapidCurrent)
        .map((s) => ({ hostId: s.hostId, deliveryId: s.deliveryId })),
    };
    return c.json(res);
  });

  /**
   * Idempotent, and **always 204** — for an id that never existed, one already
   * deleted, and one that was live. Answering differently would turn the route
   * into an oracle for whether a guessed delivery id names a row.
   */
  app.delete(API_ROUTES.pushSubscriptionDelete, requireSession, async (c) => {
    // Bounded like every other delivery id, and still 204: an id no Host could
    // have minted names no row, so refusing it early only avoids reading the
    // file for a value that cannot match.
    const deliveryId = c.req.param('deliveryId');
    if (isDeliveryId(deliveryId)) await pushStore.removeDelivery(deliveryId);
    return c.body(null, 204);
  });

  app.get(API_ROUTES.pushDevices, requireHost, async (c) => {
    const subscriptions = await currentPushSubscriptionsForHost(c.get('host').hostId);
    // Delivery ids only. The Host holds the ACL and is the only side that can
    // turn one into a human label, so the Server never learns one.
    const res: PushDevicesResponse = {
      devices: subscriptions.map((s) => ({
        deliveryId: s.deliveryId,
        subscribedAt: s.subscribedAt,
      })),
    };
    return c.json(res);
  });

  app.post(API_ROUTES.pushSend, requireHost, async (c) => {
    const sender = config.pushSender;
    if (!sender) return c.json({ error: 'push is not configured' }, 503);
    const body = await readJson<PushSendRequest>(c);
    if (!body || typeof body.title !== 'string' || typeof body.body !== 'string') {
      return c.json({ error: 'malformed request' }, 400);
    }
    // Targets are required. The Host holds the ACL and is the only party that
    // may decide who a push reaches; a Server that fanned out on its own would
    // keep notifying a Client the Host had revoked, since nothing propagates a
    // revocation today (docs/specs/remote-security-model.md).
    const names: unknown = body.deliveryIds;
    if (!Array.isArray(names) || names.length === 0 || names.some((n) => !isDeliveryId(n))) {
      return c.json({ error: 'deliveryIds must be a non-empty array of delivery ids' }, 400);
    }

    // The Host is identified by its token, never by the body: a Host can only
    // ever reach subscriptions registered against itself.
    const subscriptions = await currentPushSubscriptionsForHost(c.get('host').hostId);
    const targets = subscriptions.filter((s) => names.includes(s.deliveryId));

    // Title and body originate in a renderer and are ultimately Pane-derived,
    // so they are re-bounded here rather than trusted — the same
    // revalidate-at-the-boundary rule the alarm settings follow, through the
    // same shared function the Host used (`boundedPushText`).
    const payload = JSON.stringify({
      title: boundedPushText(body.title, { limit: PUSH_TEXT_LIMIT, fallback: 'Dormouse' }),
      body: boundedPushText(body.body, {
        limit: PUSH_TEXT_LIMIT,
        fallback: 'A terminal needs attention.',
      }),
      ...(typeof body.tag === 'string' && body.tag
        ? // Code-point slice for the same reason as `boundedPushText`: a cut
          // mid-surrogate would ship a lone half.
          { tag: Array.from(body.tag).slice(0, PUSH_TEXT_LIMIT).join('') }
        : {}),
    });

    // Every send starts at once, so one deadline per send also bounds the whole
    // route regardless of how many devices a Host has.
    const deadlineMs = config.pushSendDeadlineMs ?? PUSH_SEND_DEADLINE_MS;
    const results = await Promise.all(
      targets.map(async (s) => ({
        endpoint: s.endpoint,
        result: await sendWithinDeadline(
          sender,
          { endpoint: s.endpoint, keys: s.keys },
          payload,
          deadlineMs,
        ),
      })),
    );
    // Forget subscriptions the push service called permanently gone, so a
    // reinstalled phone does not leave a row that fails on every alarm. Batched
    // into one rewrite rather than one per endpoint.
    const expired = results.filter((r) => r.result === 'expired');
    if (expired.length > 0) await pushStore.removeEndpoints(expired.map((r) => r.endpoint));

    const res: PushSendResponse = {
      delivered: results.filter((r) => r.result === 'delivered').length,
      expired: expired.length,
      unknown: names.filter((n) => !targets.some((t) => t.deliveryId === n)).length,
      failed: results.filter((r) => r.result === 'failed').length,
    };
    return c.json(res);
  });

  /**
   * Whether a stored row was minted for the active VAPID key, and is therefore
   * deliverable. The one definition both the Client readback and the Host-facing
   * views below filter on; they differ only in what an unconfigured key means.
   */
  function isVapidCurrent(s: StoredPushSubscription): boolean {
    return s.vapidPublicKey === config.vapidPublicKey;
  }

  /**
   * Only subscriptions minted for the active VAPID key are deliverable.
   * Old-key rows remain on disk so Pocket can diagnose and repair a rotation,
   * but they must never appear in the Host's device view or send fan-out.
   */
  async function currentPushSubscriptionsForHost(hostId: string) {
    if (!config.vapidPublicKey) return [];
    const subscriptions = await pushStore.listForHost(hostId);
    return subscriptions.filter(isVapidCurrent);
  }

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
      if (!session) return c.json({ error: UNAUTHORIZED_ERROR }, 401);
      return next();
    },
    upgradeWebSocket((c) => {
      // Re-checked here, not just in the middleware: a session can expire
      // between that check and the upgrade.
      const token = c.req.query(WS_TOKEN_PARAM);
      let conn: ClientConn | undefined;
      return {
        onOpen: (_evt, ws) => {
          if (!token || !sessions.validate(token)) {
            ws.close(1008, 'unauthorized');
            return;
          }
          conn = hub.registerClient(ws);
        },
        onMessage: (evt) => {
          if (conn && typeof evt.data === 'string') hub.onClientFrame(conn, evt.data);
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
  const serveFile = serveStatic({ root });
  app.get('/*', (c, next) => {
    // Staged before `serveFile` so its `c.body(...)` picks the header up, the
    // same way it picks up its own `Content-Type`. Deliberately not
    // `serveStatic`'s `onFound` hook, which runs *after* the Response has been
    // built and so cannot add a header to it.
    c.header('Cache-Control', pocketCacheControl(c.req.path));
    return serveFile(c, next);
  });
  // Re-read the SPA shell per deep-link fallback: a Pocket rebuild swaps in an
  // index.html referencing new content-hashed assets, and a cached copy would
  // keep pointing at deleted files until the server restarts. The fallback is
  // not a hot path, and a read failure degrades to a 404 instead of a crash.
  app.get('*', async (c) => {
    // This handler answers with the shell or with nothing, whatever was asked
    // for, so the class the static handler staged from the *request* path is
    // wrong here — a response's cache policy describes the response.
    c.header('Cache-Control', POCKET_SHELL_CACHE_CONTROL);
    // A subresource miss is not a routing question, and the shell is never a
    // useful answer to one. Answering it put an HTML body under a hashed-asset
    // URL: `immutable` then meant the browser could never revalidate it away,
    // turning a request made during a deploy — exactly the window this cache
    // policy exists for — into a permanently broken app.
    if (c.req.path.startsWith('/assets/')) return c.notFound();
    const html = await readFile(indexHtmlPath, 'utf8').catch(() => null);
    return html ? c.html(html) : c.notFound();
  });
}

/** Keep a hashed asset forever; its name changes when its content does. */
const POCKET_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** Revalidate everything else before use. */
const POCKET_SHELL_CACHE_CONTROL = 'no-cache';

/**
 * The Pocket build comes in exactly two kinds. Vite content-hashes everything
 * it emits into `assets/`, while `public/` passes through unhashed to the root
 * (`sw.js`, the manifest, the icons) alongside the generated `index.html`.
 *
 * Revalidating the unhashed half is the load-bearing part: `emptyOutDir`
 * deletes the previous build's hashed assets, so a heuristically cached
 * `index.html` does not merely serve stale code — it requests files that no
 * longer exist, and the app fails to boot rather than degrading. `immutable` on
 * the hashed half is only a bonus, and is safe for exactly the same reason.
 *
 * Decided from the request path rather than the resolved file path, which is
 * platform-shaped. If Vite ever emits an unhashed file into `assets/`, or
 * `assetsDir` is overridden, this test silently mislabels it.
 */
function pocketCacheControl(requestPath: string): string {
  return requestPath.startsWith('/assets/')
    ? POCKET_ASSET_CACHE_CONTROL
    : POCKET_SHELL_CACHE_CONTROL;
}

// ---------------------------------------------------------------------------
// Helpers

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

/** Longest push title/body we will forward; see the send route for why. */
const PUSH_TEXT_LIMIT = 200;

/** Read an `Authorization: Bearer <token>` header, or null if absent/malformed. */
function bearerToken(c: Context<AppEnv>): string | null {
  const match = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '');
  return match ? match[1]! : null;
}

/**
 * Base64url of exactly {@link DELIVERY_ID_LENGTH} characters — the Host mints
 * 32 random bytes, so anything else is not an id any Host ever issued and must
 * be refused before it becomes a row key.
 */
function isDeliveryId(value: unknown): value is string {
  return isExactBase64Url(value, DELIVERY_ID_LENGTH);
}

/** True if `value` is a `PushSubscriptionPayload` with both encryption keys. */
function isSubscriptionPayload(value: unknown): value is PushSubscriptionPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as PushSubscriptionPayload;
  return (
    typeof v.endpoint === 'string' &&
    !!v.keys &&
    typeof v.keys === 'object' &&
    typeof v.keys.p256dh === 'string' &&
    typeof v.keys.auth === 'string'
  );
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

/** Canonicalize browser-serialized base64url challenges before single-use lookup. */
function normalizeChallenge(challenge: unknown): string | null {
  if (typeof challenge !== 'string') return null;
  try {
    return toBase64Url(fromBase64Url(challenge));
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
