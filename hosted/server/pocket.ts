import type { Hono } from "hono";
import type { RelayEnv } from "./bindings";

/**
 * Pocket at the relay's root (`docs/specs/pocket-app.md` -> "Serving the built
 * bundle"), staged into the relay's assets beside `/connect/`: a file when one
 * exists, a hashed asset only as itself, and the shell for every other path.
 * Registered as the relay's fallback, after every route and the `/api/*` tail.
 */
export function pocketRoutes(app: Hono<{ Bindings: RelayEnv }>) {
  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    const { pathname } = url;
    // The assets' HTML handling answers `…/index.html` with a redirect to its
    // directory; the diagnostics page is reached by that name, so ask for the
    // directory instead.
    if (pathname.endsWith("/index.html"))
      url.pathname = pathname.slice(0, -"index.html".length);
    const response = await c.env.ASSETS.fetch(new Request(url, c.req.raw));
    // A missing asset is never answered with the shell: an HTML body under a
    // hashed name would be cached as immutable.
    if (pathname.startsWith("/assets/"))
      return response.ok &&
        !(response.headers.get("content-type") ?? "").includes("text/html")
        ? response
        : c.notFound();
    if (response.status !== 404) return response;
    return c.env.ASSETS.fetch(new Request(new URL("/", url), c.req.raw));
  });
}
