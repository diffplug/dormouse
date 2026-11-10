import type { Context, ExecutionContext, Hono } from "hono";
import type { EmailSender } from "pgstencil";
import { openAuthRead, ownPageRead, smallBody } from "./account-gate";
import { accountCron, accountRoutes, type AccountRoutesHost } from "./account-routes";
import { billingSetup } from "./billing";
import type { AccountEnv } from "./bindings";
import { accountRules } from "./headers";
import { noticeMail } from "./notices";
import { relayRoom } from "./relay-room-contract";
import { workerApp } from "./worker-app";

/**
 * The account Worker (`hosted.dormouse.sh`): auth, providers, readiness,
 * terms acceptance, Natural Voice on or off, the Relay's account routes, the
 * admin's metrics, the frontend, billing, account closure, and the founders
 * row. The production and preview entries differ in their mail (`fetchAuth`'s
 * and `mail`), in `bindings`, in production's pre-launch gate around
 * `fetchAuth`, and in the preview's inbox routes (`configure`).
 */
export function accountApp(
  fetchAuth: (
    request: Request,
    env: AccountEnv,
    ctx: ExecutionContext,
  ) => Response | Promise<Response>,
  bindings: (env: AccountEnv) => AccountEnv,
  configure?: (app: Hono<{ Bindings: AccountEnv }>) => void,
  /** The mail billing sends, its notices and the billing alert: Postmark unless a preview's inbox. */
  mail: (env: AccountEnv) => EmailSender = (env) => noticeMail(env.POSTMARK_SERVER_TOKEN),
) {
  return workerApp<AccountEnv>({
    bindings,
    rules: accountRules,
    ready: 'SELECT "singleSession", "emailAuthenticated" FROM "session" LIMIT 0',
    unavailable: "Sign-in is temporarily unavailable. Please try again.",
    routes(app) {
      configure?.(app);
      // The packed adapter's own cap, applied here too so nothing that wraps
      // `fetchAuth` (production's pre-launch gate parses a POST's body) reads
      // more than the adapter would accept.
      app.all("/api/auth/*", smallBody(16 * 1024), (c) =>
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
      accountRoutes(app, (c: Context<{ Bindings: AccountEnv }>): AccountRoutesHost => ({
        databaseUrl: c.env.HYPERDRIVE.connectionString,
        auth: (request) => fetchAuth(request, c.env, c.executionCtx),
        approveLimit: c.env.RELAY_APPROVE_LIMIT,
        closeBurrow: (userId, burrowId) => relayRoom(c.env.RELAY_ROOM, userId).closeBurrow(burrowId),
        closeSessions: (userId, tokenHashes) => relayRoom(c.env.RELAY_ROOM, userId).closeSessions(tokenHashes),
        nudgeBurrows: (userId) => relayRoom(c.env.RELAY_ROOM, userId).nudgeBurrows(),
        setup: () => billingSetup(c.env),
        mail: () => mail(c.env),
      }));
    },
    // Every desktop since v1.2.0 opens `/account` by a hard-coded path
    // (`ACCOUNT_PAGE_PATH`), which this SPA fallback answers.
    fallback: (app) => app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw)),
    scheduled: (_controller, env) =>
      accountCron(
        { databaseUrl: env.HYPERDRIVE.connectionString, setup: () => billingSetup(env), mail: () => mail(env) },
        env.APP_ORIGIN,
      ),
  });
}
