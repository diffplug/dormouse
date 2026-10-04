// Rules: docs/specs/hosted.md -> "Burrow enrollment".
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  NOT_ENTITLED_ERROR,
  isE2eId,
  normalizeEnrollUserCode,
  readJson,
} from "remote-lib-common";
import { accountQuery, cookieEntitled, type AccountHost } from "./account-gate";
import { ENROLLMENT_TTL_MS, LOGIN_FRESH_AGE_MS, RECENT_LOGIN_WINDOW } from "./policy-constants";

/** What one request's account deployment provides to the Relay's account routes. */
export type RelayAccountHost = AccountHost & {
  /** Approval attempts, keyed by account. */
  approveLimit: RateLimit;
  /** Close the removed Burrow's live relay socket (`RelayRoom.closeBurrow`). */
  closeBurrow(userId: string, burrowId: string): Promise<unknown>;
};

/** The 403 an approval from a login older than the recent-login window gets. */
export const RECENT_LOGIN_REQUIRED = `Sign in again to approve. Approving a computer needs a login from the last ${RECENT_LOGIN_WINDOW}.`;
/** The 409 a second approval of a live code gets, whichever account sends it. */
export const ALREADY_APPROVED = "That code is already approved.";

/**
 * The account's half of the Hosted Relay: approving a device-code enrollment,
 * and listing and removing the account's Burrows. Cookie routes under the
 * voice routes' gate; the relay Worker serves none of them. Call before any
 * `/api/*` catch-all.
 */
export function relayAccountRoutes(app: Hono<any>, host: (c: Context) => RelayAccountHost) {
  const gate = cookieEntitled(host, (c) => c.json({ message: NOT_ENTITLED_ERROR }, 403));

  const small = bodyLimit({
    maxSize: 1024,
    onError: (c) => c.json({ message: "Request too large." }, 413),
  });

  app.post("/api/relay/enrollments/approve", small, gate, async (c) => {
    const login = c.get("login");
    // Fails closed: a login whose creation time is missing or unreadable is
    // not recent.
    const createdAt = Date.parse(String(login.createdAt));
    if (!(Date.now() - createdAt < LOGIN_FRESH_AGE_MS))
      return c.json({ message: RECENT_LOGIN_REQUIRED }, 403);
    // Every attempt counts, so a signed-in account cannot walk the code space;
    // as the approvals' only writer, this limit is also what bounds them.
    if (!(await host(c).approveLimit.limit({ key: login.userId })).success) {
      c.header("Retry-After", "60");
      return c.json({ message: "Too many attempts. Wait a minute before trying again." }, 429);
    }
    const userCode = normalizeEnrollUserCode(
      (await readJson<{ userCode?: unknown }>(c))?.userCode,
    );
    if (userCode === null)
      return c.json({ message: "That is not a code from Dormouse." }, 400);
    // Whether the code was ever issued is unknowable here: begin stores
    // nothing. An approval expires, redeemed or not. A live approval never
    // moves to another account, nor is one approved again once redeemed; an
    // expired one is replaced, unredeemed.
    const approved =
      (
        await accountQuery(
          host(c),
          `INSERT INTO dormouse_relay_enrollment_approvals AS a ("userCode", "userId", "expiresAt")
          VALUES ($1, $2, now() + ($3::float8 * interval '1 millisecond'))
          ON CONFLICT ("userCode") DO UPDATE
            SET "userId" = EXCLUDED."userId", "expiresAt" = EXCLUDED."expiresAt",
              "redeemedBurrowId" = NULL, "redeemedAt" = NULL
            WHERE a."expiresAt" <= now()
          RETURNING 1`,
          [userCode, login.userId, ENROLLMENT_TTL_MS],
        )
      ).length > 0;
    return approved ? c.body(null, 204) : c.json({ message: ALREADY_APPROVED }, 409);
  });

  app.get("/api/relay/burrows", gate, async (c) => {
    const burrows = await accountQuery(
      host(c),
      `SELECT "burrowId", "enrolledAt" FROM dormouse_relay_burrows
      WHERE "userId" = $1 ORDER BY "enrolledAt" DESC, "burrowId"`,
      [c.get("login").userId],
    );
    return c.json({ burrows });
  });

  // The row goes, and its setup tokens and setup challenges with it, so its
  // Burrow token finds nothing on any relay route; then its live socket, if
  // it holds one, is closed as revoked and its Clients told `burrow-gone`.
  // The removal is done once the row is: a close that fails is logged, and
  // the object's hourly sweep closes the socket instead.
  app.delete("/api/relay/burrows/:burrowId", gate, async (c) => {
    const burrowId = c.req.param("burrowId");
    const { userId } = c.get("login");
    const removed =
      isE2eId(burrowId) &&
      (
        await accountQuery(
          host(c),
          `DELETE FROM dormouse_relay_burrows WHERE "burrowId" = $1 AND "userId" = $2 RETURNING 1`,
          [burrowId, userId],
        )
      ).length > 0;
    if (!removed) return c.json({ message: "Computer not found." }, 404);
    try {
      await host(c).closeBurrow(userId, burrowId);
    } catch (error) {
      console.error("Closing a removed Burrow's relay socket failed; the sweep will", error);
    }
    return c.body(null, 204);
  });
}
