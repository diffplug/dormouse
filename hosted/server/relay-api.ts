// Rules: docs/specs/hosted.md -> "Relay"; shared semantics docs/specs/relay.md -> "HTTP API".
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { digest } from "@pgstencil/auth/security";
import { withClient } from "pgstencil/postgres";
import {
  API_ROUTES,
  CEREMONY_FIELD_LIMIT,
  DEFAULT_CHALLENGE_TTL_MS,
  MAX_PENDING_REAUTH_NONCES_PER_SESSION,
  MAX_REQUEST_BODY_BYTES,
  MAX_TOKENS_PER_BURROW,
  RELAY_SESSION_TTL_MS,
  REAUTH_NONCE_TTL_MS,
  SETUP_TOKEN_INVALID_ERROR,
  SETUP_TOKEN_TTL_MS,
  UNAUTHORIZED_ERROR,
  base64UrlLength,
  decodeClientData,
  importableSpkiP256,
  isBoundedBase64Url,
  isExactBase64Url,
  isPresenceBinding,
  normalizeChallenge,
  presenceChallenge,
  reducePasskeyLabel,
  toBase64Url,
  verifyPasskeyAssertion,
} from "remote-lib-common";
import type {
  BurrowsResponse,
  PasskeyAssertion,
  PresenceBinding,
  PushConfigResponse,
  ReauthBeginResponse,
  ReauthFinishResponse,
  SetupBeginResponse,
  SetupFinishResponse,
  SetupTokenResponse,
  SigninBeginResponse,
  SigninFinishResponse,
} from "remote-lib-common";
import { isAdmin } from "./admin";
import type { RelayEnv } from "./bindings";
import { rateLimitKey } from "./one-time";

type RelayContext = Context<{ Bindings: RelayEnv }>;
/** The slice of a `pg` client these routes use; `pg` ships no types here. */
interface Client {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/**
 * Passkeys one account may hold. Registration is gated by a setup token the
 * account's own Burrow minted, so only the account grows its own rows; a
 * person registers one per phone or browser profile that does not sync, and
 * every `setup/begin` returns the whole list as `excludeCredentials`. A full
 * account is refused rather than evicted: dropping a passkey would silently
 * sign a device out.
 */
export const MAX_PASSKEYS_PER_ACCOUNT = 32;
/**
 * Live sign-in sessions one account may hold, its own oldest evicted first.
 * Each costs a passkey assertion, so only the account's own passkey holders
 * can spend it; far above the browsers a person signs in from in 12 hours.
 */
export const MAX_SESSIONS_PER_ACCOUNT = 32;
/** One live registration challenge per live setup token of the same Burrow. */
export const MAX_SETUP_CHALLENGES_PER_BURROW = MAX_TOKENS_PER_BURROW;

/** The 403 a Burrow-authenticated request gets once its owner is not entitled. */
export const NOT_ENTITLED_ERROR = "this account is not entitled to the Hosted Relay";

/** Every bearer this Relay mints — session, Burrow, setup token — is 32 random bytes, base64url. */
const BEARER_LENGTH = base64UrlLength(32);

const randomHandle = () =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

/** A `timestamptz` column as epoch milliseconds. */
const epochMs = (column: string) =>
  `floor(extract(epoch from ${column}) * 1000)::float8`;

/** `now()` plus `$n` milliseconds. */
const after = (param: string) => `now() + (${param}::float8 * interval '1 millisecond')`;

/**
 * The Hosted Relay's Pocket- and Burrow-facing routes, at the self-host
 * Relay's paths, shapes, statuses and error strings, over account-scoped
 * Postgres rows. They read no cookie and never ask auth; every query reading
 * a Burrow, passkey, nonce or token is scoped to the caller's account.
 * Register before any `/api/*` catch-all.
 */
export function relayApiRoutes(app: Hono<{ Bindings: RelayEnv }>) {
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ error: "request body too large" }, 413),
    }),
  );

  app.get("/api/hello", (c) => c.json({ message: "Hello, world!" }));

  // --- Setup: a passkey joins the account that owns the minting Burrow ------

  app.post(API_ROUTES.setupBegin, async (c) => {
    const token = setupTokenOf(await readJson(c));
    if (!token) return invalidSetup(c);
    return database(c, async (db) => {
      const {
        rows: [minter],
      } = await db.query<Owner & { burrowId: string }>(
        `SELECT t."burrowId", b."userId", u.email, u."emailVerified"
        FROM dormouse_relay_setup_tokens t
        JOIN dormouse_relay_burrows b ON b."burrowId" = t."burrowId" AND b."revokedAt" IS NULL
        JOIN "user" u ON u.id = b."userId"
        WHERE t."tokenHash" = $1 AND t."expiresAt" > now()`,
        [digest(token)],
      );
      if (!minter || !isAdmin(minter)) return invalidSetup(c);
      const challenge = randomHandle();
      await locked(db, `setup-challenges:${minter.burrowId}`, async () => {
        await pruneExpired(db, "dormouse_relay_challenges");
        await keepNewest(
          db,
          "dormouse_relay_challenges",
          "challenge",
          '"burrowId"',
          minter.burrowId,
          MAX_SETUP_CHALLENGES_PER_BURROW - 1,
        );
        await db.query(
          `INSERT INTO dormouse_relay_challenges (challenge, kind, "burrowId", "expiresAt")
          VALUES ($1, 'setup', $2, ${after("$3")})`,
          [challenge, minter.burrowId, DEFAULT_CHALLENGE_TTL_MS],
        );
      });
      const { rows } = await db.query<{ credentialId: string }>(
        `SELECT "credentialId" FROM dormouse_relay_passkeys
        WHERE "userId" = $1 ORDER BY "createdAt", "credentialId"`,
        [minter.userId],
      );
      const res: SetupBeginResponse = {
        challenge,
        rpId: rpIdOf(c),
        accountId: minter.userId,
        existingCredentialIds: rows.map((row) => row.credentialId),
      };
      return c.json(res);
    });
  });

  app.post(API_ROUTES.setupFinish, async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    const token = setupTokenOf(body);
    if (!token) return invalidSetup(c);
    return database(c, async (db) => {
      // Spent here, before any check below: of two finishes racing one token
      // only one can register. Every later failure puts it back.
      const spent = await consumeSetupToken(db, token);
      if (!spent) return invalidSetup(c);
      let registered = false;
      try {
        const clientData = decodeClientData(body?.clientDataJSON);
        if (!clientData) return c.json({ error: "malformed clientDataJSON" }, 400);
        if (clientData.type !== "webauthn.create")
          return c.json({ error: "clientData type must be webauthn.create" }, 400);
        const challenge = normalizeChallenge(clientData.challenge);
        // Only a challenge this token's own Burrow began redeems here.
        const redeemed =
          challenge !== null &&
          (await consumeChallenge(db, challenge, "setup", spent.burrowId));
        if (!redeemed)
          return c.json({ error: "unrecognized or expired challenge" }, 400);
        if (clientData.origin !== c.env.APP_ORIGIN)
          return c.json({ error: "origin mismatch" }, 400);
        if (!(await importableSpkiP256(body?.publicKey)))
          return c.json({ error: "unimportable public key" }, 400);
        const credentialId = body?.credentialId;
        if (!isBoundedBase64Url(credentialId, CEREMONY_FIELD_LIMIT))
          return c.json({ error: "malformed credentialId" }, 400);
        const outcome = await locked(db, `passkeys:${spent.userId}`, async () => {
          const {
            rows: [{ count }],
          } = await db.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM dormouse_relay_passkeys WHERE "userId" = $1`,
            [spent.userId],
          );
          if (count >= MAX_PASSKEYS_PER_ACCOUNT) return "full";
          const inserted = await db.query(
            `INSERT INTO dormouse_relay_passkeys ("credentialId", "userId", "publicKey", label)
            VALUES ($1, $2, $3, $4) ON CONFLICT ("credentialId") DO NOTHING`,
            [credentialId, spent.userId, body?.publicKey, reducePasskeyLabel(body?.label)],
          );
          return inserted.rowCount ? "registered" : "duplicate";
        });
        if (outcome === "duplicate")
          return c.json({ error: "credential already registered" }, 409);
        if (outcome === "full")
          return c.json(
            { error: `this account already has ${MAX_PASSKEYS_PER_ACCOUNT} passkeys` },
            409,
          );
        registered = true;
        const res: SetupFinishResponse = { accountId: spent.userId, credentialId };
        return c.json(res);
      } finally {
        if (!registered) await restoreSetupToken(db, token, spent);
      }
    });
  });

  // A signed-in phone spends a scanned code it will not register with. Only a
  // code one of the session's own Burrows minted can be spent.
  app.post(API_ROUTES.setupRetire, (c) =>
    withSession(c, async (db, session) => {
      const token = setupTokenOf(await readJson(c));
      const spent = token && (await consumeSetupToken(db, token, session.userId));
      return spent ? c.body(null, 204) : invalidSetup(c);
    }),
  );

  // --- Sign-in: the account is whoever owns the asserted credential ---------

  app.post(API_ROUTES.signinBegin, async (c) => {
    // The one table an unauthenticated caller grows.
    const { success } = await c.env.RELAY_SIGNIN_LIMIT.limit({
      key: rateLimitKey(c.req.header("cf-connecting-ip") ?? null),
    });
    if (!success) {
      c.header("Retry-After", "60");
      return c.json({ error: "too many sign-in attempts" }, 429);
    }
    return database(c, async (db) => {
      const challenge = randomHandle();
      await pruneExpired(db, "dormouse_relay_challenges");
      await db.query(
        `INSERT INTO dormouse_relay_challenges (challenge, kind, "expiresAt")
        VALUES ($1, 'signin', ${after("$2")})`,
        [challenge, DEFAULT_CHALLENGE_TTL_MS],
      );
      const res: SigninBeginResponse = { challenge, rpId: rpIdOf(c) };
      return c.json(res);
    });
  });

  app.post(API_ROUTES.signinFinish, (c) =>
    database(c, async (db) => {
      const body = await readJson<{ assertion?: PasskeyAssertion }>(c);
      const assertion = body?.assertion;
      if (!assertion || typeof assertion.credentialId !== "string")
        return c.json({ error: "malformed assertion" }, 400);
      const {
        rows: [stored],
      } = await db.query<{ userId: string; publicKey: string }>(
        `SELECT "userId", "publicKey" FROM dormouse_relay_passkeys WHERE "credentialId" = $1`,
        [assertion.credentialId],
      );
      if (!stored) return c.json({ error: "unknown credential" }, 404);
      const clientData = decodeClientData(assertion.clientDataJSON);
      const challenge =
        clientData && typeof clientData.challenge === "string"
          ? normalizeChallenge(clientData.challenge)
          : null;
      if (!challenge) return c.json({ error: "malformed clientDataJSON" }, 400);
      // Consumed before verifying, so a captured assertion never replays.
      if (!(await consumeChallenge(db, challenge, "signin")))
        return c.json({ error: "unrecognized or expired challenge" }, 400);
      const result = await verifyPasskeyAssertion(assertion, stored.publicKey, {
        challenge,
        origin: c.env.APP_ORIGIN,
        rpId: rpIdOf(c),
      });
      if (!result.ok)
        return c.json({ error: `assertion rejected: ${result.reason}` }, 401);
      const sessionToken = randomHandle();
      const expiresAt = await locked(db, `sessions:${stored.userId}`, async () => {
        await pruneExpired(db, "dormouse_relay_sessions");
        await keepNewest(
          db,
          "dormouse_relay_sessions",
          '"tokenHash"',
          '"userId"',
          stored.userId,
          MAX_SESSIONS_PER_ACCOUNT - 1,
        );
        const {
          rows: [row],
        } = await db.query<{ expiresAt: number }>(
          `INSERT INTO dormouse_relay_sessions ("tokenHash", "userId", "expiresAt")
          VALUES ($1, $2, ${after("$3")}) RETURNING ${epochMs('"expiresAt"')} AS "expiresAt"`,
          [digest(sessionToken), stored.userId, RELAY_SESSION_TTL_MS],
        );
        return row.expiresAt;
      });
      const res: SigninFinishResponse = {
        sessionToken,
        accountId: stored.userId,
        expiresAt,
        passkeyPublicKey: stored.publicKey,
      };
      return c.json(res);
    }),
  );

  // --- Re-auth: the presence proof for one ceremony, within one account ------

  app.post(API_ROUTES.reauthBegin, (c) =>
    withSession(c, async (db, session) => {
      const binding: unknown = (await readJson<{ binding?: unknown }>(c))?.binding;
      if (!isPresenceBinding(binding))
        return c.json({ error: "malformed presence binding" }, 400);
      const { rowCount } = await db.query(
        `SELECT 1 FROM dormouse_relay_passkeys WHERE "credentialId" = $1 AND "userId" = $2`,
        [binding.passkeyCredentialId, session.userId],
      );
      if (!rowCount) return c.json({ error: "unknown credential" }, 404);
      const relayNonce = randomHandle();
      let challenge: string;
      try {
        challenge = await presenceChallenge(binding, relayNonce);
      } catch {
        return c.json({ error: "malformed presence binding" }, 400);
      }
      await locked(db, `nonces:${session.tokenHash}`, async () => {
        await pruneExpired(db, "dormouse_relay_presence_nonces");
        await keepNewest(
          db,
          "dormouse_relay_presence_nonces",
          "nonce",
          '"sessionTokenHash"',
          session.tokenHash,
          MAX_PENDING_REAUTH_NONCES_PER_SESSION - 1,
        );
        await db.query(
          `INSERT INTO dormouse_relay_presence_nonces
            (nonce, "sessionTokenHash", "userId", binding, "expiresAt")
          VALUES ($1, $2, $3, $4, ${after("$5")})`,
          [relayNonce, session.tokenHash, session.userId, binding, REAUTH_NONCE_TTL_MS],
        );
      });
      const res: ReauthBeginResponse = {
        challenge,
        rpId: rpIdOf(c),
        relayNonce,
        allowCredentials: [binding.passkeyCredentialId],
      };
      return c.json(res);
    }),
  );

  app.post(API_ROUTES.reauthFinish, (c) =>
    withSession(c, async (db, session) => {
      const body = await readJson<{ relayNonce?: unknown; assertion?: PasskeyAssertion }>(c);
      const relayNonce = body?.relayNonce;
      if (typeof relayNonce !== "string")
        return c.json({ error: "unrecognized or expired nonce" }, 400);
      // Consumed first, whatever the rest decides; only the account's own.
      const {
        rows: [pending],
      } = await db.query<{ binding: PresenceBinding; live: boolean }>(
        `DELETE FROM dormouse_relay_presence_nonces WHERE nonce = $1 AND "userId" = $2
        RETURNING binding, "expiresAt" > now() AS live`,
        [relayNonce, session.userId],
      );
      if (!pending?.live || !isPresenceBinding(pending.binding))
        return c.json({ error: "unrecognized or expired nonce" }, 400);
      const assertion = body?.assertion;
      if (!assertion || typeof assertion.credentialId !== "string")
        return c.json({ error: "malformed assertion" }, 400);
      if (assertion.credentialId !== pending.binding.passkeyCredentialId)
        return c.json({ error: "assertion is for a different credential" }, 401);
      const {
        rows: [stored],
      } = await db.query<{ publicKey: string }>(
        `SELECT "publicKey" FROM dormouse_relay_passkeys WHERE "credentialId" = $1 AND "userId" = $2`,
        [pending.binding.passkeyCredentialId, session.userId],
      );
      if (!stored) return c.json({ error: "unknown credential" }, 404);
      // Recomputed from the stored binding, never from what the caller sent.
      const challenge = await presenceChallenge(pending.binding, relayNonce);
      const result = await verifyPasskeyAssertion(assertion, stored.publicKey, {
        challenge,
        origin: c.env.APP_ORIGIN,
        rpId: rpIdOf(c),
      });
      if (!result.ok)
        return c.json({ error: `assertion rejected: ${result.reason}` }, 401);
      // It extends nothing: no session lifetime, no relay socket.
      const res: ReauthFinishResponse = { verifiedAt: Date.now() };
      return c.json(res);
    }),
  );

  // --- Discovery and the Burrow's setup tokens ------------------------------

  app.get(API_ROUTES.burrows, (c) =>
    withSession(c, async (db, session) => {
      const { rows } = await db.query<{ burrowId: string }>(
        `SELECT "burrowId" FROM dormouse_relay_burrows
        WHERE "userId" = $1 AND "revokedAt" IS NULL ORDER BY "enrolledAt", "burrowId"`,
        [session.userId],
      );
      // No relay socket reaches this Worker yet, so none is connected.
      const res: BurrowsResponse = {
        burrows: rows.map(({ burrowId }) => ({ burrowId, online: false })),
      };
      return c.json(res);
    }),
  );

  app.post(API_ROUTES.burrowSetupToken, async (c) => {
    const token = bearerOf(c);
    if (!token) return unauthorized(c);
    return database(c, async (db) => {
      const {
        rows: [burrow],
      } = await db.query<Owner & { burrowId: string }>(
        `SELECT b."burrowId", b."userId", u.email, u."emailVerified"
        FROM dormouse_relay_burrows b JOIN "user" u ON u.id = b."userId"
        WHERE b."tokenHash" = $1 AND b."revokedAt" IS NULL`,
        [digest(token)],
      );
      if (!burrow) return unauthorized(c);
      // Rechecked on every Burrow request, as managed voice rechecks per speak.
      if (!isAdmin(burrow)) return c.json({ error: NOT_ENTITLED_ERROR }, 403);
      const setupToken = randomHandle();
      const expiresAt = await locked(db, `setup-tokens:${burrow.burrowId}`, async () => {
        await pruneExpired(db, "dormouse_relay_setup_tokens");
        await keepNewest(
          db,
          "dormouse_relay_setup_tokens",
          '"tokenHash"',
          '"burrowId"',
          burrow.burrowId,
          MAX_TOKENS_PER_BURROW - 1,
        );
        const {
          rows: [row],
        } = await db.query<{ expiresAt: number }>(
          `INSERT INTO dormouse_relay_setup_tokens ("tokenHash", "burrowId", "expiresAt")
          VALUES ($1, $2, ${after("$3")}) RETURNING ${epochMs('"expiresAt"')} AS "expiresAt"`,
          [digest(setupToken), burrow.burrowId, SETUP_TOKEN_TTL_MS],
        );
        return row.expiresAt;
      });
      const res: SetupTokenResponse = { token: setupToken, expiresAt };
      return c.json(res);
    });
  });

  // Hosted has no setup password; enrollment is the account's device-code flow.
  app.post(API_ROUTES.burrowEnroll, (c) => unauthorized(c));

  // Push is off until the Durable Object Relay delivers it.
  app.get(API_ROUTES.pushConfig, (c) => {
    const res: PushConfigResponse = { applicationServerKey: null };
    return c.json(res);
  });

  // No relay socket is served yet; never Pocket's shell either.
  app.all("/ws/*", (c) => c.json({ message: "Not found." }, 404));
}

/** The user row behind a Burrow, as the entitlement check reads it. */
interface Owner {
  userId: string;
  email: unknown;
  emailVerified: unknown;
}

/** A spent setup token: what restoring it, and registering against it, needs. */
interface SpentSetupToken {
  burrowId: string;
  userId: string;
  expiresAt: Date;
}

/** One connection per request, released before the response. */
function database(
  c: RelayContext,
  action: (db: Client) => Promise<Response>,
): Promise<Response> {
  return withClient(c.env.HYPERDRIVE.connectionString, (db) => action(db));
}

/** A session-gated route: the bearer's live session, or the shared 401. */
async function withSession(
  c: RelayContext,
  action: (db: Client, session: { userId: string; tokenHash: string }) => Promise<Response>,
): Promise<Response> {
  const token = bearerOf(c);
  if (!token) return unauthorized(c);
  return database(c, async (db) => {
    const tokenHash = digest(token);
    const {
      rows: [session],
    } = await db.query<{ userId: string }>(
      `SELECT "userId" FROM dormouse_relay_sessions WHERE "tokenHash" = $1 AND "expiresAt" > now()`,
      [tokenHash],
    );
    if (!session) return unauthorized(c);
    return action(db, { userId: session.userId, tokenHash });
  });
}

/**
 * Spends `token` in one statement, so of two racing redeemers only one wins,
 * and answers it only while live, its Burrow enrolled, and its owner entitled
 * — and, given `userId`, only a token one of that account's Burrows minted. A
 * token of another account is never touched.
 */
async function consumeSetupToken(
  db: Client,
  token: string,
  userId: string | null = null,
): Promise<SpentSetupToken | null> {
  const {
    rows: [spent],
  } = await db.query<
    SpentSetupToken & { live: boolean; enrolled: boolean; email: unknown; emailVerified: unknown }
  >(
    `WITH spent AS (
      DELETE FROM dormouse_relay_setup_tokens t USING dormouse_relay_burrows b
      WHERE t."tokenHash" = $1 AND b."burrowId" = t."burrowId"
        AND ($2::text IS NULL OR b."userId" = $2)
      RETURNING t."burrowId", t."expiresAt", b."userId", b."revokedAt"
    )
    SELECT s."burrowId", s."expiresAt", s."userId", s."expiresAt" > now() AS live,
      s."revokedAt" IS NULL AS enrolled, u.email, u."emailVerified"
    FROM spent s JOIN "user" u ON u.id = s."userId"`,
    [digest(token), userId],
  );
  if (!spent?.live || !spent.enrolled || !isAdmin(spent)) return null;
  return { burrowId: spent.burrowId, userId: spent.userId, expiresAt: spent.expiresAt };
}

/**
 * Puts a token `finish` spent back on its original expiry, so a retry never
 * buys time, within its Burrow's cap: a mint may have filled the slot.
 */
async function restoreSetupToken(db: Client, token: string, spent: SpentSetupToken) {
  await locked(db, `setup-tokens:${spent.burrowId}`, async () => {
    await pruneExpired(db, "dormouse_relay_setup_tokens");
    await keepNewest(
      db,
      "dormouse_relay_setup_tokens",
      '"tokenHash"',
      '"burrowId"',
      spent.burrowId,
      MAX_TOKENS_PER_BURROW - 1,
    );
    await db.query(
      `INSERT INTO dormouse_relay_setup_tokens ("tokenHash", "burrowId", "expiresAt")
      SELECT $1, $2, $3 WHERE $3::timestamptz > now()
      ON CONFLICT ("tokenHash") DO NOTHING`,
      [digest(token), spent.burrowId, spent.expiresAt],
    );
  });
}

/** Spends a challenge of `kind` in one statement; true only if it was live. */
async function consumeChallenge(
  db: Client,
  challenge: string,
  kind: "setup" | "signin",
  burrowId: string | null = null,
) {
  const {
    rows: [row],
  } = await db.query<{ live: boolean }>(
    `DELETE FROM dormouse_relay_challenges
    WHERE challenge = $1 AND kind = $2 AND "burrowId" IS NOT DISTINCT FROM $3
    RETURNING "expiresAt" > now() AS live`,
    [challenge, kind, burrowId],
  );
  return row?.live === true;
}

/** Runs `action` in a transaction holding `key`'s advisory lock, so a cap check and its insert cannot interleave. */
async function locked<T>(db: Client, key: string, action: () => Promise<T>) {
  await db.query("BEGIN");
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `dormouse-relay:${key}`,
    ]);
    const result = await action();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

const pruneExpired = (db: Client, table: string) =>
  db.query(`DELETE FROM ${table} WHERE "expiresAt" <= now()`);

/** Deletes all but the `keep` latest-expiring rows `column` = `key` holds. */
const keepNewest = (
  db: Client,
  table: string,
  key: string,
  column: string,
  value: string,
  keep: number,
) =>
  db.query(
    `DELETE FROM ${table} WHERE ${key} IN (
      SELECT ${key} FROM ${table} WHERE ${column} = $1
      ORDER BY "expiresAt" DESC, ${key} OFFSET $2
    )`,
    [value, keep],
  );

/** A setup token of the minted shape from a request body, or null. */
function setupTokenOf(body: unknown): string | null {
  const token = (body as { setupToken?: unknown } | null)?.setupToken;
  return isExactBase64Url(token, BEARER_LENGTH) ? token : null;
}

/** An `Authorization: Bearer` value of the minted shape, or null before any database read. */
function bearerOf(c: RelayContext): string | null {
  const match = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
  return match && isExactBase64Url(match[1], BEARER_LENGTH) ? match[1] : null;
}

async function readJson<T = unknown>(c: RelayContext): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

const rpIdOf = (c: RelayContext) => new URL(c.env.APP_ORIGIN).hostname;
const unauthorized = (c: RelayContext) => c.json({ error: UNAUTHORIZED_ERROR }, 401);
const invalidSetup = (c: RelayContext) =>
  c.json({ error: SETUP_TOKEN_INVALID_ERROR }, 401);
