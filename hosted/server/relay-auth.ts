// Rules: docs/specs/hosted.md -> "Relay".
import type { Context, MiddlewareHandler } from "hono";
import { digest } from "@pgstencil/auth/security";
import { withClient } from "pgstencil/postgres";
import {
  NOT_ENTITLED_ERROR,
  UNAUTHORIZED_ERROR,
  isRelayBearer,
  parseBearer,
} from "remote-lib-common";
import { isAdmin } from "./admin";
import type { RelayEnv } from "./bindings";

/** The slice of a `pg` client the Relay uses; `pg` ships no types here. */
export interface Client {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/** The account a bearer acts for, and whether that account is entitled now. */
export interface Owner {
  userId: string;
  entitled: boolean;
}

/** A live sign-in session, by its token's hash. */
export interface RelaySession extends Owner {
  tokenHash: string;
  /** When it expires, epoch milliseconds: a relay socket it opens closes then. */
  expiresAt: number;
}

/** An enrolled Burrow. */
export interface RelayBurrow extends Owner {
  burrowId: string;
}

/**
 * The owner columns every lookup selects from `"user" u`, and the one
 * entitlement predicate over them: `isAdmin`, until billing exists.
 */
export const OWNER_COLUMNS = `u.email AS "ownerEmail", u."emailVerified" AS "ownerEmailVerified"`;

/** A row selecting {@link OWNER_COLUMNS} beside its `userId`. */
export type OwnerRow = { userId: string; ownerEmail: unknown; ownerEmailVerified: unknown };

/** A row carrying {@link OWNER_COLUMNS} as the {@link Owner} it names. */
export function ownerOf(row: OwnerRow): Owner {
  return {
    userId: row.userId,
    entitled: isAdmin({ email: row.ownerEmail, emailVerified: row.ownerEmailVerified }),
  };
}

/** The live session `token` names, its owner joined in the same query, or null. */
export async function sessionByToken(db: Client, token: string): Promise<RelaySession | null> {
  const tokenHash = digest(token);
  const {
    rows: [row],
  } = await db.query<OwnerRow & { expiresAt: number }>(
    `SELECT s."userId", ${OWNER_COLUMNS},
      floor(extract(epoch from s."expiresAt") * 1000)::float8 AS "expiresAt"
    FROM dormouse_relay_sessions s JOIN "user" u ON u.id = s."userId"
    WHERE s."tokenHash" = $1 AND s."expiresAt" > now()`,
    [tokenHash],
  );
  return row ? { ...ownerOf(row), tokenHash, expiresAt: row.expiresAt } : null;
}

/** The Burrow `token` names, its owner joined in the same query, or null. */
export async function burrowByToken(db: Client, token: string): Promise<RelayBurrow | null> {
  const {
    rows: [row],
  } = await db.query<OwnerRow & { burrowId: string }>(
    `SELECT b."burrowId", b."userId", ${OWNER_COLUMNS}
    FROM dormouse_relay_burrows b JOIN "user" u ON u.id = b."userId"
    WHERE b."tokenHash" = $1`,
    [digest(token)],
  );
  return row ? { ...ownerOf(row), burrowId: row.burrowId } : null;
}

/**
 * Those of `burrowIds` still enrolled, each with its owner, in one query: what
 * a `RelayRoom` rechecks before it accepts a Burrow socket and on its sweep.
 */
export async function burrowsById(db: Client, burrowIds: string[]): Promise<RelayBurrow[]> {
  const { rows } = await db.query<OwnerRow & { burrowId: string }>(
    `SELECT b."burrowId", b."userId", ${OWNER_COLUMNS}
    FROM dormouse_relay_burrows b JOIN "user" u ON u.id = b."userId"
    WHERE b."burrowId" = ANY($1::text[])`,
    [burrowIds],
  );
  return rows.map((row) => ({ ...ownerOf(row), burrowId: row.burrowId }));
}

/** A route's bindings plus what its credential gate resolved. */
export type RelayHonoEnv<Var extends object = object> = {
  Bindings: RelayEnv;
  Variables: { db: Client } & Var;
};

/** One connection, released once `action` settles. */
export function database<T>(
  c: { env: Pick<RelayEnv, "HYPERDRIVE"> },
  action: (db: Client) => Promise<T>,
): Promise<T> {
  return withClient(c.env.HYPERDRIVE.connectionString, action);
}

/**
 * "Now" for a liveness check inside `locked`'s action: the statement's start,
 * after the lock wait. Not `now()`, the transaction's start before that wait,
 * so a row that expired while its writer waited would still read as live.
 */
export const LOCKED_NOW = "statement_timestamp()";

/** Runs `action` in a transaction holding `key`'s advisory lock, so a cap check and its insert cannot interleave. */
export async function locked<T>(db: Client, key: string, action: () => Promise<T>) {
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

export const unauthorized = (c: Context) => c.json({ error: UNAUTHORIZED_ERROR }, 401);

/** How a credential gate finds its bearer's row and decides whether to admit it. */
interface Gate<Found> {
  lookup(db: Client, token: string): Promise<Found | null>;
  admit(c: Context, found: Found): Response | null;
}

/**
 * Runs `action` on a connection once `gate` admits the request's bearer: a
 * bearer of the minted shape (refused before any database read), resolved on
 * that connection, and admitted or answered with the gate's response.
 */
async function gated<Found, T>(
  c: Context,
  { lookup, admit }: Gate<Found>,
  action: (db: Client, found: Found) => Promise<T>,
): Promise<T | Response> {
  const token = parseBearer(c.req.header("authorization"));
  if (!isRelayBearer(token)) return unauthorized(c);
  return database(c, async (db) => {
    const found = await lookup(db, token);
    if (!found) return unauthorized(c);
    return admit(c, found) ?? action(db, found);
  });
}

/** A credential gate as Hono middleware, the request's connection held through the route. */
function bearerGate<Name extends string, Found>(
  name: Name,
  gate: Gate<Found>,
): MiddlewareHandler<RelayHonoEnv<Record<Name, Found>>> {
  return (c, next) =>
    gated(c, gate, async (db, found) => {
      const vars = c as unknown as Context<{ Variables: Record<string, unknown> }>;
      vars.set("db", db);
      vars.set(name, found);
      await next();
      return c.res;
    });
}

/**
 * Session-gated routes: a de-entitled account's session is the same 401 as an
 * expired one, so Pocket returns to sign-in.
 */
export const requireSession = bearerGate("session", {
  lookup: sessionByToken,
  admit: (c, session) => (session.entitled ? null : unauthorized(c)),
});

/** Burrow-gated routes: an owner not entitled is a 403, rechecked per request. */
const BURROW_GATE: Gate<RelayBurrow> = {
  lookup: burrowByToken,
  admit: (c, burrow) => (burrow.entitled ? null : c.json({ error: NOT_ENTITLED_ERROR }, 403)),
};
export const requireBurrow = bearerGate("burrow", BURROW_GATE);

/**
 * The Burrow gate for a route whose work outlasts its reads: `read` runs on
 * the gate's connection, which is released before this answers, so what the
 * route does next never holds it. Answers what `read` does, or the gate's
 * refusal.
 */
export const readAsBurrow = <T>(
  c: Context<{ Bindings: RelayEnv }>,
  read: (db: Client, burrow: RelayBurrow) => Promise<T>,
): Promise<T | Response> => gated(c, BURROW_GATE, read);
