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
 * relay origin's under its non-page prefixes. It runs nothing at all.
 */
export const RUNS_NOTHING_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Every response's `Permissions-Policy` but Pocket's: no camera, microphone, or location. */
export const NO_DEVICES_PERMISSIONS = "camera=(), microphone=(), geolocation=()";

/** Pocket's: the camera for its own origin, which its pairing-code scanner needs. */
export const POCKET_PERMISSIONS = "camera=(self), microphone=(), geolocation=()";

/**
 * The relay's prefixes that serve no page: each answers its own routes and
 * otherwise 404s (`workerApp`'s tails), never Pocket's shell.
 */
export const RELAY_NON_PAGE_PREFIXES = ["/api", "/ws"] as const;

/**
 * A response's caching: `immutable` for a content-hashed file (a 200 that is
 * not HTML; anything else there is `no-store`), `no-cache` to store only if
 * revalidated, `no-store` to never store.
 */
export type CacheClass = "immutable" | "no-cache" | "no-store";

/** What `secureHeaders` sets per path beyond the headers every response carries. */
export interface PathRules {
  policy: string;
  permissions: string;
  cache: CacheClass;
}

/** A Worker's rules for a request: its decoded path, as Hono routes on it, and `APP_ORIGIN`. */
export type RulesFor = (path: string, appOrigin: unknown) => PathRules;

const under = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

/** The account's: its policy everywhere, its Vite output under `/assets/` immutable. */
export const accountRules: RulesFor = (path) => ({
  policy: ACCOUNT_POLICY,
  permissions: NO_DEVICES_PERMISSIONS,
  cache: path.startsWith("/assets/") ? "immutable" : "no-store",
});

/** A response that is no page: the voice origin's, and the relay's non-page prefixes. */
export const NO_PAGE_RULES: PathRules = {
  policy: RUNS_NOTHING_POLICY,
  permissions: NO_DEVICES_PERMISSIONS,
  cache: "no-store",
};

/**
 * Which of the relay's three kinds a path is: the one-time page (`/connect`
 * and under `/connect/`), a non-page prefix, or Pocket's
 * (`docs/specs/pocket-app.md` -> "Serving the built bundle") — every other path.
 */
export function relayPathKind(path: string): "connect" | "api" | "pocket" {
  if (under(path, ONE_TIME_PAGE_PATH.slice(0, -1))) return "connect";
  if (RELAY_NON_PAGE_PREFIXES.some((prefix) => under(path, prefix))) return "api";
  return "pocket";
}

/**
 * The relay's rules: the page's policy under `/connect`, Pocket's (with the
 * camera) on Pocket's paths, and the runs-nothing policy on the non-page
 * prefixes. Both pages need `APP_ORIGIN`, and a value that is not exactly an
 * http(s) origin could write a directive of its own into the header: the
 * runs-nothing policy answers instead.
 */
export const relayRules: RulesFor = (path, appOrigin) => {
  const kind = relayPathKind(path);
  if (kind === "api") return NO_PAGE_RULES;
  const origin = exactOrigin(appOrigin);
  return kind === "connect"
    ? {
        policy: origin ? oneTimePagePolicy(origin) : RUNS_NOTHING_POLICY,
        permissions: NO_DEVICES_PERMISSIONS,
        cache: path.startsWith(`${ONE_TIME_PAGE_PATH}assets/`) ? "immutable" : "no-store",
      }
    : {
        policy: origin ? pocketContentSecurityPolicy(origin) : RUNS_NOTHING_POLICY,
        permissions: POCKET_PERMISSIONS,
        cache: path.startsWith("/assets/") ? "immutable" : "no-cache",
      };
};

/** `value` when it is exactly an http(s) origin, else null. */
export function exactOrigin(value: unknown): string | null {
  return typeof value === "string" &&
    /^https?:\/\/[a-z0-9.:[\]-]+$/i.test(value) &&
    URL.canParse(value) &&
    new URL(value).origin === value
    ? value
    : null;
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

// Applied to the HTML shell as well as APIs: auth's own middleware only covers its routes.
export function secureHeaders(app: Hono<any>, rulesFor: RulesFor) {
  app.use("*", async (c, next) => {
    await next();
    // A WebSocket upgrade carries no document, and its headers are the runtime's.
    if (c.res.status === 101) return;
    // The decoded path Hono routes on, so `/%63onnect/` is classified as the
    // `/connect/` route that answers it. `c.env` is the mapped bindings once the
    // mapper ran, and the raw ones if it threw.
    const { policy, permissions, cache } = rulesFor(c.req.path, c.env?.APP_ORIGIN);
    // The SPA fallback can answer a hashed path with HTML: only a 200 that is not
    // HTML is a content-hashed file, cached forever.
    const asset =
      cache === "immutable" &&
      c.res.status === 200 &&
      !(c.res.headers.get("content-type") ?? "").includes("text/html");
    c.header(
      "Cache-Control",
      asset ? "public, max-age=31536000, immutable" : cache === "no-cache" ? "no-cache" : "no-store",
    );
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Permissions-Policy", permissions);
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Strict-Transport-Security", "max-age=31536000");
    c.header("Content-Security-Policy", policy);
  });
}
