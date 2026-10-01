import type { Hono } from "hono";
import {
  ONE_TIME_PAGE_PATH,
  ONE_TIME_WS_ROUTES,
  pocketContentSecurityPolicy,
} from "remote-lib-common";

/** The account origin's policy: the account frontend's own files and nothing else. */
export const ACCOUNT_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";

/**
 * The policy of every response that is no page: the voice origin's, and the
 * relay origin's under `/api/` and `/ws/`. It runs nothing at all.
 */
export const RUNS_NOTHING_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Whether a path is the one-time page's: `/connect` itself or anything under `/connect/`. */
function isOneTimePagePath(pathname: string) {
  return (
    pathname === ONE_TIME_PAGE_PATH.slice(0, -1) ||
    pathname.startsWith(ONE_TIME_PAGE_PATH)
  );
}

/**
 * The one-time page's own policy (`docs/specs/one-time.md` -> "Phone page"):
 * scripts from `/connect/assets/` alone (plus WebAssembly for xterm's image
 * decoder), styles from there too plus inline ones for the shell and React,
 * and one socket — the rendezvous client route. Nothing names `'self'`, which
 * would admit whatever else the relay origin serves. Sandboxed, so it opens no
 * popup and submits no form.
 */
export function oneTimePagePolicy(appOrigin: string) {
  const page = `${appOrigin}${ONE_TIME_PAGE_PATH}`;
  return [
    "default-src 'none'",
    `script-src ${page}assets/ 'wasm-unsafe-eval'`,
    `style-src ${page}assets/ 'unsafe-inline'`,
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
 * Whether a relay path is Pocket's (`docs/specs/pocket-app.md` -> "Serving the
 * built bundle"): everything but the one-time page and the API and socket routes.
 */
export function isPocketPath(pathname: string) {
  return (
    !isOneTimePagePath(pathname) && !/^\/(?:api|ws)(?:\/|$)/.test(pathname)
  );
}

/**
 * The policy a relay response to `pathname` carries: the page's under
 * `/connect`, Pocket's on Pocket's paths, and one that runs nothing on the API
 * and socket routes. Both pages need `APP_ORIGIN`, and a value that is not
 * exactly an http(s) origin could write a directive of its own into the
 * header: the runs-nothing policy answers instead.
 */
export function relayPolicy(pathname: string, appOrigin: unknown) {
  const page = isOneTimePagePath(pathname);
  if (!page && !isPocketPath(pathname)) return RUNS_NOTHING_POLICY;
  if (
    !(
      typeof appOrigin === "string" &&
      /^https?:\/\/[a-z0-9.:[\]-]+$/i.test(appOrigin) &&
      URL.canParse(appOrigin) &&
      new URL(appOrigin).origin === appOrigin
    )
  )
    return RUNS_NOTHING_POLICY;
  return page
    ? oneTimePagePolicy(appOrigin)
    : pocketContentSecurityPolicy(appOrigin);
}

/** What a Worker's `secureHeaders` asks for each response's policy. */
export type PolicyFor = (pathname: string, appOrigin: unknown) => string;

/** Every response's `Permissions-Policy` but Pocket's: no camera, microphone, or location. */
export const NO_DEVICES_PERMISSIONS = "camera=(), microphone=(), geolocation=()";

/** Pocket's: the camera for its own origin, which its pairing-code scanner needs. */
export const POCKET_PERMISSIONS = "camera=(self), microphone=(), geolocation=()";

/** The relay's `Permissions-Policy` for `pathname`: the camera on Pocket's paths alone. */
export const relayPermissions = (pathname: string) =>
  isPocketPath(pathname) ? POCKET_PERMISSIONS : NO_DEVICES_PERMISSIONS;

/** The account frontend's content-hashed Vite output. */
export const ACCOUNT_HASHED_ASSETS = ["/assets/"];

/** Pocket's and the one-time page's content-hashed Vite output, on the relay. */
export const RELAY_HASHED_ASSETS = ["/assets/", `${ONE_TIME_PAGE_PATH}assets/`];

/** What a Worker's `secureHeaders` sets beyond each response's policy. */
export interface HeaderRules {
  policy: PolicyFor;
  /** Path prefixes of this Worker's content-hashed files, cached as immutable. */
  hashedAssets: readonly string[];
  /** Each response's `Permissions-Policy`; {@link NO_DEVICES_PERMISSIONS} without one. */
  permissions?: (pathname: string) => string;
  /**
   * Paths whose other responses may be stored if revalidated (`no-cache`)
   * rather than never stored: Pocket's shell and root files. Without one, `no-store`.
   */
  revalidated?: (pathname: string) => boolean;
}

// Applied to the HTML shell as well as APIs: auth's own middleware only covers its routes.
export function secureHeaders(
  app: Hono<any>,
  {
    policy,
    hashedAssets,
    permissions = () => NO_DEVICES_PERMISSIONS,
    revalidated = () => false,
  }: HeaderRules,
) {
  app.use("*", async (c, next) => {
    await next();
    // A WebSocket upgrade carries no document, and its headers are the runtime's.
    if (c.res.status === 101) return;
    const { pathname } = new URL(c.req.url);
    // Vite emits content-hashed files under this Worker's `hashedAssets`, so they are safe
    // to cache forever, but the SPA fallback answers an unknown /assets/ path with the HTML
    // shell: cache only a 200 whose type is not HTML, and leave everything else uncached.
    const asset =
      c.res.status === 200 &&
      hashedAssets.some((prefix) => pathname.startsWith(prefix)) &&
      !(c.res.headers.get("content-type") ?? "").includes("text/html");
    c.header(
      "Cache-Control",
      asset
        ? "public, max-age=31536000, immutable"
        : revalidated(pathname)
          ? "no-cache"
          : "no-store",
    );
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Permissions-Policy", permissions(pathname));
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Strict-Transport-Security", "max-age=31536000");
    // `c.env` is the mapped bindings once the mapper ran, and the raw ones if it threw.
    c.header("Content-Security-Policy", policy(pathname, c.env?.APP_ORIGIN));
  });
}
