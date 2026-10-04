import type { Context, ExecutionContext, Hono } from "hono";
import { queryDatabase } from "pgstencil/postgres";
import { adminRoutes } from "./admin";
import { billingSetup } from "./billing";
import { COHORT_ENDPOINT } from "../../website/src/lib/hosted-cohorts";
import { billingRoutes, reconcileDue, type BillingHost } from "./billing-routes";
import type { AccountEnv } from "./bindings";
import { accountRules } from "./headers";
import { recordLogin } from "./account-gate";
import { sweepCheckoutRefs } from "./metrics";
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
 * mail and in `bindings`.
 */
export function accountApp(
  fetchAuth: (
    request: Request,
    env: AccountEnv,
    ctx: ExecutionContext,
  ) => Response | Promise<Response>,
  bindings: (env: AccountEnv) => AccountEnv,
  configure?: (app: Hono<{ Bindings: AccountEnv }>) => void,
) {
  return workerApp<AccountEnv>({
    bindings,
    rules: accountRules,
    unavailable: "Sign-in is temporarily unavailable. Please try again.",
    site: { origin: SITE_ORIGIN, paths: [COHORT_ENDPOINT] },
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
      const host = (c: Context<{ Bindings: AccountEnv }>): RelayAccountHost & BillingHost => ({
        databaseUrl: c.env.HYPERDRIVE.connectionString,
        auth: (request) => fetchAuth(request, c.env, c.executionCtx),
        approveLimit: c.env.RELAY_APPROVE_LIMIT,
        closeBurrow: (userId, burrowId) => relayRoom(c.env.RELAY_ROOM, userId).closeBurrow(burrowId),
        setup: () => billingSetup(c.env),
      });
      app.all("/api/auth/*", async (c) => {
        const response = await fetchAuth(c.req.raw, c.env, c.executionCtx);
        recordLogin(c, host(c), c.req.raw, response);
        return response;
      });
      app.get("/api/providers", (c) =>
        fetchAuth(c.req.raw, c.env, c.executionCtx),
      );
      voiceTokenRoutes(app, host);
      relayAccountRoutes(app, host);
      billingRoutes(app, host);
      adminRoutes(app, host);
    },
    fallback: (app) => app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw)),
    scheduled: async (_controller, env) => {
      const databaseUrl = env.HYPERDRIVE.connectionString;
      await sweepCheckoutRefs(databaseUrl).catch((error: Error) =>
        console.error(`Checkout refs not swept: ${error.message}`),
      );
      await reconcileDue(billingSetup(env), databaseUrl, env.APP_ORIGIN);
    },
  });
}
