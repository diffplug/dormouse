/**
 * Selfhost Relay factory (`docs/specs/relay.md`). Each app owns isolated
 * challenge/session stores and an injectable clock; `index.ts` only maps env.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context, MiddlewareHandler } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import type { NodeWebSocket } from '@hono/node-ws';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  API_ROUTES,
  CEREMONY_FIELD_LIMIT,
  DELIVERY_ID_LENGTH,
  E2E_ID_LENGTH,
  ChallengeIssuer,
  MAX_CLIENT_ID_LENGTH,
  MAX_E2E_CIPHERTEXT_LENGTH,
  MAX_PUSH_QUERY_DELIVERY_IDS,
  MAX_SEALED_PUSH_LENGTH,
  SELFHOST_ACCOUNT_ID,
  SETUP_TOKEN_INVALID_ERROR,
  BAD_PASSWORD_ERROR,
  UNAUTHORIZED_ERROR,
  WS_ROUTES,
  PUSH_SEND_DEADLINE_MS,
  WS_TOKEN_PARAM,
  fromBase64Url,
  getWebCrypto,
  boundedPushText,
  isBoundedBase64Url,
  isExactBase64Url,
  isOrigin,
  isPresenceBinding,
  presenceChallenge,
  toBase64Url,
  utf8Decode,
  isSealedPushV1,
  verifyPasskeyAssertion,
  TokenBucket,
} from 'remote-lib-common';
import type {
  BurrowEnrollRequest,
  BurrowEnrollResponse,
  BurrowsResponse,
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
  SealedPushPayload,
  SealedPushRecipient,
  SetupBeginRequest,
  SetupBeginResponse,
  SetupFinishRequest,
  SetupFinishResponse,
  SetupRetireRequest,
  SetupTokenResponse,
  SigninBeginResponse,
  SigninFinishRequest,
  SigninFinishResponse,
} from 'remote-lib-common';

import { invalidateEnrollOffer, redeemEnrollToken } from './enroll-token.js';
import {
  RelayHub,
  WS_CLOSE_TRY_AGAIN_LATER,
  WS_CLOSE_UNAUTHORIZED,
  WS_CLOSE_UNAUTHORIZED_REASON,
} from './relay.js';
import type { ClientConn, BurrowConn } from './relay.js';
import { secretEquals } from './secrets.js';
import { SetupTokenIssuer } from './setup-token.js';
import type { SetupTokenEntry } from './setup-token.js';
import {
  AccountStore,
  DuplicateCredentialError,
  BurrowLimitReachedError,
  BurrowStore,
  PushSubscriptionStore,
} from './state.js';
import type { StoredBurrow, StoredPushSubscription } from './state.js';
import { sendWithinDeadline } from './push.js';
import type { PushSender } from './push.js';
import { MAX_PUSH_ENDPOINT_LENGTH, isPublicHttpsPushEndpoint } from './push-endpoint.js';
import { isSetupPassword } from './setup-password.js';

/** Runtime configuration; see `index.ts` for how env maps onto this. */
export interface AppConfig {
  /**
   * Gates Burrow enrollment (`POST /api/burrow/enroll`). It no longer registers a
   * passkey: `/api/setup/*` takes a Burrow-minted setup token only.
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
   * assertion this Relay verifies, and mirror it to each Burrow as its
   * `ConnectionPolicy.requireUserVerification` so the two cannot disagree on
   * what a valid assertion is. Omitted/false keeps the presence-only behavior;
   * a deployment opts in explicitly (env → config in `index.ts`).
   */
  readonly requireUserVerification?: boolean;
  /** Directory holding the JSON state files (docs/specs/relay.md, "State files"). */
  readonly stateDir: string;
  /**
   * Absolute path of the installer's `EnrollmentOffer`. Absent or `null` — the
   * default everywhere but an installed Relay — refuses every `enrollToken`.
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
   * The wait before answering a rejected Burrow-enrollment credential; defaults
   * to {@link CREDENTIAL_FAILURE_DELAY_MS}. Injectable for the same reason as
   * `pushSendDeadlineMs` — a suite that pays the real delay on every rejection
   * spends most of its wall time asleep — and never mapped from env: shortening
   * it is a test affordance, not a deployment knob.
   */
  readonly credentialFailureDelay?: () => Promise<void>;
  /**
   * Base64url VAPID public key handed to browsers so they can subscribe. Absent
   * disables push: the config route reports `null` and subscribe/send 503,
   * rather than letting a phone register against a key the Relay cannot sign
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

/** A live sign-in session held in memory (relay.md: everything transient is in memory). */
export interface Session {
  readonly accountId: string;
  readonly expiresAt: number;
}

type AppEnv = { Variables: { session: Session; burrow: StoredBurrow } };

/** Sessions live 12 hours (relay.md: "hours-scale TTL"). */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * How long a presence nonce stays redeemable. The same two minutes a Burrow
 * challenge lasts: both bound one ceremony's WebAuthn prompt, and a longer
 * window would only widen the gap between "the user touched the sensor" and
 * "the Burrow believed it".
 */
const REAUTH_NONCE_TTL_MS = 2 * 60 * 1000;
/**
 * How many unredeemed presence nonces ONE SESSION will hold.
 *
 * `POST /api/reauth/begin` needs only a session token, so without a cap one
 * signed-in caller can grow this map for the process's lifetime by asking —
 * exactly the reason `ChallengeIssuer.issue` sweeps. Far above any real
 * use: a phone holds one nonce at a time, per ceremony.
 *
 * **Per session, never global.** A nonce is minted *before* its WebAuthn
 * prompt, so it waits out seconds of human latency; a global cap made a flood
 * from any other session evict a legitimate phone's nonce inside that window,
 * failing every pairing and connection ceremony for as long as the flood ran.
 * A caller can now only ever evict its own.
 */
const MAX_PENDING_REAUTH_NONCES_PER_SESSION = 8;
/**
 * How many sessions may hold nonces at once. The second half of the bound:
 * per-session caps alone leave the total riding on the session count, so the
 * store holds at most this many buckets — least-recently-used dropped whole —
 * which puts the ceiling at 32 x 8. Reaching it takes 32 distinct sign-ins,
 * each a WebAuthn assertion, rather than 65 bare POSTs.
 */
const MAX_REAUTH_NONCE_SESSIONS = 32;
/**
 * How many unredeemed WebAuthn challenges either issuer will hold. Sized like
 * its siblings — a person signs in from a handful of devices, and every
 * challenge dies in two minutes — and applied because `signinChallenges` is
 * minted by an unauthenticated, bodyless route.
 */
export const MAX_PENDING_CHALLENGES = 64;
/**
 * How often {@link CreatedApp.sweepRevokedBurrows} should be run. `index.ts` owns
 * the timer — `createApp` starts no background work of its own.
 *
 * A minute is chosen against what revocation is: a person editing a file after
 * losing a machine, for whom the difference between instant and a minute is
 * nothing, while the alternative — re-reading the store on every relayed frame
 * — puts a disk read on the path every keystroke takes.
 */
export const BURROW_REVOCATION_SWEEP_MS = 60_000;
/**
 * How often {@link CreatedApp.sweepRelaySockets} should be run. Far more often
 * than the revocation sweep, because it touches no disk — it closes expired
 * Client sessions and pings the rest.
 */
export const RELAY_SWEEP_MS = 30_000;
/**
 * How long a relay socket may go unheard-from before it is closed. Three sweeps
 * of silence: a live peer answers the first ping, so reaching this means the
 * connection is half-open, not idle. Generous against a phone whose radio has
 * dozed, which reconnects anyway.
 */
export const RELAY_IDLE_TIMEOUT_MS = 3 * RELAY_SWEEP_MS;
/** A socket closed for silence, not for anything it did. */
const WS_CLOSE_IDLE = 1001;
const WS_CLOSE_IDLE_REASON = 'no response to heartbeat';
/**
 * The largest frame `ws` may buffer for us. Derived from the wire bounds the
 * relay's own guards enforce — a maximal `ct` plus the envelope around it —
 * because without it `ws` buffers up to 100 MiB before any guard has run.
 * `MAX_CLIENT_ID_LENGTH` is in here because a Burrow frame carries one.
 */
export const MAX_RELAY_FRAME_BYTES =
  MAX_E2E_CIPHERTEXT_LENGTH + MAX_CLIENT_ID_LENGTH + 2 * E2E_ID_LENGTH + 1024;
/**
 * Longest passkey label `account.json` will hold, in code points. A device
 * name, so this is generous — and it is a bound at all because the file is
 * durable and is re-read and re-parsed on every sign-in and every re-auth,
 * while the two sibling fields on the same route are already bounded.
 */
const MAX_PASSKEY_LABEL_LENGTH = 64;

/** A small fixed delay on a rejected credential. */
const CREDENTIAL_FAILURE_DELAY_MS = 250;

/** Initial Burrow-enrollment attempts admitted before the global bucket refills. */
export const BURROW_ENROLL_ATTEMPT_BURST = 8;

/** Sustained Burrow-enrollment admission: one attempt per second. */
export const BURROW_ENROLL_ATTEMPT_REFILL_MS = 1_000;

/**
 * Longest request body any route but `/api/push/send` will read.
 *
 * Unauthenticated routes — `/api/burrow/enroll`, `/api/setup/*`,
 * `/api/signin/finish` — read their body BEFORE the credential gate, so
 * without this any page on the tailnet could make the process buffer gigabytes
 * with no auth, no rate limit, and no delay. Every body this Relay actually
 * takes is a handful of base64url fields, so 64 KiB is orders of magnitude
 * above real use.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * The one route whose legitimate body outgrows {@link MAX_REQUEST_BODY_BYTES}:
 * a fan-out of `MAX_PUSH_QUERY_DELIVERY_IDS` sealed envelopes, each already
 * bounded by `MAX_SEALED_PUSH_LENGTH`. Derived from those two rather than
 * written out, so tightening either tightens this with it; the per-recipient
 * allowance covers the delivery id, the salt, and the JSON around them.
 */
const PUSH_SEND_RECIPIENT_OVERHEAD_BYTES = 256;
export const MAX_PUSH_SEND_BODY_BYTES =
  MAX_PUSH_QUERY_DELIVERY_IDS *
    (DELIVERY_ID_LENGTH + MAX_SEALED_PUSH_LENGTH + PUSH_SEND_RECIPIENT_OVERHEAD_BYTES) +
  PUSH_SEND_RECIPIENT_OVERHEAD_BYTES;

/** The one answer to an over-long body: 413, before any route has run. */
function tooLarge(c: Context<AppEnv>): Response {
  return c.json({ error: 'request body too large' }, 413);
}

/** The credential fields `pickCredential` reads. */
type CredentialBody = { password?: unknown; enrollToken?: unknown };

/** Internal control flow out of BurrowStore's serialized pre-enrollment gate. */
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
 * The Relay nonces `POST /api/reauth/begin` mints and `finish` consumes
 * (`docs/specs/remote-security-model.md` → Presence proofs).
 *
 * Not a {@link ChallengeIssuer} — whose single-use and TTL rules this
 * otherwise shares — because the entry has to carry the *binding*, so `finish`
 * recomputes the challenge from what `begin` signed off on rather than from
 * whatever the caller sends back.
 */
class PresenceNonceStore {
  /**
   * One bucket per session, keyed by the {@link Session} object `SessionStore`
   * minted — a stable identity per session token that no request body can name.
   * Map iteration is insertion order, so re-inserting a bucket on every write
   * makes the front of this map the least recently used one.
   */
  readonly #bySession = new Map<Session, Map<string, PendingPresenceNonce>>();
  /** Every live nonce, so `consume` stays one lookup rather than a bucket scan. */
  readonly #owner = new Map<string, Session>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  /**
   * Hold `binding` against `relayNonce` for {@link REAUTH_NONCE_TTL_MS}, in
   * `session`'s own bucket. Eviction never leaves that bucket, so one caller
   * cannot cost another its live nonce.
   */
  remember(session: Session, relayNonce: string, binding: PresenceBinding): void {
    const now = this.#now();
    this.#sweepExpired(now);
    const bucket = this.#bySession.get(session) ?? new Map<string, PendingPresenceNonce>();
    // Re-inserted on every write, so this bucket becomes the most recently used.
    this.#bySession.delete(session);
    // Oldest first, within this session only: every entry carries the same TTL,
    // so a bucket's insertion order is its expiry order.
    while (bucket.size >= MAX_PENDING_REAUTH_NONCES_PER_SESSION) {
      const oldest = bucket.keys().next();
      if (oldest.done) break;
      bucket.delete(oldest.value);
      this.#owner.delete(oldest.value);
    }
    bucket.set(relayNonce, { binding, expiresAt: now + REAUTH_NONCE_TTL_MS });
    this.#bySession.set(session, bucket);
    this.#owner.set(relayNonce, session);
    // Whole buckets, least recently used first: a session at the ceiling is one
    // that has not asked for a nonce in longer than any other.
    while (this.#bySession.size > MAX_REAUTH_NONCE_SESSIONS) {
      const stalest = this.#bySession.keys().next();
      if (stalest.done) break;
      this.#forget(stalest.value);
    }
  }

  /**
   * Spend `relayNonce`, or `null` when it is unknown or expired. Removed
   * either way, so it can never become valid again — single use is what stops
   * one WebAuthn prompt from proving presence for two ceremonies.
   *
   * Not scoped to the consuming session: a nonce is 256 unguessable bits and
   * the ceremony it belongs to is the *account's*, so which of that account's
   * sessions redeems it is not a distinction this store may invent.
   */
  consume(relayNonce: unknown): PendingPresenceNonce | null {
    if (typeof relayNonce !== 'string') return null;
    const session = this.#owner.get(relayNonce);
    if (session === undefined) return null;
    const bucket = this.#bySession.get(session);
    const entry = bucket?.get(relayNonce);
    this.#owner.delete(relayNonce);
    bucket?.delete(relayNonce);
    if (bucket?.size === 0) this.#bySession.delete(session);
    if (entry === undefined) return null;
    return this.#now() < entry.expiresAt ? entry : null;
  }

  #sweepExpired(now: number): void {
    for (const [session, bucket] of this.#bySession) {
      for (const [nonce, entry] of bucket) {
        if (now < entry.expiresAt) continue;
        bucket.delete(nonce);
        this.#owner.delete(nonce);
      }
      if (bucket.size === 0) this.#bySession.delete(session);
    }
  }

  #forget(session: Session): void {
    for (const nonce of this.#bySession.get(session)?.keys() ?? []) this.#owner.delete(nonce);
    this.#bySession.delete(session);
  }
}

/** What {@link createApp} hands back: the Hono app plus its auth internals. */
export interface CreatedApp {
  readonly app: Hono<AppEnv>;
  readonly sessions: SessionStore;
  /** Middleware for session-gated routes (`/api/burrows`, etc.). */
  readonly requireSession: MiddlewareHandler<AppEnv>;
  /** The relay hub; exposed so `/api/burrows` presence and tests can read it. */
  readonly hub: RelayHub;
  /**
   * Bind the WS relay onto the http server returned by `serve()`. `index.ts`
   * (and tests) MUST call this after `serve()`, per the `@hono/node-ws` pattern
   * — the WebSocket routes are inert until the upgrade handler is injected.
   */
  readonly injectWebSocket: NodeWebSocket['injectWebSocket'];
  /**
   * Close the relay socket of every connected Burrow whose `burrows.json` row is
   * gone, and report how many. `index.ts` runs it every
   * {@link BURROW_REVOCATION_SWEEP_MS}; exposed rather than scheduled here so
   * `createApp` starts no background work, and so a test drives the decision
   * instead of a timer.
   */
  readonly sweepRevokedBurrows: () => Promise<number>;
  /**
   * Close the Client sockets whose session has expired, then ping the rest and
   * close whatever has not been heard from within
   * {@link RELAY_IDLE_TIMEOUT_MS}. Reports what it closed. `index.ts` runs it
   * every {@link RELAY_SWEEP_MS}; exposed for the same reason
   * {@link CreatedApp.sweepRevokedBurrows} is.
   */
  readonly sweepRelaySockets: () => { expired: number; idle: number };
}

/**
 * The `ws` slice the heartbeat needs. Structural rather than an import: `ws` is
 * `@hono/node-ws`'s dependency, not this package's, and a socket that does not
 * answer this shape simply goes unwatched.
 */
interface PingableSocket {
  ping(): void;
  on(event: 'pong' | 'message', listener: () => void): void;
}

export function createApp(config: AppConfig): CreatedApp {
  const now = config.now ?? (() => Date.now());
  const origin = config.origin;
  // The entrypoint enforces this in `readConfig`; direct callers pass the same
  // boundary here, just as they do for the normalized origin below. A Relay
  // must never silently turn an operator-chosen word into its bootstrap secret.
  if (!isSetupPassword(config.setupPassword)) {
    throw new Error(
      'createApp needs a setup password of 64 lowercase hexadecimal characters ' +
        'generated from 32 random bytes.',
    );
  }
  // Enforced, not assumed: every compare below is a string compare against this
  // value, so a `https://host/` that slipped past `readConfig` (a direct caller,
  // a test) would fail each of them while reading as correct.
  //
  // **The scheme too, not merely "bare".** `isOrigin` admits any WHATWG special
  // scheme — `ws://x` reduces to itself — and everything downstream reads this
  // as `http(s)`: no browser can send one as `clientData.origin`, and
  // `pocketContentSecurityPolicy` swaps the scheme by slicing off `http`. The
  // env path has the same guard in `requireOrigin` (`relay/src/config.ts`);
  // this is the one every direct caller passes through.
  if (!isOrigin(origin) || !(origin.startsWith('http://') || origin.startsWith('https://'))) {
    throw new Error(`createApp needs a bare http(s) origin (scheme, host, port), got '${origin}'.`);
  }
  // The one parse, and only for the burrow part.
  const rpId = new URL(origin).hostname;
  const accounts = new AccountStore(config.stateDir, now);
  const burrowStore = new BurrowStore(config.stateDir, now);
  // Joined against the Burrow store so a row outliving its `burrows.json` line is
  // dropped on read (docs/specs/relay.md -> State files).
  const pushStore = new PushSubscriptionStore(config.stateDir, now, burrowStore);
  const sessions = new SessionStore(now);
  const hub = new RelayHub();
  // Separate issuers per flow: a setup challenge cannot be redeemed at sign-in.
  // Both are capped as well as swept: `POST /api/signin/begin` needs no auth
  // and no body, so the expiry sweep alone only makes the map plateau at
  // request-rate x TTL. A flood evicts abandoned challenges of its own making —
  // a real ceremony that loses one retries — and cannot forge or extend any.
  const setupChallenges = new ChallengeIssuer({ now, maxPending: MAX_PENDING_CHALLENGES });
  const signinChallenges = new ChallengeIssuer({ now, maxPending: MAX_PENDING_CHALLENGES });
  // The presence nonces of `/api/reauth/*`. Its own store for the same reason
  // the issuers above are separate — a nonce minted for one flow may never be
  // redeemed in another — and it holds the binding the challenge was derived
  // from, which an issuer cannot.
  const presenceNonces = new PresenceNonceStore(now);
  // Not an issuer: a setup token remembers the Burrow that minted it, so a
  // revoked Burrow's outstanding tokens die with it.
  const setupTokens = new SetupTokenIssuer({ now });
  // Deliberately global, not keyed by a caller-controlled or proxy-supplied
  // address: this bounds work when the origin is public and sources rotate.
  // Every POST spends before its body is read; a refusal creates no per-caller
  // timer, map entry, or queue item.
  const burrowEnrollAttempts = new TokenBucket({
    capacity: BURROW_ENROLL_ATTEMPT_BURST,
    refillIntervalMs: BURROW_ENROLL_ATTEMPT_REFILL_MS,
    now,
  });

  const passwordOk = (provided: unknown): boolean =>
    typeof provided === 'string' && secretEquals(provided, config.setupPassword);

  const waitForEnrollmentFailure =
    config.credentialFailureDelay ?? (() => delay(CREDENTIAL_FAILURE_DELAY_MS));

  // Only Burrow enrollment delays a rejected credential. Its global admission
  // bucket bounds these retained timers; random setup, Burrow, and session
  // bearers answer immediately because delaying them only buys an attacker
  // held requests and their 256-bit values are not online-guessable.
  async function enrollmentCredentialFailure(
    c: Context<AppEnv>,
    error: string,
  ): Promise<Response> {
    await waitForEnrollmentFailure();
    return c.json({ error }, 401);
  }

  /**
   * The credential ladder behind `/api/burrow/enroll`: exactly one of `password`
   * or `enrollToken`, counted by presence rather than by type.
   *
   * Both-or-neither is a 400 rather than a try-each fallback because trying
   * them in turn would let a *spent* token fall through to the password and
   * still succeed, leaving which credential authorized the request ambiguous on
   * both sides. A lone credential of the wrong type is that branch's own delayed
   * 401 — never the 400 for shape.
   *
   * Answers `{ token }` with the caller's still-unverified token — the route
   * redeems it under the Burrow-store mutex — or `{ token: null }` once the
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
      // The shared `UNAUTHORIZED_ERROR`: only a Burrow sends an enroll token, so
      // no Client recovery keys on it.
      if (typeof token !== 'string') return enrollmentCredentialFailure(c, UNAUTHORIZED_ERROR);
      return { token };
    }
    if (!passwordOk(password)) return enrollmentCredentialFailure(c, BAD_PASSWORD_ERROR);
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
   * Either gate also re-checks that the minting Burrow is still enrolled, since a
   * revoked Burrow's outstanding tokens must die with it rather than stay
   * redeemable for the rest of their TTL. Absent, mistyped, unknown, expired,
   * spent and revoked-minter are one 401: none of them may tell a caller
   * which one it hit.
   */
  async function readSetupGated<T extends { setupToken?: unknown }>(
    c: Context<AppEnv>,
    gate: 'peek' | 'consume',
  ): Promise<{ body: T; spent: SpentSetupToken | null } | Response> {
    const invalid = () => c.json({ error: SETUP_TOKEN_INVALID_ERROR }, 401);
    const body = await readJson<T>(c);
    const token: unknown = body?.setupToken;
    if (typeof token !== 'string') return invalid();
    const entry = gate === 'consume' ? setupTokens.consume(token) : setupTokens.peek(token);
    if (!entry) return invalid();
    // Nothing is restored here: a revoked minter's token is dead, not unlucky.
    if (!(await burrowStore.has(entry.burrowId))) return invalid();
    return { body: body as T, spent: gate === 'consume' ? { token, entry } : null };
  }

  const app = new Hono<AppEnv>();
  // The WS relay routes need the http server that `serve()` builds later, so the
  // adapter is created here and `injectWebSocket` is handed back to the caller.
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app });
  // `ws` defaults to a 100 MiB frame, which the relay would buffer whole before
  // any guard ran. Read at upgrade time, so setting it on the options here is
  // what every socket this adapter accepts is built with.
  wss.options.maxPayload = MAX_RELAY_FRAME_BYTES;

  /**
   * Liveness bookkeeping for one relay socket. A half-open TCP connection sends
   * nothing and closes nothing, so its entry — and its Burrow binding — would
   * live until the OS gave up. WebSocket ping/pong is what distinguishes it
   * from a socket that is merely idle, which a terminal legitimately is.
   */
  interface RelayHeartbeat {
    lastSeenAt: number;
    readonly ping: () => void;
    readonly close: () => void;
  }
  const heartbeats = new Set<RelayHeartbeat>();

  /** Track `ws` for the heartbeat; returns the teardown for its `onClose`. */
  function watchLiveness(ws: { raw?: unknown; close: (code?: number, reason?: string) => void }) {
    const raw = ws.raw as PingableSocket | undefined;
    if (typeof raw?.ping !== 'function' || typeof raw.on !== 'function') return () => {};
    const entry: RelayHeartbeat = {
      lastSeenAt: now(),
      ping: () => {
        raw.ping();
      },
      close: () => {
        ws.close(WS_CLOSE_IDLE, WS_CLOSE_IDLE_REASON);
      },
    };
    // Any traffic at all proves the peer is there; a pong is what proves it for
    // a socket that has nothing to say.
    raw.on('pong', () => {
      entry.lastSeenAt = now();
    });
    raw.on('message', () => {
      entry.lastSeenAt = now();
    });
    heartbeats.add(entry);
    return () => heartbeats.delete(entry);
  }

  // Before bodyLimit on purpose: oversized and malformed requests spend from
  // the same budget as a correct-looking guess. OPTIONS is not an attempt.
  app.use(API_ROUTES.burrowEnroll, async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const retryAfterMs = burrowEnrollAttempts.take();
    if (retryAfterMs === null) return next();
    c.header('Retry-After', String(Math.ceil(retryAfterMs / 1_000)));
    return c.json({ error: 'too many enrollment attempts' }, 429);
  });

  // Before every route so no credential gate is reached by way of a body the
  // process already buffered.
  const smallBodies = bodyLimit({ maxSize: MAX_REQUEST_BODY_BYTES, onError: tooLarge });
  const sendBodies = bodyLimit({ maxSize: MAX_PUSH_SEND_BODY_BYTES, onError: tooLarge });
  app.use('*', (c, next) =>
    (c.req.path === API_ROUTES.pushSend ? sendBodies : smallBodies)(c, next),
  );

  // Fixed health probe used by the installers.
  app.get('/api/hello', (c) => c.json({ message: 'Hello, world!' }));

  // --- Setup: token-gated passkey registration -----------------------------
  // The credential is a Burrow's single-use setup token and nothing else: the
  // only way to register a passkey is off a QR an enrolled Burrow displayed.
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
      // And any credential id we could not hand back. It is stored verbatim and
      // returned to every later `setup/begin` as an `existingCredentialIds`
      // entry, which the Client base64url-decodes — so one malformed id from a
      // holder of one live setup token wedges passkey registration for the
      // account until `account.json` is hand-edited.
      if (!isBoundedBase64Url(body.credentialId, CEREMONY_FIELD_LIMIT)) {
        return c.json({ error: 'malformed credentialId' }, 400);
      }

      try {
        await accounts.appendPasskey({
          credentialId: body.credentialId,
          publicKey: body.publicKey,
          // Reduced rather than refused, so a long device name still
          // registers, and bounded because `account.json` is durable and is
          // re-read and re-parsed on every sign-in and every re-auth. The same
          // `boundedPushText` the Burrow reduces a pairing label with, so a
          // control or bidi character cannot reorder what an operator reads
          // out of the file either.
          label: boundedPushText(body.label, { limit: MAX_PASSKEY_LABEL_LENGTH, fallback: '' }),
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

  // --- Sign-in: passkey assertion → session token --------------------------

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
      // Same Relay-wide UV policy re-auth enforces, so sign-in is not a
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

  // --- Burrow enrollment: credential-gated, appends to burrows.json --------

  app.post(API_ROUTES.burrowEnroll, async (c) => {
    const body = await readJson<BurrowEnrollRequest>(c);
    // The shape ladder runs out here, ahead of the gate below, which holds only
    // the redemption that has to be serialized.
    const picked = await pickCredential(body, c);
    if (picked instanceof Response) return picked;
    const enrollToken = picked.token;
    let burrow: StoredBurrow;
    try {
      burrow = await burrowStore.enroll(async (firstEnrollment) => {
        if (enrollToken !== null) {
          if (!firstEnrollment) {
            // The offer is already dead by durable Relay state. Best-effort
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
          // A setup-password enrollment can win the same first-Burrow race. Take
          // the offer away before minting its sibling credential.
          if ((await invalidateEnrollOffer(config.enrollTokenFile)) === 'not-invalidated') {
            throw new EnrollmentOfferNotInvalidated();
          }
        }
      });
    } catch (err) {
      if (err instanceof EnrollmentCredentialRejected) {
        return enrollmentCredentialFailure(c, UNAUTHORIZED_ERROR);
      }
      if (err instanceof BurrowLimitReachedError) {
        // Reached only past a valid credential, so it pays the same delay as
        // every other refusal here, and it names the remedy: revocation is
        // hand-editing `burrows.json` (docs/specs/relay.md -> Guardrails).
        await waitForEnrollmentFailure();
        return c.json({ error: `${err.message}; remove one from burrows.json first` }, 409);
      }
      if (err instanceof EnrollmentOfferNotInvalidated) {
        // Reached only after a valid bootstrap credential, so answering fast
        // would confirm it. Keep the same delay while retaining the operator-
        // visible 500: no Burrow was minted against an offer still on disk.
        await waitForEnrollmentFailure();
        return c.json({ error: 'could not invalidate the enroll token' }, 500);
      }
      throw err;
    }
    // The Burrow enforces `origin`/`rpId` as its ConnectionPolicy (relay.md).
    const res: BurrowEnrollResponse = {
      burrowId: burrow.burrowId,
      burrowToken: burrow.burrowToken,
      origin,
      rpId,
      // Mirrored to the Burrow so both sides demand the same thing. The Burrow
      // is the final authority, so a Relay that demands UV while the Burrow
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

  // Gate a route on a valid `Authorization: Bearer` burrow token. Mirrors
  // `requireSession`, resolving through the constant-time `findByToken`.
  // Wrong-shaped values short-circuit before the store read.
  const requireBurrow: MiddlewareHandler<AppEnv> = async (c, next) => {
    const token = bearerToken(c);
    const burrow = token ? await burrowStore.findByToken(token) : undefined;
    if (!burrow) return c.json({ error: UNAUTHORIZED_ERROR }, 401);
    c.set('burrow', burrow);
    await next();
  };

  // --- Re-auth: the presence proof for one end-to-end ceremony -------------
  // The challenge is derived, not random: `presenceChallenge(binding, nonce)`,
  // so an assertion produced for one pairing or connection authenticates
  // nothing anywhere else (remote-security-model.md, Presence proofs). The
  // Relay learns only routing values and a handshake hash — which the relay
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
    const relayNonce = toBase64Url(randomBytes(32));
    let challenge: string;
    try {
      challenge = await presenceChallenge(binding, relayNonce);
    } catch {
      // A bounded-but-not-base64url field: the builder throws, and nothing is
      // remembered, so a broken binding costs a 400 rather than a map entry.
      return c.json({ error: 'malformed presence binding' }, 400);
    }
    // The caller's own session owns the entry, so a flood can only evict its own.
    presenceNonces.remember(c.get('session'), relayNonce, binding);
    const res: ReauthBeginResponse = {
      challenge,
      rpId,
      relayNonce,
      // The one credential this ceremony may assert with. A `get()` that could
      // answer with any of the account's passkeys would let a synced credential
      // the Burrow never paired satisfy a proof bound to one it did.
      allowCredentials: [binding.passkeyCredentialId],
    };
    return c.json(res);
  });

  app.post(API_ROUTES.reauthFinish, requireSession, async (c) => {
    const body = await readJson<Partial<ReauthFinishRequest>>(c);
    const relayNonce: unknown = body?.relayNonce;
    // The shape first, so nothing below has to re-narrow it; every value that
    // could possibly be a nonce still reaches `consume`.
    if (typeof relayNonce !== 'string') {
      return c.json({ error: 'unrecognized or expired nonce' }, 400);
    }
    // Consumed FIRST, whatever the rest of this decides: single use is what
    // stops one WebAuthn prompt proving presence for a second ceremony.
    const pending = presenceNonces.consume(relayNonce);
    if (!pending) return c.json({ error: 'unrecognized or expired nonce' }, 400);
    const assertion = body?.assertion;
    if (!assertion || typeof assertion.credentialId !== 'string') {
      return c.json({ error: 'malformed assertion' }, 400);
    }
    // The assertion must be by the credential the binding named — the one the
    // Burrow will check the ACL against — not merely by some registered passkey.
    if (assertion.credentialId !== pending.binding.passkeyCredentialId) {
      return c.json({ error: 'assertion is for a different credential' }, 401);
    }
    const stored = await accounts.findPasskey(pending.binding.passkeyCredentialId);
    if (!stored) return c.json({ error: 'unknown credential' }, 404);
    // Recomputed from the binding this Relay stored, never from anything the
    // caller sent back with the assertion.
    const challenge = await presenceChallenge(pending.binding, relayNonce);
    const result = await verifyPasskeyAssertion(assertion, stored.publicKey, {
      challenge,
      origin,
      rpId,
      requireUserVerification: config.requireUserVerification,
    });
    if (!result.ok) return c.json({ error: `assertion rejected: ${result.reason}` }, 401);
    // It extends nothing: no session TTL, no presence stamp. The Burrow is what
    // consumes this proof, and it verifies the assertion itself.
    const res: ReauthFinishResponse = { verifiedAt: now() };
    return c.json(res);
  });

  // --- Burrow presence: enrolled burrows + whether each is connected -------

  app.get(API_ROUTES.burrows, requireSession, async (c) => {
    const burrows = await burrowStore.list();
    const res: BurrowsResponse = {
      burrows: burrows.map((h) => ({ burrowId: h.burrowId, online: hub.isBurrowOnline(h.burrowId) })),
    };
    return c.json(res);
  });

  // --- Setup tokens: the credential behind a Burrow's QR -------------------

  app.post(API_ROUTES.burrowSetupToken, requireBurrow, (c) => {
    // The token only; the Burrow composes the QR's URL (`SetupTokenResponse`)
    // around the invitation it holds in memory, and redemption here no longer
    // flips anything on that side.
    const { token, expiresAt } = setupTokens.issue(c.get('burrow').burrowId);
    const res: SetupTokenResponse = { token, expiresAt };
    return c.json(res);
  });

  /**
   * Retire a scanned token without registering anything: a phone that already
   * holds a session spends the code itself, so a photographed QR cannot
   * register a passkey afterwards.
   *
   * Every refusal — mistyped, unknown, expired, already spent, or minted by a
   * since-revoked Burrow — is the one delayed 401 the setup gates answer with,
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

  // --- Web Push: subscriptions (client-facing) and delivery (burrow-facing) --
  // Two audiences, two credentials, and possession of the `deliveryId` is the
  // whole Client-facing authorization: `remote-lib-common/src/remote/wire.ts`
  // -> "Web Push" states the contract, docs/specs/relay.md -> Web Push the
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
      typeof body.burrowId !== 'string' ||
      !isDeliveryId(body.deliveryId) ||
      !isSubscriptionPayload(body.subscription)
    ) {
      return c.json({ error: 'malformed request' }, 400);
    }

    // The Relay POSTs to this endpoint later. Reject obvious local/literal
    // targets now; the real sender also filters the DNS result used by its TLS
    // connection, closing hostname rebinding and mixed-answer bypasses.
    if (!isPublicHttpsPushEndpoint(body.subscription.endpoint)) {
      return c.json({ error: 'endpoint must be a public https URL' }, 400);
    }

    // Subscribing to a burrow that does not exist would strand a row no Burrow can
    // ever read or prune.
    if (!(await burrowStore.has(body.burrowId))) {
      return c.json({ error: 'unknown burrow' }, 404);
    }

    const stored = await pushStore.upsert({
      burrowId: body.burrowId,
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
      burrowIds: [...stored.endpointBurrowIds],
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
      // nothing, and a value no Burrow ever minted cannot match a row anyway.
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
    // the same reason the Burrow views are — a row under a rotated key cannot
    // receive a send signed by the current one, so reporting it would leave
    // Pocket believing push is on.
    const rows = await pushStore.listForDeliveryIds(deliveryIds as string[]);
    const res: PushSubscriptionsQueryResponse = {
      registered: rows
        .filter(isVapidCurrent)
        .map((s) => ({ burrowId: s.burrowId, deliveryId: s.deliveryId })),
    };
    return c.json(res);
  });

  /**
   * Idempotent, and **always 204** — for an id that never existed, one already
   * deleted, and one that was live. Answering differently would turn the route
   * into an oracle for whether a guessed delivery id names a row.
   */
  app.delete(API_ROUTES.pushSubscriptionDelete, requireSession, async (c) => {
    // Bounded like every other delivery id, and still 204: an id no Burrow could
    // have minted names no row, so refusing it early only avoids reading the
    // file for a value that cannot match.
    const deliveryId = c.req.param('deliveryId');
    if (isDeliveryId(deliveryId)) await pushStore.removeDelivery(deliveryId);
    return c.body(null, 204);
  });

  app.get(API_ROUTES.pushDevices, requireBurrow, async (c) => {
    const subscriptions = await currentPushSubscriptionsForBurrow(c.get('burrow').burrowId);
    // Delivery ids only. The Burrow holds the ACL and is the only side that can
    // turn one into a human label, so the Relay never learns one.
    const res: PushDevicesResponse = {
      devices: subscriptions.map((s) => ({
        deliveryId: s.deliveryId,
        subscribedAt: s.subscribedAt,
      })),
    };
    return c.json(res);
  });

  app.post(API_ROUTES.pushSend, requireBurrow, async (c) => {
    const sender = config.pushSender;
    if (!sender) return c.json({ error: 'push is not configured' }, 503);
    const body = await readJson<PushSendRequest>(c);
    // Recipients are required, one sealed envelope each. The Burrow holds the ACL
    // and is the only party that may decide who a push reaches; a Relay that
    // fanned out on its own would keep notifying a Client the Burrow had revoked,
    // since nothing propagates a revocation today
    // (docs/specs/remote-security-model.md).
    const recipients: unknown = body?.recipients;
    if (
      !Array.isArray(recipients) ||
      recipients.length === 0 ||
      recipients.length > MAX_PUSH_QUERY_DELIVERY_IDS ||
      !recipients.every(isSealedPushRecipient)
    ) {
      return c.json(
        {
          error:
            `recipients must be 1..${MAX_PUSH_QUERY_DELIVERY_IDS} ` +
            '{ deliveryId, sealed } pairs',
        },
        400,
      );
    }

    // The Burrow is identified by its token, never by the body: a Burrow can only
    // ever reach subscriptions registered against itself. The same `burrowId`
    // rides in the payload, because it is how the worker picks the pinned
    // record to decrypt against — taken from the token for the same reason.
    const { burrowId } = c.get('burrow');
    const subscriptions = await currentPushSubscriptionsForBurrow(burrowId);
    const byDelivery = new Map(subscriptions.map((s) => [s.deliveryId, s]));
    const targets = recipients.flatMap((recipient) => {
      const subscription = byDelivery.get(recipient.deliveryId);
      return subscription ? [{ subscription, sealed: recipient.sealed }] : [];
    });

    // Every send starts at once, so one deadline per send also bounds the whole
    // route regardless of how many devices a Burrow has.
    const deadlineMs = config.pushSendDeadlineMs ?? PUSH_SEND_DEADLINE_MS;
    const results = await Promise.all(
      targets.map(async ({ subscription, sealed }) => ({
        endpoint: subscription.endpoint,
        result: await sendWithinDeadline(
          sender,
          { endpoint: subscription.endpoint, keys: subscription.keys },
          // Field by field, never a spread of `sealed`: `isSealedPushV1` bounds
          // the three fields it knows and ignores the rest, so `{ burrowId,
          // ...sealed }` would let a Burrow both override the token's `burrowId`
          // and smuggle readable text past a Relay that must forward neither
          // (docs/specs/security-remote.md -> "What crosses the boundary").
          JSON.stringify({
            burrowId,
            v: sealed.v,
            salt: sealed.salt,
            ct: sealed.ct,
          } satisfies SealedPushPayload),
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
      unknown: recipients.length - targets.length,
      failed: results.filter((r) => r.result === 'failed').length,
    };
    return c.json(res);
  });

  /**
   * Whether a stored row was minted for the active VAPID key, and is therefore
   * deliverable. The one definition both the Client readback and the Burrow-facing
   * views below filter on; they differ only in what an unconfigured key means.
   */
  function isVapidCurrent(s: StoredPushSubscription): boolean {
    return s.vapidPublicKey === config.vapidPublicKey;
  }

  /**
   * Only subscriptions minted for the active VAPID key are deliverable.
   * Old-key rows remain on disk so Pocket can diagnose and repair a rotation,
   * but they must never appear in the Burrow's device view or send fan-out.
   */
  async function currentPushSubscriptionsForBurrow(burrowId: string) {
    if (!config.vapidPublicKey) return [];
    const subscriptions = await pushStore.listForBurrow(burrowId);
    return subscriptions.filter(isVapidCurrent);
  }

  // --- The relay: one burrow socket per burrowId, many client sockets ------
  // Auth rides the `token` query param (browsers cannot set WS headers). A bad
  // token short-circuits with 401 here, so `injectWebSocket` never upgrades it.

  app.get(
    WS_ROUTES.burrow,
    async (c, next) => {
      const token = c.req.query(WS_TOKEN_PARAM);
      const burrow = token ? await burrowStore.findByToken(token) : undefined;
      if (!burrow) return c.json({ error: 'unknown burrow token' }, 401);
      c.set('burrow', burrow);
      return next();
    },
    upgradeWebSocket((c) => {
      // The auth middleware above ran on this same context and stashed `burrow`.
      const burrow = (c as Context<AppEnv>).get('burrow');
      let conn: BurrowConn | undefined;
      let unwatch = () => {};
      return {
        onOpen: (_evt, ws) => {
          conn = hub.registerBurrow(burrow.burrowId, ws);
          unwatch = watchLiveness(ws);
        },
        onMessage: (evt) => {
          if (conn && typeof evt.data === 'string') hub.onBurrowFrame(conn, evt.data);
        },
        onClose: () => {
          unwatch();
          if (conn) hub.unregisterBurrow(conn);
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
      let unwatch = () => {};
      return {
        onOpen: (_evt, ws) => {
          const session = token ? sessions.validate(token) : null;
          if (!session) {
            ws.close(WS_CLOSE_UNAUTHORIZED, WS_CLOSE_UNAUTHORIZED_REASON);
            return;
          }
          // The session rides along so the sweep can re-check it: this gate
          // runs once and the socket outlives it by up to twelve hours.
          const registered = hub.registerClient(ws, session);
          if (!registered) {
            ws.close(WS_CLOSE_TRY_AGAIN_LATER, 'too many client sockets');
            return;
          }
          conn = registered;
          unwatch = watchLiveness(ws);
        },
        onMessage: (evt) => {
          if (conn && typeof evt.data === 'string') hub.onClientFrame(conn, evt.data);
        },
        onClose: () => {
          unwatch();
          if (conn) hub.unregisterClient(conn);
        },
      };
    }),
  );

  /**
   * The socket-level sweep: expire, then probe. `docs/specs/relay.md` -> "Routing"
   * owns both rules. Synchronous and cheap — it touches no disk — so `index.ts`
   * can run it far more often than the revocation sweep.
   */
  function sweepRelaySockets(): { expired: number; idle: number } {
    const at = now();
    const expired = hub.closeExpiredClients(at);
    let idle = 0;
    for (const entry of [...heartbeats]) {
      if (at - entry.lastSeenAt > RELAY_IDLE_TIMEOUT_MS) {
        heartbeats.delete(entry);
        entry.close();
        idle += 1;
        continue;
      }
      // A socket with nothing to say is not a dead one; the pong is what tells
      // the two apart, and it refreshes `lastSeenAt` when it lands.
      entry.ping();
    }
    return { expired, idle };
  }

  /** `docs/specs/relay.md` -> Guardrails owns the rule this enforces. */
  async function sweepRevokedBurrows(): Promise<number> {
    const online = hub.onlineBurrowIds();
    if (online.length === 0) return 0;
    // One read for the whole sweep: `has()` reads the file per call, and a Burrow
    // deleted mid-sweep is caught by the next one.
    //
    // **Nothing is closed on an answer this sweep did not actually read.**
    // Unparseable JSON throws out of here and the interval swallows it;
    // `listIfPresent` is what covers the other half, an absent file — both are
    // ordinary states for a file whose editing *is* the revocation mechanism,
    // and reading either as "nobody is enrolled" would drop every session.
    const rows = await burrowStore.listIfPresent();
    if (rows === null) return 0;
    const enrolled = new Set(rows.map((h) => h.burrowId));
    let closed = 0;
    for (const burrowId of online) {
      if (enrolled.has(burrowId)) continue;
      if (hub.closeBurrow(burrowId)) closed += 1;
    }
    return closed;
  }

  // --- Static Pocket app: GET /* fallback, registered LAST so every API and
  //     /ws route above wins. Missing build → a stub with the build command.
  registerPocketServing(app, config.pocketDir, pocketContentSecurityPolicy(origin));

  return {
    app,
    sessions,
    requireSession,
    hub,
    injectWebSocket,
    sweepRevokedBurrows,
    sweepRelaySockets,
  };
}

const CSP_HEADER = 'Content-Security-Policy';

/**
 * The Pocket origin's Content-Security-Policy
 * (`docs/specs/pocket-app.md` -> Deployment).
 *
 * This origin holds a per-Burrow Client static and the worker that opens sealed
 * pushes, and `docs/specs/security.md` -> "What is not defended" already names active XSS
 * here as the risk it cannot rule out — so it gets the defense in depth the
 * two shipped webview hosts already have.
 *
 * Every source is the app's own origin. The loosenings are load-bearing and no
 * wider than they must be:
 *
 * * `style-src 'unsafe-inline'` — the shell carries an inline `<style>` for
 *   viewport plumbing that has to apply before first paint, and React writes
 *   `style` attributes. A hash covers the first but not the second, and CSS is
 *   not where the risk this policy exists for lives.
 * * `connect-src` names the WebSocket origin explicitly rather than resting on
 *   `'self'`, whose ws/wss coverage browsers have disagreed about. It is the
 *   configured origin with the scheme swapped, so it can only ever be this
 *   deployment's own relay.
 * * `img-src` also admits `data:` and `blob:`, `media-src` `blob:` — images and
 *   media the page builds in memory rather than fetches.
 *
 * `script-src` needs no *script* exception: the build emits no inline script
 * and loads nothing off-origin, which `relay/test/static.test.mjs` pins
 * against the built output. Its one addition is `'wasm-unsafe-eval'`, which
 * `@xterm/addon-image` needs to compile the SIXEL decoder it vendors, at pane
 * creation. It permits WebAssembly compilation and nothing else — `eval` and
 * friends stay blocked, which `'unsafe-eval'` would not have done.
 */
export function pocketContentSecurityPolicy(origin: string): string {
  // `createApp` refuses anything but a bare `http(s)` origin, which is what
  // makes this slice exact rather than a guess.
  const wsOrigin = `ws${origin.slice('http'.length)}`;
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' blob:",
    `connect-src 'self' ${wsOrigin}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** Message shown at `GET /` when the Pocket app has not been built yet. */
const POCKET_MISSING_MESSAGE =
  'Dormouse selfhost Relay. The Pocket web app is not built yet — run ' +
  '`pnpm --filter dormouse-lib build:pocket` (or set DORMOUSE_POCKET_DIR).';

/**
 * Serve the built Pocket app from `pocketDir` at `/*`, falling back to
 * `index.html` for any non-file GET (the app is a single page). When the
 * directory or its `index.html` is absent, keep the old stub at `GET /`.
 */
function registerPocketServing(app: Hono<AppEnv>, pocketDir: string | undefined, csp: string): void {
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
    c.header(CSP_HEADER, csp);
    return serveFile(c, next);
  });
  // Re-read the SPA shell per deep-link fallback: a Pocket rebuild swaps in an
  // index.html referencing new content-hashed assets, and a cached copy would
  // keep pointing at deleted files until the Relay restarts. The fallback is
  // not a hot path, and a read failure degrades to a 404 instead of a crash.
  app.get('*', async (c) => {
    // This handler answers with the shell or with nothing, whatever was asked
    // for, so the class the static handler staged from the *request* path is
    // wrong here — a response's cache policy describes the response.
    c.header('Cache-Control', POCKET_SHELL_CACHE_CONTROL);
    c.header(CSP_HEADER, csp);
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

/** Read an `Authorization: Bearer <token>` header, or null if absent/malformed. */
function bearerToken(c: Context<AppEnv>): string | null {
  const match = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '');
  return match ? match[1]! : null;
}

/**
 * Base64url of exactly {@link DELIVERY_ID_LENGTH} characters — the Burrow mints
 * 32 random bytes, so anything else is not an id any Burrow ever issued and must
 * be refused before it becomes a row key.
 */
function isDeliveryId(value: unknown): value is string {
  return isExactBase64Url(value, DELIVERY_ID_LENGTH);
}

/**
 * One `{ deliveryId, sealed }` pair on a send. Shape and bounds are the whole
 * of what the Relay can check — it holds no key — and the envelope's bound is
 * its only defense against forwarding megabytes at a phone.
 */
function isSealedPushRecipient(value: unknown): value is SealedPushRecipient {
  if (!value || typeof value !== 'object') return false;
  const v = value as SealedPushRecipient;
  return isDeliveryId(v.deliveryId) && isSealedPushV1(v.sealed);
}

/**
 * Longest `keys.p256dh` / `keys.auth` this Relay will store. RFC 8291 fixes
 * both: `p256dh` is an uncompressed P-256 point (65 bytes) and `auth` is the
 * 16-byte auth secret, so the caps are their base64 encodings *with* padding —
 * browsers emit unpadded base64url, and a padded serialization must not be the
 * thing that breaks a real subscription.
 *
 * **Every stored field is bounded.** These two plus
 * {@link MAX_PUSH_ENDPOINT_LENGTH} are the whole row, and a durable row of
 * unknown size is re-read and re-parsed by every push route
 * (`docs/specs/relay.md` -> State files).
 */
const MAX_PUSH_KEY_P256DH_LENGTH = 88;
const MAX_PUSH_KEY_AUTH_LENGTH = 24;

/**
 * True if `value` is a `PushSubscriptionPayload` with both encryption keys,
 * each of a length RFC 8291 could actually have produced. Non-empty, because a
 * blank key is a row `web-push` can never encrypt to.
 */
function isSubscriptionPayload(value: unknown): value is PushSubscriptionPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as PushSubscriptionPayload;
  return (
    isBoundedNonEmptyString(v.endpoint, MAX_PUSH_ENDPOINT_LENGTH) &&
    !!v.keys &&
    typeof v.keys === 'object' &&
    isBoundedNonEmptyString(v.keys.p256dh, MAX_PUSH_KEY_P256DH_LENGTH) &&
    isBoundedNonEmptyString(v.keys.auth, MAX_PUSH_KEY_AUTH_LENGTH)
  );
}

function isBoundedNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
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
