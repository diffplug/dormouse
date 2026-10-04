import type { Context, ExecutionContext, Hono } from "hono";
import { queryDatabase } from "pgstencil/postgres";
import { billingSetup, type Clock } from "./billing";
import { COHORT_PATH, billingRoutes, reconcileDue, type BillingHost } from "./billing-routes";
import type { AccountEnv } from "./bindings";
import { accountRules } from "./headers";
import { relayAccountRoutes, type RelayAccountHost } from "./relay-account";
import { relayRoom } from "./relay-room-contract";
import { voiceTokenRoutes } from "./voice";
import { workerApp } from "./worker-app";

/** The marketing site, whose Hosted page reads the cohort endpoint same-origin. */
export const SITE_ORIGIN = "https://dormouse.sh";

/**
 * The account Worker (`hosted.dormouse.sh`): auth, providers, readiness,
 * voice-token minting, the Relay's account routes, billing, and the
 * frontend. The production and preview entries differ only in `fetchAuth`'s
 * mail and in `bindings`; a test entry also supplies its `clock`.
 */
export function accountApp(
  fetchAuth: (
    request: Request,
    env: AccountEnv,
    ctx: ExecutionContext,
  ) => Response | Promise<Response>,
  bindings: (env: AccountEnv) => AccountEnv,
  clock: Clock,
  configure?: (app: Hono<{ Bindings: AccountEnv }>) => void,
) {
  return workerApp<AccountEnv>({
    bindings,
    rules: accountRules,
    unavailable: "Sign-in is temporarily unavailable. Please try again.",
    site: { origin: SITE_ORIGIN, paths: [COHORT_PATH] },
    routes(app) {
      configure?.(app);
      app.get("/api/ready", async (c) => {
        const ok = await queryDatabase(
          c.env.HYPERDRIVE.connectionString,
          'SELECT "singleSession", "emailAuthenticated" FROM "session" LIMIT 0',
        ).then(
          () => true,
          () => false,
        );
        return c.json({ ok }, ok ? 200 : 503);
      });
      app.all("/api/auth/*", (c) =>
        fetchAuth(c.req.raw, c.env, c.executionCtx),
      );
      app.get("/api/providers", (c) =>
        fetchAuth(c.req.raw, c.env, c.executionCtx),
      );
      const host = (c: Context<{ Bindings: AccountEnv }>): RelayAccountHost & BillingHost => ({
        databaseUrl: c.env.HYPERDRIVE.connectionString,
        auth: (request) => fetchAuth(request, c.env, c.executionCtx),
        approveLimit: c.env.RELAY_APPROVE_LIMIT,
        closeBurrow: (userId, burrowId) => relayRoom(c.env.RELAY_ROOM, userId).closeBurrow(burrowId),
        setup: () => billingSetup(c.env),
        clock,
      });
      voiceTokenRoutes(app, host);
      relayAccountRoutes(app, host);
      billingRoutes(app, host);
    },
    fallback: (app) => app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw)),
    scheduled: (_controller, env) =>
      reconcileDue(billingSetup(env), env.HYPERDRIVE.connectionString, clock, env.APP_ORIGIN),
  });
}
