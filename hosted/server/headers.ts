import type { Hono } from "hono";
import { ONE_TIME_PAGE_PATH, ONE_TIME_WS_ROUTES } from "remote-lib-common";

/** The origin-wide policy: the account frontend's own files and nothing else. */
const ORIGIN_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";

/** Whether a path is the one-time page's: `/connect` itself or anything under `/connect/`. */
export function isOneTimePagePath(pathname: string) {
  return (
    pathname === ONE_TIME_PAGE_PATH.slice(0, -1) ||
    pathname.startsWith(ONE_TIME_PAGE_PATH)
  );
}

/**
 * The one-time page's own policy (`docs/specs/one-time.md` -> "Phone page"),
 * narrower than the origin's where it can be and looser only where the page
 * needs it: scripts from `/connect/assets/` alone (plus WebAssembly for xterm's
 * image decoder), inline styles for the shell and React, and one socket — the
 * rendezvous client route. Sandboxed, so it opens no popup and submits no form.
 */
export function oneTimePagePolicy(appOrigin: string) {
  const page = `${appOrigin}${ONE_TIME_PAGE_PATH}`;
  return [
    "default-src 'none'",
    `script-src ${page}assets/ 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${page} data: blob:`,
    `font-src ${page}`,
    "media-src blob:",
    `connect-src ${appOrigin.replace(/^http/, "ws")}${ONE_TIME_WS_ROUTES.client}`,
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "sandbox allow-scripts allow-same-origin",
  ].join("; ");
}

/**
 * The policy a response to `pathname` carries. The page's needs `APP_ORIGIN`,
 * and a value that is not exactly an origin could write a directive of its
 * own into the header: the origin-wide policy, which runs none of the page,
 * answers instead.
 */
export function contentSecurityPolicy(pathname: string, appOrigin: unknown) {
  if (!isOneTimePagePath(pathname)) return ORIGIN_POLICY;
  return typeof appOrigin === "string" &&
    /^https?:\/\/[a-z0-9.:[\]-]+$/i.test(appOrigin) &&
    URL.canParse(appOrigin) &&
    new URL(appOrigin).origin === appOrigin
    ? oneTimePagePolicy(appOrigin)
    : ORIGIN_POLICY;
}

/** Vite's content-hashed output: the account frontend's, and the one-time page's. */
const HASHED_ASSETS = ["/assets/", `${ONE_TIME_PAGE_PATH}assets/`];

// Applied to the HTML shell as well as APIs: auth's own middleware only covers its routes.
export function secureHeaders(app: Hono<any>) {
  app.use("*", async (c, next) => {
    await next();
    // A WebSocket upgrade carries no document, and its headers are the runtime's.
    if (c.res.status === 101) return;
    const { pathname } = new URL(c.req.url);
    // Vite emits content-hashed files under each `assets/`, so they are safe to cache
    // forever, but the SPA fallback answers an unknown /assets/ path with the HTML shell:
    // cache only a 200 whose type is not HTML, and leave everything else uncached.
    const asset =
      c.res.status === 200 &&
      HASHED_ASSETS.some((prefix) => pathname.startsWith(prefix)) &&
      !(c.res.headers.get("content-type") ?? "").includes("text/html");
    c.header(
      "Cache-Control",
      asset ? "public, max-age=31536000, immutable" : "no-store",
    );
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Strict-Transport-Security", "max-age=31536000");
    // `c.env` is the mapped bindings once the mapper ran, and the raw ones if it threw.
    c.header(
      "Content-Security-Policy",
      contentSecurityPolicy(pathname, c.env?.APP_ORIGIN),
    );
  });
}
