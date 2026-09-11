import { Hono, type ExecutionContext } from "hono";
import type { Env } from "./worker";
import { queryDatabase } from "pgstencil/postgres";
import { secureHeaders } from "./headers";

export function workerApp(
  fetchAuth: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) => Response | Promise<Response>,
  configure?: (app: Hono<{ Bindings: Env }>) => void,
) {
  const app = new Hono<{ Bindings: Env }>();
  secureHeaders(app);
  app.use("*", async (c, next) => {
    // A candidate/preview hostname must never act as an alias for production auth.
    if (new URL(c.req.url).origin !== c.env.APP_ORIGIN)
      return c.json({ message: "Unknown origin." }, 421);
    await next();
  });
  configure?.(app);
  app.get("/api/health", (c) =>
    c.json({ ok: true, revision: c.env.BUILD_SHA ?? null }),
  );
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
  app.all("/api/auth/*", (c) => fetchAuth(c.req.raw, c.env, c.executionCtx));
  app.get("/api/providers", (c) => fetchAuth(c.req.raw, c.env, c.executionCtx));
  app.all("/api/*", (c) => c.json({ message: "Not found." }, 404));
  app.all("/dev/*", (c) => c.notFound());
  app.all("/__test/*", (c) => c.notFound());
  app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  app.onError((_error, c) =>
    c.json(
      { message: "Sign-in is temporarily unavailable. Please try again." },
      503,
    ),
  );

  return app;
}
