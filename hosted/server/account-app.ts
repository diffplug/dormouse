import type { Context, ExecutionContext, Hono } from "hono";
import type { AccountEnv } from "./bindings";
import { accountRules } from "./headers";
import { relayAccountRoutes, type RelayAccountHost } from "./relay-account";
import { relayRoom } from "./relay-room-contract";
import { voiceTokenRoutes } from "./voice";
import { readyRoute, workerApp } from "./worker-app";

/**
 * The account Worker (`hosted.dormouse.sh`): auth, providers, readiness,
 * voice-token minting, the Relay's account routes, and the frontend. The
 * production and preview entries differ only in `fetchAuth`'s mail and in
 * `bindings`.
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
    routes(app) {
      configure?.(app);
      readyRoute(app, 'SELECT "singleSession", "emailAuthenticated" FROM "session" LIMIT 0');
      app.all("/api/auth/*", (c) =>
        fetchAuth(c.req.raw, c.env, c.executionCtx),
      );
      app.get("/api/providers", (c) =>
        fetchAuth(c.req.raw, c.env, c.executionCtx),
      );
      const host = (c: Context<{ Bindings: AccountEnv }>): RelayAccountHost => ({
        databaseUrl: c.env.HYPERDRIVE.connectionString,
        auth: (request) => fetchAuth(request, c.env, c.executionCtx),
        approveLimit: c.env.RELAY_APPROVE_LIMIT,
        closeBurrow: (userId, burrowId) => relayRoom(c.env.RELAY_ROOM, userId).closeBurrow(burrowId),
      });
      voiceTokenRoutes(app, host);
      relayAccountRoutes(app, host);
    },
    fallback: (app) => app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw)),
  });
}
