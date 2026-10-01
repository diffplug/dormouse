// Rules: docs/specs/hosted.md -> "Relay"; shared semantics docs/specs/relay.md -> "HTTP API".
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { digest } from "@pgstencil/auth/security";
import {
  API_ROUTES,
  BODY_TOO_LARGE_ERROR,
  DEFAULT_CHALLENGE_TTL_MS,
  DUPLICATE_CREDENTIAL_ERROR,
  MALFORMED_ASSERTION_ERROR,
  MALFORMED_BINDING_ERROR,
  MAX_PENDING_REAUTH_NONCES_PER_SESSION,
  MAX_REQUEST_BODY_BYTES,
  MAX_TOKENS_PER_BURROW,
  RELAY_BEARER_BYTE_LENGTH,
  RELAY_SESSION_TTL_MS,
  REAUTH_NONCE_TTL_MS,
  SETUP_TOKEN_INVALID_ERROR,
  SETUP_TOKEN_TTL_MS,
  UNKNOWN_CREDENTIAL_ERROR,
  UNKNOWN_NONCE_ERROR,
  WRONG_CREDENTIAL_ERROR,
  assertionRejectedError,
  checkRegistration,
  isPresenceBinding,
  isRelayBearer,
  presenceChallenge,
  readJson,
  toBase64Url,
  verifyPasskeyAssertion,
  verifySigninAssertion,
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
import type { RelayEnv } from "./bindings";
import { allowed } from "./one-time";
import {
  NOT_ENTITLED_ERROR,
  OWNER_COLUMNS,
  database,
  ownerOf,
  requireBurrow,
  requireSession,
  unauthorized,
  type Client,
} from "./relay-auth";

/** Passkeys one account may hold; a full account is refused, never evicted (rationale). */
export const MAX_PASSKEYS_PER_ACCOUNT = 32;
/** Live sign-in sessions one account may hold, its own oldest evicted (rationale). */
export const MAX_SESSIONS_PER_ACCOUNT = 32;
/** One live registration challenge per live setup token of the same Burrow (rationale). */
export const MAX_SETUP_CHALLENGES_PER_BURROW = MAX_TOKENS_PER_BURROW;

/** A table a caller grows, capped per `owner` value. */
interface Capped {
  table: string;
  pk: string;
  owner: string;
  cap: number;
}

const SETUP_TOKENS: Capped = {
  table: "dormouse_relay_setup_tokens",
  pk: '"tokenHash"',
  owner: '"burrowId"',
  cap: MAX_TOKENS_PER_BURROW,
};
const SETUP_CHALLENGES: Capped = {
  table: "dormouse_relay_challenges",
  pk: "challenge",
  owner: '"burrowId"',
  cap: MAX_SETUP_CHALLENGES_PER_BURROW,
};
const SESSIONS: Capped = {
  table: "dormouse_relay_sessions",
  pk: '"tokenHash"',
  owner: '"userId"',
  cap: MAX_SESSIONS_PER_ACCOUNT,
};
const PRESENCE_NONCES: Capped = {
  table: "dormouse_relay_presence_nonces",
  pk: "nonce",
  owner: '"sessionTokenHash"',
  cap: MAX_PENDING_REAUTH_NONCES_PER_SESSION,
};

/** Every Relay table with an expiry, as the Cron Trigger sweeps them. */
const EXPIRING_TABLES = [
  PRESENCE_NONCES.table,
  SETUP_CHALLENGES.table,
  SETUP_TOKENS.table,
  SESSIONS.table,
  "dormouse_relay_enrollments",
];

const randomHandle = () =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(RELAY_BEARER_BYTE_LENGTH)));

/** A `timestamptz` column as epoch milliseconds. */
const epochMs = (column: string) =>
  `floor(extract(epoch from ${column}) * 1000)::float8`;

/** `now()` plus `$n` milliseconds. */
const after = (param: string) => `now() + (${param}::float8 * interval '1 millisecond')`;

/** 429 past `limit` per address, before anything reaches the database. */
const perAddress =
  (limit: (env: RelayEnv) => RateLimit, error: string): MiddlewareHandler<{ Bindings: RelayEnv }> =>
  async (c, next) => {
    if (await allowed(c, limit(c.env))) return next();
    c.header("Retry-After", "60");
    return c.json({ error }, 429);
  };

/**
 * The Hosted Relay's Pocket- and Burrow-facing routes, at the self-host
 * Relay's paths, shapes, statuses and error strings, over account-scoped
 * Postgres rows. They read no cookie and never ask auth; every query reading
 * a Burrow, passkey, nonce or token is scoped to the caller's account.
 * Register before the `/api/*` tail.
 */
export function relayApiRoutes(app: Hono<{ Bindings: RelayEnv }>) {
  // The unauthenticated routes that reach Postgres, ahead of the body limit
  // so an oversized request spends from the same budget.
  const signinLimit = perAddress((env) => env.RELAY_SIGNIN_LIMIT, "too many sign-in attempts");
  const setupLimit = perAddress((env) => env.RELAY_SETUP_LIMIT, "too many setup attempts");
  app.use(API_ROUTES.signinBegin, signinLimit);
  app.use(API_ROUTES.signinFinish, signinLimit);
  app.use(API_ROUTES.setupBegin, setupLimit);
  app.use(API_ROUTES.setupFinish, setupLimit);

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ error: BODY_TOO_LARGE_ERROR }, 413),
    }),
  );

  // --- Setup: a passkey joins the account that owns the minting Burrow ------

  app.post(API_ROUTES.setupBegin, async (c) => {
    const token = setupTokenOf(await readJson(c));
    if (!token) return invalidSetup(c);
    return database(c, async (db) => {
      const {
        rows: [minter],
      } = await db.query<{
        burrowId: string;
        userId: string;
        ownerEmail: unknown;
        ownerEmailVerified: unknown;
        credentialIds: string[];
      }>(
        `SELECT t."burrowId", b."userId", ${OWNER_COLUMNS},
          ARRAY(
            SELECT p."credentialId" FROM dormouse_relay_passkeys p
            WHERE p."userId" = b."userId" ORDER BY p."createdAt", p."credentialId"
          ) AS "credentialIds"
        FROM dormouse_relay_setup_tokens t
        JOIN dormouse_relay_burrows b ON b."burrowId" = t."burrowId" AND b."revokedAt" IS NULL
        JOIN "user" u ON u.id = b."userId"
        WHERE t."tokenHash" = $1 AND t."expiresAt" > now()`,
        [digest(token)],
      );
      if (!minter || !ownerOf(minter).entitled) return invalidSetup(c);
      const challenge = randomHandle();
      await admit(
        db,
        SETUP_CHALLENGES,
        minter.burrowId,
        { challenge, burrowId: minter.burrowId },
        DEFAULT_CHALLENGE_TTL_MS,
      );
      const res: SetupBeginResponse = {
        challenge,
        rpId: rpIdOf(c.env),
        accountId: minter.userId,
        existingCredentialIds: minter.credentialIds,
      };
      return c.json(res);
    });
  });

  app.post(API_ROUTES.setupFinish, async (c) => {
    const body = await readJson(c);
    const token = setupTokenOf(body);
    if (!token) return invalidSetup(c);
    return database(c, async (db) => {
      // Spent here, before any check below: of two finishes racing one token
      // only one can register. Every later failure puts it back.
      const spent = await consumeSetupToken(db, token);
      if (!spent) return invalidSetup(c);
      let registered = false;
      try {
        // Only a challenge this token's own Burrow began redeems here.
        const checked = await checkRegistration(body, {
          origin: c.env.APP_ORIGIN,
          redeem: (challenge) => consumeChallenge(db, challenge, spent.burrowId),
        });
        if (!checked.ok) return c.json({ error: checked.error }, checked.status);
        const { credentialId, publicKey, label } = checked;
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
            [credentialId, spent.userId, publicKey, label],
          );
          return inserted.rowCount ? "registered" : "duplicate";
        });
        if (outcome === "duplicate") return c.json({ error: DUPLICATE_CREDENTIAL_ERROR }, 409);
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
  app.post(API_ROUTES.setupRetire, requireSession, async (c) => {
    const token = setupTokenOf(await readJson(c));
    const spent = token && (await consumeSetupToken(c.var.db, token, c.var.session.userId));
    return spent ? c.body(null, 204) : invalidSetup(c);
  });

  // --- Sign-in: the account is whoever owns the asserted credential ---------

  app.post(API_ROUTES.signinBegin, (c) =>
    database(c, async (db) => {
      // Flat, unauthenticated, and bounded by the per-address limit and the
      // Cron Trigger's sweep (rationale).
      const challenge = randomHandle();
      await db.query(
        `INSERT INTO dormouse_relay_challenges (challenge, "expiresAt") VALUES ($1, ${after("$2")})`,
        [challenge, DEFAULT_CHALLENGE_TTL_MS],
      );
      const res: SigninBeginResponse = { challenge, rpId: rpIdOf(c.env) };
      return c.json(res);
    }),
  );

  app.post(API_ROUTES.signinFinish, (c) =>
    database(c, async (db) => {
      const body = await readJson<{ assertion?: unknown }>(c);
      const verdict = await verifySigninAssertion(body?.assertion, {
        findPasskey: async (credentialId) => {
          const {
            rows: [row],
          } = await db.query<{
            userId: string;
            publicKey: string;
            ownerEmail: unknown;
            ownerEmailVerified: unknown;
          }>(
            `SELECT p."userId", p."publicKey", ${OWNER_COLUMNS}
            FROM dormouse_relay_passkeys p JOIN "user" u ON u.id = p."userId"
            WHERE p."credentialId" = $1`,
            [credentialId],
          );
          return row && { ...ownerOf(row), publicKey: row.publicKey };
        },
        consumeChallenge: (challenge) => consumeChallenge(db, challenge, null),
        policy: { origin: c.env.APP_ORIGIN, rpId: rpIdOf(c.env) },
      });
      if (!verdict.ok) return c.json({ error: verdict.error }, verdict.status);
      const { userId, entitled, publicKey } = verdict.passkey;
      // A session is never minted for an account that is not entitled.
      if (!entitled) return c.json({ error: NOT_ENTITLED_ERROR }, 401);
      const sessionToken = randomHandle();
      const expiresAt = await admit(
        db,
        SESSIONS,
        userId,
        { tokenHash: digest(sessionToken), userId },
        RELAY_SESSION_TTL_MS,
      );
      const res: SigninFinishResponse = {
        sessionToken,
        accountId: userId,
        expiresAt: expiresAt!,
        passkeyPublicKey: publicKey,
      };
      return c.json(res);
    }),
  );

  // --- Re-auth: the presence proof for one ceremony, within one account ------

  app.post(API_ROUTES.reauthBegin, requireSession, async (c) => {
    const { db, session } = c.var;
    const binding: unknown = (await readJson<{ binding?: unknown }>(c))?.binding;
    if (!isPresenceBinding(binding)) return c.json({ error: MALFORMED_BINDING_ERROR }, 400);
    const { rowCount } = await db.query(
      `SELECT 1 FROM dormouse_relay_passkeys WHERE "credentialId" = $1 AND "userId" = $2`,
      [binding.passkeyCredentialId, session.userId],
    );
    if (!rowCount) return c.json({ error: UNKNOWN_CREDENTIAL_ERROR }, 404);
    const relayNonce = randomHandle();
    let challenge: string;
    try {
      challenge = await presenceChallenge(binding, relayNonce);
    } catch {
      return c.json({ error: MALFORMED_BINDING_ERROR }, 400);
    }
    await admit(
      db,
      PRESENCE_NONCES,
      session.tokenHash,
      { nonce: relayNonce, sessionTokenHash: session.tokenHash, userId: session.userId, binding },
      REAUTH_NONCE_TTL_MS,
    );
    const res: ReauthBeginResponse = {
      challenge,
      rpId: rpIdOf(c.env),
      relayNonce,
      allowCredentials: [binding.passkeyCredentialId],
    };
    return c.json(res);
  });

  app.post(API_ROUTES.reauthFinish, requireSession, async (c) => {
    const { db, session } = c.var;
    const body = await readJson<{ relayNonce?: unknown; assertion?: PasskeyAssertion }>(c);
    const relayNonce = body?.relayNonce;
    if (typeof relayNonce !== "string") return c.json({ error: UNKNOWN_NONCE_ERROR }, 400);
    // Consumed first, whatever the rest decides, in the statement that reads
    // the passkey its binding names; only the account's own.
    const {
      rows: [pending],
    } = await db.query<{ binding: PresenceBinding; live: boolean; publicKey: string | null }>(
      `WITH spent AS (
        DELETE FROM dormouse_relay_presence_nonces WHERE nonce = $1 AND "userId" = $2
        RETURNING binding, "expiresAt" > now() AS live
      )
      SELECT s.binding, s.live, p."publicKey" FROM spent s
      LEFT JOIN dormouse_relay_passkeys p
        ON p."credentialId" = s.binding->>'passkeyCredentialId' AND p."userId" = $2`,
      [relayNonce, session.userId],
    );
    if (!pending?.live || !isPresenceBinding(pending.binding))
      return c.json({ error: UNKNOWN_NONCE_ERROR }, 400);
    const assertion = body?.assertion;
    if (!assertion || typeof assertion.credentialId !== "string")
      return c.json({ error: MALFORMED_ASSERTION_ERROR }, 400);
    if (assertion.credentialId !== pending.binding.passkeyCredentialId)
      return c.json({ error: WRONG_CREDENTIAL_ERROR }, 401);
    if (pending.publicKey === null) return c.json({ error: UNKNOWN_CREDENTIAL_ERROR }, 404);
    // Recomputed from the stored binding, never from what the caller sent.
    const challenge = await presenceChallenge(pending.binding, relayNonce);
    const result = await verifyPasskeyAssertion(assertion, pending.publicKey, {
      challenge,
      origin: c.env.APP_ORIGIN,
      rpId: rpIdOf(c.env),
    });
    if (!result.ok) return c.json({ error: assertionRejectedError(result.reason) }, 401);
    // It extends nothing: no session lifetime, no relay socket.
    const res: ReauthFinishResponse = { verifiedAt: Date.now() };
    return c.json(res);
  });

  // --- Discovery and the Burrow's setup tokens ------------------------------

  app.get(API_ROUTES.burrows, requireSession, async (c) => {
    const { rows } = await c.var.db.query<{ burrowId: string }>(
      `SELECT "burrowId" FROM dormouse_relay_burrows
      WHERE "userId" = $1 AND "revokedAt" IS NULL ORDER BY "enrolledAt", "burrowId"`,
      [c.var.session.userId],
    );
    // No relay socket reaches this Worker yet, so none is connected.
    const res: BurrowsResponse = {
      burrows: rows.map(({ burrowId }) => ({ burrowId, online: false })),
    };
    return c.json(res);
  });

  app.post(API_ROUTES.burrowSetupToken, requireBurrow, async (c) => {
    const { burrowId } = c.var.burrow;
    const token = randomHandle();
    const expiresAt = await admit(
      c.var.db,
      SETUP_TOKENS,
      burrowId,
      { tokenHash: digest(token), burrowId },
      SETUP_TOKEN_TTL_MS,
    );
    const res: SetupTokenResponse = { token, expiresAt: expiresAt! };
    return c.json(res);
  });

  // Hosted has no setup password; enrollment is the account's device-code flow.
  app.post(API_ROUTES.burrowEnroll, (c) => unauthorized(c));

  // Push is off until the Durable Object Relay delivers it.
  app.get(API_ROUTES.pushConfig, (c) => {
    const res: PushConfigResponse = { applicationServerKey: null };
    return c.json(res);
  });
}

/** The relay Cron Trigger: every table's expired rows, whoever grew them. */
export async function sweepExpired(db: Client) {
  for (const table of EXPIRING_TABLES)
    await db.query(`DELETE FROM ${table} WHERE "expiresAt" <= now()`);
}

/** A spent setup token: what restoring it, and registering against it, needs. */
interface SpentSetupToken {
  burrowId: string;
  userId: string;
  expiresAt: Date;
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
    SpentSetupToken & {
      live: boolean;
      enrolled: boolean;
      ownerEmail: unknown;
      ownerEmailVerified: unknown;
    }
  >(
    `WITH spent AS (
      DELETE FROM dormouse_relay_setup_tokens t USING dormouse_relay_burrows b
      WHERE t."tokenHash" = $1 AND b."burrowId" = t."burrowId"
        AND ($2::text IS NULL OR b."userId" = $2)
      RETURNING t."burrowId", t."expiresAt", b."userId", b."revokedAt"
    )
    SELECT s."burrowId", s."expiresAt", s."userId", s."expiresAt" > now() AS live,
      s."revokedAt" IS NULL AS enrolled, ${OWNER_COLUMNS}
    FROM spent s JOIN "user" u ON u.id = s."userId"`,
    [digest(token), userId],
  );
  if (!spent?.live || !spent.enrolled || !ownerOf(spent).entitled) return null;
  return { burrowId: spent.burrowId, userId: spent.userId, expiresAt: spent.expiresAt };
}

/**
 * Puts a token `finish` spent back on its original expiry, so a retry never
 * buys time, within its Burrow's cap: a mint may have filled the slot. A token
 * already dead is never restored, so it never evicts a live one.
 */
export async function restoreSetupToken(db: Client, token: string, spent: SpentSetupToken) {
  if (spent.expiresAt.getTime() <= Date.now()) return;
  await admit(
    db,
    SETUP_TOKENS,
    spent.burrowId,
    { tokenHash: digest(token), burrowId: spent.burrowId },
    spent.expiresAt,
  );
}

/** Spends a challenge in one statement; true only if it was live. A sign-in challenge names no Burrow. */
async function consumeChallenge(db: Client, challenge: string, burrowId: string | null) {
  const {
    rows: [row],
  } = await db.query<{ live: boolean }>(
    `DELETE FROM dormouse_relay_challenges
    WHERE challenge = $1 AND "burrowId" IS NOT DISTINCT FROM $2
    RETURNING "expiresAt" > now() AS live`,
    [challenge, burrowId],
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

/**
 * Inserts `row` into `spec`'s table for `owner`, under that owner's lock and
 * in one statement: its own expired rows pruned, its live rows trimmed to
 * leave one slot under the cap (latest expiry kept), then the row. No other
 * owner's rows are read. `expiry` is a TTL in milliseconds or an instant; a
 * row already expired is not inserted. Answers its expiry in epoch
 * milliseconds, or undefined when nothing was inserted.
 */
async function admit(
  db: Client,
  { table, pk, owner, cap }: Capped,
  ownerValue: string,
  row: Record<string, unknown>,
  expiry: number | Date,
): Promise<number | undefined> {
  const columns = Object.keys(row);
  const values = Object.values(row);
  const expiryParam = `$${columns.length + 3}`;
  const expiresAt =
    typeof expiry === "number" ? after(expiryParam) : `${expiryParam}::timestamptz`;
  return locked(db, `${table}:${ownerValue}`, async () => {
    const { rows } = await db.query<{ expiresAt: number }>(
      `WITH pruned AS (
        DELETE FROM ${table} WHERE ${owner} = $1 AND "expiresAt" <= now()
      ), trimmed AS (
        DELETE FROM ${table} WHERE ${pk} IN (
          SELECT ${pk} FROM ${table} WHERE ${owner} = $1 AND "expiresAt" > now()
          ORDER BY "expiresAt" DESC, ${pk} OFFSET $2
        )
      )
      INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(", ")}, "expiresAt")
      SELECT ${columns.map((_, i) => `$${i + 3}`).join(", ")}, ${expiresAt}
      WHERE ${expiresAt} > now()
      ON CONFLICT (${pk}) DO NOTHING
      RETURNING ${epochMs('"expiresAt"')} AS "expiresAt"`,
      [ownerValue, cap - 1, ...values, expiry],
    );
    return rows[0]?.expiresAt;
  });
}

/** A setup token of the minted shape from a request body, or null. */
function setupTokenOf(body: unknown): string | null {
  const token = (body as { setupToken?: unknown } | null)?.setupToken;
  return isRelayBearer(token) ? token : null;
}

const rpIdOf = (env: RelayEnv) => new URL(env.APP_ORIGIN).hostname;
const invalidSetup = (c: Context) => c.json({ error: SETUP_TOKEN_INVALID_ERROR }, 401);
