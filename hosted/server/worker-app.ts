import { Hono, type ExecutionContext } from "hono";
import type { Env } from "./worker";
import { queryDatabase } from "pgstencil/postgres";
import { secureHeaders } from "./headers";
import { elevenLabs, sweepOnCron, voiceRoutes } from "./voice";

export function workerApp(
  fetchAuth: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) => Response | Promise<Response>,
  bindings: (env: Env) => Env,
  {
    configure,
    sweepDelayMs,
  }: {
    configure?: (app: Hono<{ Bindings: Env }>) => void;
    /** Delay of the history sweep after a successful speech. */
    sweepDelayMs?: number;
  } = {},
) {
  const app = new Hono<{ Bindings: Env }>();
  secureHeaders(app);
  // The mapper alone decides which bindings reach auth and the routes; resolving
  // it in the request keeps a misconfigured deployment on onError, headers and all.
  app.use("*", async (c, next) => {
    c.env = bindings(c.env);
    await next();
  });
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
  voiceRoutes(app, (c) => {
    const key = c.env.ELEVENLABS_API_KEY;
    return {
      databaseUrl: c.env.HYPERDRIVE.connectionString,
      auth: (request) => fetchAuth(request, c.env, c.executionCtx),
      synthesize: key
        ? elevenLabs(
            key,
            (pass) => c.executionCtx.waitUntil(pass),
            sweepDelayMs,
          )
        : undefined,
    };
  });
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

  return {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
      app.fetch(request, env, ctx),
    // The Cron Trigger: the same mapper decides whether a key reaches the sweep.
    async scheduled(_controller: unknown, env: Env) {
      const key = bindings(env).ELEVENLABS_API_KEY;
      if (key) await sweepOnCron(key);
    },
  };
}
