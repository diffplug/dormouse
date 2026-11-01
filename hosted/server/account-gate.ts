// Rules: docs/specs/hosted.md -> "Managed voice" and "Burrow enrollment";
// docs/specs/security-hosted.md -> "Origin boundary".
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { queryDatabase } from "pgstencil/postgres";
import { entitled, isAdmin } from "./entitlement";
import { LOGIN_FRESH_AGE_MS } from "./policy-constants";

/** What one request's account deployment provides to its cookie routes. */
export interface AccountHost {
  databaseUrl: string;
  /** The Better Auth handler, asked for the cookie's login. */
  auth(request: Request): Response | Promise<Response>;
}

/** One query on `host`'s database, on a connection of its own. */
export const accountQuery = <Row extends Record<string, unknown>>(
  host: AccountHost,
  text: string,
  values: unknown[],
) => queryDatabase<Row>(host.databaseUrl, text, values);

/**
 * Whether the account's own page made this read: the browser says
 * `Sec-Fetch-Site: same-origin`, and an `Origin`, if presented, is exactly
 * `origin`. A sibling's page, a navigation, and a request without Fetch
 * Metadata all fail. {@link cookieEntitled}'s in-process login lookup vouches
 * for a request its gate admitted by carrying the header itself.
 */
export function ownPageRead(request: Request, origin: string): boolean {
  const presented = request.headers.get("origin");
  return (
    request.headers.get("sec-fetch-site") === "same-origin" &&
    (presented === null || presented === origin)
  );
}

/**
 * Whether `path` is an auth request another site's page may make: a
 * provider's callback, or the CSRF challenge. Every other auth request but a
 * POST (whose Origin and CSRF rules the packed adapter holds) must be
 * {@link ownPageRead}, so a read a later adapter adds is gated too.
 */
export const openAuthRead = (path: string) =>
  path === "/api/auth/csrf" || path.startsWith("/api/auth/callback/");

/** A cookie route's body cap: a larger body answers 413. */
export const smallBody = (maxSize: number) =>
  bodyLimit({ maxSize, onError: (c) => c.json({ message: "Request too large." }, 413) });

/** The login a cookie route acts for. */
export interface AccountLogin {
  userId: string;
  /**
   * `get-session`'s `session.createdAt`, unparsed: only a route that needs a
   * recent login reads it, and it fails closed on a value it cannot read.
   */
  createdAt: unknown;
  /** The account's verified email, or null for a provider-only account without one. */
  email: string | null;
}

/**
 * Whether `login` began within `LOGIN_FRESH_AGE_MS`, for a route that needs
 * a recent login. Fails closed: a creation time missing or unreadable is not
 * recent.
 */
export const isRecentLogin = (login: AccountLogin) =>
  Date.now() - Date.parse(String(login.createdAt)) < LOGIN_FRESH_AGE_MS;

/**
 * The account Worker's cookie routes' gate: a read is {@link ownPageRead},
 * and a state-changing request presents exactly this `Origin` — same-site
 * pages, the relay and voice origins among them, share the login cookie —
 * then the Better Auth handler's `get-session` answers the login (401
 * without one), and only an entitled account passes, read per request
 * (`refuse` answers anyone else). Sets `login`.
 */
export function cookieEntitled(
  host: (c: Context) => AccountHost,
  refuse: (c: Context) => Response,
): MiddlewareHandler<{ Variables: { login: AccountLogin } }> {
  return cookieGate(host, { admits: entitled, refuse });
}

/** {@link cookieEntitled}'s gate for a route any signed-in account may use. */
export function cookieLogin(
  host: (c: Context) => AccountHost,
): MiddlewareHandler<{ Variables: { login: AccountLogin } }> {
  return cookieGate(host);
}

/**
 * {@link cookieEntitled}'s gate for the admin's own routes: any login but
 * the admin's (`isAdmin`, read per request) answers 404, as if the route
 * were not there.
 */
export function cookieAdmin(
  host: (c: Context) => AccountHost,
): MiddlewareHandler<{ Variables: { login: AccountLogin } }> {
  return cookieGate(host, { admits: isAdmin, refuse: (c) => c.json({ message: "Not found." }, 404) });
}

function cookieGate(
  host: (c: Context) => AccountHost,
  only?: {
    admits: (databaseUrl: string, userId: string) => Promise<boolean>;
    refuse: (c: Context) => Response;
  },
): MiddlewareHandler<{ Variables: { login: AccountLogin } }> {
  return async (c, next) => {
    const origin = new URL(c.req.url).origin;
    const read = c.req.method === "GET" || c.req.method === "HEAD";
    if (read ? !ownPageRead(c.req.raw, origin) : c.req.header("origin") !== origin)
      return c.json({ message: "Invalid origin." }, 403);
    // This request passed the gate above, so its lookup is the account's own
    // read: `prelaunchAuth` refuses a login read that does not say so.
    const headers = new Headers({ "sec-fetch-site": "same-origin" });
    for (const name of ["cookie", "cf-connecting-ip"]) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    const response = await host(c).auth(
      new Request(new URL("/api/auth/get-session", origin), { headers }),
    );
    if (!response.ok) throw new Error("Login lookup failed");
    const session = (await response.json()) as {
      user?: { id: string; email?: unknown; emailVerified?: unknown };
      session?: { createdAt?: unknown };
    } | null;
    if (!session?.user) return c.json({ message: "Sign in first." }, 401);
    if (only && !(await only.admits(host(c).databaseUrl, session.user.id))) return only.refuse(c);
    c.set("login", {
      userId: session.user.id,
      createdAt: session.session?.createdAt,
      email:
        session.user.emailVerified === true && typeof session.user.email === "string" ? session.user.email : null,
    });
    await next();
  };
}
