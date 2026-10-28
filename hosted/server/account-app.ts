import type { Context, ExecutionContext, Hono } from "hono";
import { postmarkEmail } from "@pgstencil/auth/postmark";
import type { EmailSender } from "pgstencil";
import { cookieAdmin, openAuthRead, ownPageRead } from "./account-gate";
import { billingSetup, resyncBilling } from "./billing";
import { billingRoutes, type BillingHost } from "./billing-routes";
import type { AccountEnv } from "./bindings";
import { closureRoutes, type ClosureHost } from "./closure";
import { accountRules } from "./headers";
import { ADMIN_METRICS_PATH } from "./metric-labels";
import { readMetrics } from "./metrics";
import { relayAccountRoutes, type RelayAccountHost } from "./relay-account";
import { relayRoom } from "./relay-room-contract";
import { termsRoutes } from "./terms";
import { voiceAccountRoutes } from "./voice";
import { workerApp } from "./worker-app";

/**
 * The account Worker (`hosted.dormouse.sh`): auth, providers, readiness,
 * terms acceptance, Natural Voice on or off, the Relay's account routes, the
 * admin's metrics, the frontend, billing, and account closure. The
 * production and preview entries differ only in their mail (`fetchAuth`'s and
 * `mail`) and in `bindings`.
 */
export function accountApp(
  fetchAuth: (
    request: Request,
    env: AccountEnv,
    ctx: ExecutionContext,
  ) => Response | Promise<Response>,
  bindings: (env: AccountEnv) => AccountEnv,
  configure?: (app: Hono<{ Bindings: AccountEnv }>) => void,
  /** The mail billing sends, a withdrawal's acknowledgement: Postmark unless a preview's inbox. */
  mail: (env: AccountEnv) => EmailSender = (env) => postmarkEmail(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM),
) {
  return workerApp<AccountEnv>({
    bindings,
    rules: accountRules,
    ready: 'SELECT "singleSession", "emailAuthenticated" FROM "session" LIMIT 0',
    unavailable: "Sign-in is temporarily unavailable. Please try again.",
    routes(app) {
      configure?.(app);
      app.all("/api/auth/*", (c) =>
        c.req.method !== "POST" &&
        !openAuthRead(c.req.path) &&
        !ownPageRead(c.req.raw, c.env.APP_ORIGIN)
          ? c.json({ message: "Invalid origin." }, 403)
          : fetchAuth(c.req.raw, c.env, c.executionCtx),
      );
      // The provider list needs no login, so it never carries one.
      app.get("/api/providers", (c) => {
        const headers = new Headers(c.req.raw.headers);
        headers.delete("cookie");
        return fetchAuth(new Request(c.req.raw, { headers }), c.env, c.executionCtx);
      });
      const host = (c: Context<{ Bindings: AccountEnv }>): RelayAccountHost & BillingHost & ClosureHost => ({
        databaseUrl: c.env.HYPERDRIVE.connectionString,
        auth: (request) => fetchAuth(request, c.env, c.executionCtx),
        approveLimit: c.env.RELAY_APPROVE_LIMIT,
        closeBurrow: (userId, burrowId) => relayRoom(c.env.RELAY_ROOM, userId).closeBurrow(burrowId),
        setup: () => billingSetup(c.env),
        mail: () => mail(c.env),
      });
      termsRoutes(app, host);
      voiceAccountRoutes(app, host);
      relayAccountRoutes(app, host);
      billingRoutes(app, host);
      closureRoutes(app, host);
      app.get(ADMIN_METRICS_PATH, cookieAdmin(host), async (c) =>
        c.json(await readMetrics(c.env.HYPERDRIVE.connectionString)),
      );
    },
    // Every desktop since v1.2.0 opens `/account` by a hard-coded path
    // (`ACCOUNT_PAGE_PATH`), which this SPA fallback answers.
    fallback: (app) => app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw)),
    scheduled: (_controller, env) =>
      resyncBilling(billingSetup(env), env.HYPERDRIVE.connectionString, env.APP_ORIGIN, () => mail(env)),
  });
}
