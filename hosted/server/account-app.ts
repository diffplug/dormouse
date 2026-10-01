import type { ExecutionContext, Hono } from "hono";
import { queryDatabase } from "pgstencil/postgres";
import type { AccountEnv } from "./bindings";
import { ACCOUNT_HASHED_ASSETS, ACCOUNT_POLICY } from "./headers";
import { voiceTokenRoutes } from "./voice";
import { workerApp } from "./worker-app";

/**
 * The account Worker (`hosted.dormouse.sh`): auth, providers, readiness,
 * voice-token minting, and the frontend. The production and preview entries
 * differ only in `fetchAuth`'s mail and in `bindings`.
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
    policy: () => ACCOUNT_POLICY,
    hashedAssets: ACCOUNT_HASHED_ASSETS,
    unavailable: "Sign-in is temporarily unavailable. Please try again.",
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
      voiceTokenRoutes(app, (c) => ({
        databaseUrl: c.env.HYPERDRIVE.connectionString,
        auth: (request) => fetchAuth(request, c.env, c.executionCtx),
      }));
    },
    fallback: (app) => app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw)),
  });
}
