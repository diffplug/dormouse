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
  HELLO_ROUTE,
  HostChallengeIssuer,
  SELFHOST_ACCOUNT_ID,
  UNAUTHORIZED_ERROR,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  fromBase64Url,
  getWebCrypto,
  helloResponse,
  toBase64Url,
  utf8Decode,
  boundedPushText,
  verifyPasskeyAssertion,
  verifyPushSubscribeSignature,
} from 'server-lib-common';
import type {
  HostEnrollRequest,
  HostEnrollResponse,
  HostsResponse,
  PasskeyAssertion,
  PushChallengeResponse,
  PushConfigResponse,
  PushDevicesResponse,
  PushSendRequest,
  PushSendResponse,
  PushSubscribeRequest,
  PushSubscribeResponse,
  PushSubscriptionPayload,
  PushSubscriptionsResponse,
  ReauthFinishRequest,
  ReauthFinishResponse,
  SetupBeginRequest,
  SetupBeginResponse,
  SetupFinishRequest,
  SetupFinishResponse,
  SigninBeginResponse,
  SigninFinishRequest,
  SigninFinishResponse,
} from 'server-lib-common';

import { redeemEnrollToken } from './enroll-token.js';
import { Handshake } from './handshake.js';
import { RelayHub } from './relay.js';
import type { ClientConn, HostConn } from './relay.js';
import { secretEquals } from './secrets.js';
import {
  AccountStore,
  DuplicateCredentialError,
  HostStore,
  PushSubscriptionStore,
} from './state.js';
import type { StoredHost, StoredPushSubscription } from './state.js';
import { PUSH_SEND_DEADLINE_MS, sendWithinDeadline } from './push.js';
import type { PushSender } from './push.js';
import { isPublicHttpsPushEndpoint } from './push-endpoint.js';

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
  /**
   * Epoch ms of the last passkey assertion the Server verified for this
   * session — set at sign-in, refreshed by `/api/reauth/finish` and by a
   * verified `connect2` handshake. Pairing requires it to be within
   * `PAIRING_PRESENCE_WINDOW_MS` (handshake.ts `checkPair`).
   */
  lastVerifiedPresence: number;
}

type AppEnv = { Variables: { session: Session; host: StoredHost } };

/** Sessions live 12 hours (server.md: "hours-scale TTL"). */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** A small fixed delay on a rejected credential — the extent of POC brute-force hardening. */
const CREDENTIAL_FAILURE_DELAY_MS = 250;
/** The one answer to a wrong setup password, wherever it is supplied. */
const BAD_PASSWORD_ERROR = 'invalid setup password';

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
    const session: Session = {
      accountId,
      expiresAt: this.#now() + SESSION_TTL_MS,
      lastVerifiedPresence: this.#now(),
    };
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
  const pushStore = new PushSubscriptionStore(config.stateDir, now);
  const sessions = new SessionStore(now);
  // Server-side handshake policy layered on the transport-dumb hub.
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
  // Push subscribe gets its own issuer too, so a challenge minted for one flow
  // can never be redeemed in another. Its signature also carries a distinct
  // domain tag (PUSH_SUBSCRIBE_DOMAIN), which is the half that matters when the
  // other side of the exchange is a Host challenge this server merely relayed.
  const pushChallenges = new HostChallengeIssuer({ now });

  const passwordOk = (provided: unknown): boolean =>
    typeof provided === 'string' && secretEquals(provided, config.setupPassword);

  // Every rejected credential answers 401 the same way, after the same delay.
  async function credentialFailure(c: Context<AppEnv>, error: string): Promise<Response> {
    await delay(CREDENTIAL_FAILURE_DELAY_MS);
    return c.json({ error }, 401);
  }

  // Read a JSON body and enforce the setup password. Returns the parsed body, or
  // a ready 401 `Response` the caller returns as-is — so the password-gated
  // routes share one policy.
  async function readPasswordGated<T extends { password: unknown }>(
    c: Context<AppEnv>,
  ): Promise<T | Response> {
    const body = await readJson<T>(c);
    if (!body || !passwordOk(body.password)) {
      return credentialFailure(c, BAD_PASSWORD_ERROR);
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

  /**
   * Shared by sign-in and re-auth: pull the challenge out of the assertion's
   * own clientDataJSON and consume it (single-use, BEFORE verifying — a
   * captured assertion can never be replayed even if verification succeeds),
   * then verify against the STORED passkey for the asserted credential.
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
      // Same server-wide UV policy the connect handshake enforces, so sign-in
      // is not a softer path than a remote connect when UV is required.
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
    const password = body?.password;
    const enrollToken = body?.enrollToken;
    // Exactly one credential. Trying both in turn would let a spent enroll
    // token fall through to the password, leaving which one authorized the
    // enrollment ambiguous on both sides.
    if ((typeof password === 'string') === (typeof enrollToken === 'string')) {
      return c.json({ error: 'supply exactly one of password or enrollToken' }, 400);
    }
    if (typeof enrollToken === 'string') {
      // Unconfigured, absent, malformed, wrong-shaped and wrong-token are one
      // `rejected`: none of them may tell a caller which one it hit.
      const redemption = await redeemEnrollToken(config.enrollTokenFile, enrollToken);
      if (redemption === 'rejected') return credentialFailure(c, UNAUTHORIZED_ERROR);
      if (redemption === 'not-invalidated') {
        return c.json({ error: 'could not invalidate the enroll token' }, 500);
      }
    } else if (!passwordOk(password)) {
      return credentialFailure(c, BAD_PASSWORD_ERROR);
    }
    const label = typeof body?.label === 'string' ? body.label : '';
    const host = await hostStore.enroll(label);
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

  // --- Re-auth: refresh an existing session's verified-presence stamp ------
  // Pairing requires a recent server-verified assertion (PAIRING_PRESENCE_WINDOW_MS;
  // remote-security-model.md, Pairing Ceremony). When the stamp is stale the
  // Pocket client calls these to re-assert with one WebAuthn prompt — the same
  // verification as sign-in, but the session (and the relay socket opened with
  // its token) is kept rather than re-minted.

  app.post(API_ROUTES.reauthBegin, requireSession, (c) => {
    const { challenge } = signinChallenges.issue();
    const res: SigninBeginResponse = { challenge, rpId };
    return c.json(res);
  });

  app.post(API_ROUTES.reauthFinish, requireSession, async (c) => {
    const body = await readJson<ReauthFinishRequest>(c);
    const verdict = await verifyFreshAssertion(body?.assertion);
    if (!verdict.ok) return c.json({ error: verdict.error }, verdict.status);

    const session = c.get('session');
    session.lastVerifiedPresence = now();
    const res: ReauthFinishResponse = { presenceVerifiedAt: session.lastVerifiedPresence };
    return c.json(res);
  });

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

  // --- Web Push: subscriptions (client-facing) and delivery (host-facing) --
  // See alert.md "Push notifications". Two audiences, two credentials: a
  // Client registers its own subscription with a session token plus a device
  // signature; a Host reads and sends with its `hostToken`.

  // Gate a route on a valid `Authorization: Bearer` host token. Mirrors
  // `requireSession`, resolving through the constant-time `findByToken`.
  const requireHost: MiddlewareHandler<AppEnv> = async (c, next) => {
    const token = bearerToken(c);
    const host = token ? await hostStore.findByToken(token) : undefined;
    if (!host) return c.json({ error: 'unauthorized' }, 401);
    c.set('host', host);
    await next();
  };

  app.get(API_ROUTES.pushConfig, (c) => {
    // The VAPID public key is public by construction — it ships to every
    // browser that subscribes — so this needs no auth.
    const res: PushConfigResponse = { applicationServerKey: config.vapidPublicKey ?? null };
    return c.json(res);
  });

  // No body: the challenge is a pool-wide single-use nonce. What binds it to a
  // host is the signature verified at subscribe, not anything stated here.
  app.post(API_ROUTES.pushChallenge, requireSession, (c) => {
    if (!config.vapidPublicKey) return c.json({ error: 'push is not configured' }, 503);
    const { challenge, expiresAt } = pushChallenges.issue();
    const res: PushChallengeResponse = { challenge, expiresAt };
    return c.json(res);
  });

  app.post(API_ROUTES.pushSubscribe, requireSession, async (c) => {
    if (!config.vapidPublicKey) return c.json({ error: 'push is not configured' }, 503);
    const body = await readJson<PushSubscribeRequest>(c);
    if (
      !body ||
      typeof body.hostId !== 'string' ||
      typeof body.devicePublicKey !== 'string' ||
      typeof body.challenge !== 'string' ||
      typeof body.signature !== 'string' ||
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
    const hosts = await hostStore.list();
    if (!hosts.some((h) => h.hostId === body.hostId)) {
      return c.json({ error: 'unknown host' }, 404);
    }

    // Single-use, consumed BEFORE verifying, so a captured request can never be
    // replayed even when the signature is good (same rule as sign-in).
    if (!pushChallenges.consume(body.challenge)) {
      return c.json({ error: 'unrecognized or expired challenge' }, 400);
    }

    const verified = await verifyPushSubscribeSignature(
      {
        hostId: body.hostId,
        challenge: body.challenge,
        devicePublicKey: body.devicePublicKey,
        endpoint: body.subscription.endpoint,
      },
      body.signature,
    );
    if (!verified) return c.json({ error: 'device signature rejected' }, 401);

    const stored = await pushStore.upsert({
      hostId: body.hostId,
      devicePublicKey: body.devicePublicKey,
      endpoint: body.subscription.endpoint,
      keys: body.subscription.keys,
      vapidPublicKey: config.vapidPublicKey,
    });
    const res: PushSubscribeResponse = {
      subscribedAt: stored.subscription.subscribedAt,
      hostIds: [...stored.deviceHostIds],
    };
    return c.json(res);
  });

  app.get(API_ROUTES.pushSubscriptions, requireSession, async (c) => {
    // Not filtered by a caller-supplied devicePublicKey: that would be an
    // enumeration primitive over an input the caller need not own. The account
    // owns these rows, so the account's session may read them and the Client
    // filters to its own device.
    //
    // No 503 when push is unconfigured — rows can outlive a key being removed,
    // and the truthful answer is the list, not an error.
    const allSubscriptions = await pushStore.list();
    // A row registered under an old VAPID key cannot receive a send signed by
    // the current key. Hide it from the "Push notifications on" readback so
    // Pocket returns the one card to Enable, which re-registers every paired
    // Host. Missing keys are legacy rows and stale in the same way. When push
    // is disabled the raw rows remain readable, preserving the route's
    // diagnostic behavior without claiming they are deliverable.
    const subscriptions = config.vapidPublicKey
      ? allSubscriptions.filter(isVapidCurrent)
      : allSubscriptions;
    // Identities only: the endpoint and its keys are a bearer capability to
    // notify that phone, and never leave the Server.
    const res: PushSubscriptionsResponse = {
      subscriptions: subscriptions.map((s) => ({
        hostId: s.hostId,
        devicePublicKey: s.devicePublicKey,
        subscribedAt: s.subscribedAt,
      })),
    };
    return c.json(res);
  });

  app.get(API_ROUTES.pushDevices, requireHost, async (c) => {
    const subscriptions = await currentPushSubscriptionsForHost(c.get('host').hostId);
    // Identities only. The Host holds the ACL and is the only side that can turn
    // a devicePublicKey into a human label, so the Server never learns one.
    const res: PushDevicesResponse = {
      devices: subscriptions.map((s) => ({
        devicePublicKey: s.devicePublicKey,
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
    const names = body.devicePublicKeys;
    if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== 'string')) {
      return c.json({ error: 'devicePublicKeys must be a non-empty array' }, 400);
    }

    // The Host is identified by its token, never by the body: a Host can only
    // ever reach subscriptions registered against itself.
    const subscriptions = await currentPushSubscriptionsForHost(c.get('host').hostId);
    const targets = subscriptions.filter((s) => names.includes(s.devicePublicKey));

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
      unknown: names.filter((n) => !targets.some((t) => t.devicePublicKey === n)).length,
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
      // Re-resolve the Session OBJECT (not just validity — the middleware
      // already gated that) so the relay can hand the gate a live reference
      // whose presence stamp reauth/connect2 can refresh.
      const token = c.req.query(WS_TOKEN_PARAM);
      const session = token ? sessions.validate(token) : null;
      let conn: ClientConn | undefined;
      // `onClientFrame` is async (pair/connect2 verification), so serialize
      // frames from this socket through a promise chain — a client's frames
      // must be processed in the order they arrived, not raced by the gate.
      let chain: Promise<void> = Promise.resolve();
      return {
        onOpen: (_evt, ws) => {
          if (!session) {
            // Expired between the middleware check and the upgrade.
            ws.close(1008, 'unauthorized');
            return;
          }
          conn = hub.registerClient(ws, session);
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
