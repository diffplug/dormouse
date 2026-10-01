import { Hono } from "hono";
import { secureHeaders, type PolicyFor } from "./headers";

/**
 * What all three Workers share (`docs/specs/hosted.md` -> "Application
 * boundary"): the secure headers, the bindings mapper, the 421 gate, `/api/health`,
 * the 404 tail, and `onError`. Each entry mounts only its own routes, between
 * the gate and the tail, and its `fallback` after the tail.
 */
export function workerApp<E extends { APP_ORIGIN: string; BUILD_SHA?: string }>({
  bindings,
  policy,
  routes,
  fallback,
  unavailable,
}: {
  /** The only bindings that reach the routes. */
  bindings: (env: E) => E;
  policy: PolicyFor;
  routes: (app: Hono<{ Bindings: E }>) => void;
  /** Answers what nothing else did; without one, Hono's 404. */
  fallback?: (app: Hono<{ Bindings: E }>) => void;
  /** `onError`'s message. */
  unavailable: string;
}) {
  const app = new Hono<{ Bindings: E }>();
  secureHeaders(app, policy);
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
  return app;
}
