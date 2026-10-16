// Rules: docs/specs/hosted.md -> "Terms acceptance".
import type { Context, Hono } from "hono";
import { accountQuery, cookieLogin, type AccountHost } from "./account-gate";
import { TERMS_VERSION } from "./policy-constants";

/**
 * Registers the account's POST /api/terms/acceptance, which records that the
 * signed-in account continued past the sign-in notice naming `version`; call
 * before any /api/* catch-all. Only the current version is recorded, so a
 * notice a stale page showed never stands in for the one in force.
 */
export function termsRoutes(
  app: Hono<any>,
  host: (c: Context) => AccountHost,
) {
  app.post("/api/terms/acceptance", cookieLogin(host), async (c) => {
    const body = await c.req
      .json<{ version?: unknown }>()
      .catch(() => null);
    if (body?.version !== TERMS_VERSION)
      return c.json({ message: "That terms version is not current." }, 409);
    await accountQuery(
      host(c),
      `INSERT INTO dormouse_terms_acceptances ("userId", version) VALUES ($1, $2)
      ON CONFLICT DO NOTHING`,
      [c.get("login").userId, TERMS_VERSION],
    );
    return c.body(null, 204);
  });
}
