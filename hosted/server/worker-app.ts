import { Hono, type ExecutionContext } from "hono";
import type { WorkerEnv } from "./bindings";
import { secureHeaders, type HeaderRules } from "./headers";

/**
 * What all three Workers share (`docs/specs/hosted.md` -> "Application
 * boundary"): the secure headers, the bindings mapper, the 421 gate, `/api/health`,
 * the 404 tail, and `onError`. Each entry mounts only its own routes, between
 * the gate and the tail, and its `fallback` after the tail. A Cron Trigger's
 * `scheduled` sees the same mapped bindings a route does.
 */
export function workerApp<E extends WorkerEnv>({
  bindings,
  hashedAssets = [],
  routes,
  fallback,
  scheduled,
  unavailable,
  ...rules
}: Omit<HeaderRules, "hashedAssets"> & {
  /** The only bindings that reach the routes. */
  bindings: (env: E) => E;
  hashedAssets?: readonly string[];
  routes: (app: Hono<{ Bindings: E }>) => void;
  /** Answers what nothing else did; without one, Hono's 404. */
  fallback?: (app: Hono<{ Bindings: E }>) => void;
  scheduled?: (
    controller: unknown,
    env: E,
    ctx: ExecutionContext,
  ) => Promise<void>;
  /** `onError`'s message. */
  unavailable: string;
}) {
  const app = new Hono<{ Bindings: E }>();
  secureHeaders(app, { ...rules, hashedAssets });
  // The mapper alone decides which bindings reach the routes; resolving it in
  // the request keeps a misconfigured deployment on onError, headers and all.
  app.use("*", async (c, next) => {
    c.env = bindings(c.env);
    await next();
  });
  app.use("*", async (c, next) => {
    // A candidate/preview hostname, or a sibling Worker's, must never act as an alias for this one.
    if (new URL(c.req.url).origin !== c.env.APP_ORIGIN)
      return c.json({ message: "Unknown origin." }, 421);
    await next();
  });
  routes(app);
  app.get("/api/health", (c) =>
    c.json({ ok: true, revision: c.env.BUILD_SHA ?? null }),
  );
  app.all("/api/*", (c) => c.json({ message: "Not found." }, 404));
  app.all("/dev/*", (c) => c.notFound());
  app.all("/__test/*", (c) => c.notFound());
  fallback?.(app);
  app.onError((_error, c) => c.json({ message: unavailable }, 503));
  return {
    fetch: app.fetch,
    ...(scheduled && {
      scheduled: (controller: unknown, env: E, ctx: ExecutionContext) =>
        scheduled(controller, bindings(env), ctx),
    }),
  };
}
