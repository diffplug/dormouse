import type { Hono } from "hono";
import type { RelayEnv } from "./bindings";
import { assetOrNotFound } from "./one-time";

/**
 * Pocket at the relay's root (`docs/specs/pocket-app.md` -> "Serving the built
 * bundle"), staged into the relay's assets beside `/connect/`: a hashed asset
 * only as itself, the shell straight away for a path that names no file, and
 * any other path as its file, or the shell when there is none. Registered as
 * the relay's fallback, after every route and the non-page tails. Paths are
 * the decoded ones Hono routes on.
 */
export function pocketRoutes(app: Hono<{ Bindings: RelayEnv }>) {
  app.get("*", async (c) => {
    const { path } = c.req;
    const fetchPath = (pathname: string) => {
      const url = new URL(c.req.url);
      url.pathname = pathname;
      return c.env.ASSETS.fetch(new Request(url, c.req.raw));
    };
    if (path.startsWith("/assets/")) return assetOrNotFound(c, await fetchPath(path));
    // A deep link — no extension, outside the diagnostics harness — is one
    // asset fetch: the shell's.
    if (!/\.[^/]*$/.test(path) && !/^\/diagnostics(?:\/|$)/.test(path)) return fetchPath("/");
    // The assets' HTML handling answers `…/index.html` with a redirect to its
    // directory; the diagnostics page is reached by that name, so ask for the
    // directory instead.
    const response = await fetchPath(
      path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path,
    );
    return response.status === 404 ? fetchPath("/") : response;
  });
}
