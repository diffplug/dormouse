// Rules: docs/specs/hosted.md -> "Burrow enrollment".
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { queryDatabase } from "pgstencil/postgres";
import { NOT_ENTITLED_ERROR, isE2eId, normalizeEnrollUserCode } from "remote-lib-common";
import { cookieAdmin } from "./account-gate";
import { LOGIN_FRESH_AGE_MS } from "./policy-constants";

/** What one request's account deployment provides to the Relay's account routes. */
export interface RelayAccountHost {
  databaseUrl: string;
  /** The Better Auth handler, asked for the cookie's login. */
  auth(request: Request): Response | Promise<Response>;
  /** Approval attempts, keyed by account. */
  approveLimit: RateLimit;
}

/** The 403 an approval from a login older than the recent-login window gets. */
export const RECENT_LOGIN_REQUIRED =
  "Sign in again to approve. Approving a computer needs a login from the last 10 minutes.";
const UNKNOWN_CODE = "That code is not waiting for approval. It may have expired.";

/**
 * The account's half of the Hosted Relay: approving a device-code enrollment,
 * and listing and removing the account's Burrows. Cookie routes under the
 * voice routes' gate; the relay Worker serves none of them. Call before any
 * `/api/*` catch-all.
 */
export function relayAccountRoutes(app: Hono<any>, host: (c: Context) => RelayAccountHost) {
  const gate = cookieAdmin(
    (c) => host(c).auth,
    (c) => c.json({ message: NOT_ENTITLED_ERROR }, 403),
  );
  const query = <Row extends Record<string, unknown>>(c: Context, text: string, values: unknown[]) =>
    queryDatabase<Row>(host(c).databaseUrl, text, values);

  const small = bodyLimit({
    maxSize: 1024,
    onError: (c) => c.json({ message: "Request too large." }, 413),
  });

  app.post("/api/relay/enrollments/approve", small, gate, async (c) => {
    const login = c.get("login");
    if (Date.now() - login.createdAt >= LOGIN_FRESH_AGE_MS)
      return c.json({ message: RECENT_LOGIN_REQUIRED }, 403);
    // Every attempt counts, so a signed-in account cannot walk the code space.
    if (!(await host(c).approveLimit.limit({ key: login.userId })).success) {
      c.header("Retry-After", "60");
      return c.json({ message: "Too many attempts. Wait a minute before trying again." }, 429);
    }
    let body: { userCode?: unknown } | null = null;
    try {
      body = await c.req.json();
    } catch {}
    const userCode = normalizeEnrollUserCode(body?.userCode);
    // Unknown, expired, and already approved are one answer; an approval is
    // stamped once and never moves to another account.
    const approved =
      userCode !== null &&
      (
        await query(
          c,
          `UPDATE dormouse_relay_enrollments SET "approvedBy" = $2, "approvedAt" = now()
          WHERE "userCode" = $1 AND "expiresAt" > now() AND "approvedBy" IS NULL
          RETURNING 1`,
          [userCode, login.userId],
        )
      ).length > 0;
    return approved ? c.body(null, 204) : c.json({ message: UNKNOWN_CODE }, 404);
  });

  app.get("/api/relay/burrows", gate, async (c) => {
    const burrows = await query(
      c,
      `SELECT "burrowId", "enrolledAt" FROM dormouse_relay_burrows
      WHERE "userId" = $1 AND "revokedAt" IS NULL ORDER BY "enrolledAt" DESC, "burrowId"`,
      [c.get("login").userId],
    );
    return c.json({ burrows });
  });

  app.delete("/api/relay/burrows/:burrowId", gate, async (c) => {
    const burrowId = c.req.param("burrowId");
    const revoked =
      isE2eId(burrowId) &&
      (
        await query(
          c,
          `UPDATE dormouse_relay_burrows SET "revokedAt" = coalesce("revokedAt", now())
          WHERE "burrowId" = $1 AND "userId" = $2 RETURNING 1`,
          [burrowId, c.get("login").userId],
        )
      ).length > 0;
    return revoked ? c.body(null, 204) : c.json({ message: "Computer not found." }, 404);
  });
}
