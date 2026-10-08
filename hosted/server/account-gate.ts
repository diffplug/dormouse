// Rules: docs/specs/hosted.md -> "Managed voice" and "Burrow enrollment";
// docs/specs/security-hosted.md -> "Origin boundary".
import type { Context, MiddlewareHandler } from "hono";
import { queryDatabase } from "pgstencil/postgres";
import { isAdmin } from "./admin";

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

/** The login a cookie route acts for. */
export interface AccountLogin {
  userId: string;
  /**
   * `get-session`'s `session.createdAt`, unparsed: only a route that needs a
   * recent login reads it, and it fails closed on a value it cannot read.
   */
  createdAt: unknown;
}

/**
 * The account Worker's cookie routes' gate: a presented `Origin` is exactly
 * this origin, and a state-changing request must present one — same-site
 * pages, the relay and voice origins among them, share the login cookie —
 * then the Better Auth handler's `get-session` answers the login (401
 * without one), and only the verified admin passes (`refuse` answers anyone
 * else). Sets `login`.
 */
export function cookieAdmin(
  host: (c: Context) => AccountHost,
  refuse: (c: Context) => Response,
): MiddlewareHandler<{ Variables: { login: AccountLogin } }> {
  return cookieGate(host, refuse);
}

/** {@link cookieAdmin}'s gate for a route any signed-in account may use. */
export function cookieLogin(
  host: (c: Context) => AccountHost,
): MiddlewareHandler<{ Variables: { login: AccountLogin } }> {
  return cookieGate(host);
}

function cookieGate(
  host: (c: Context) => AccountHost,
  refuse?: (c: Context) => Response,
): MiddlewareHandler<{ Variables: { login: AccountLogin } }> {
  return async (c, next) => {
    const origin = new URL(c.req.url).origin;
    const presented = c.req.header("origin");
    // A read may omit `Origin`; nothing may present a foreign one.
    const safe = c.req.method === "GET" || c.req.method === "HEAD";
    if (presented === undefined ? !safe : presented !== origin)
      return c.json({ message: "Invalid origin." }, 403);
    const headers = new Headers();
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
    if (refuse && !isAdmin(session.user)) return refuse(c);
    c.set("login", {
      userId: session.user.id,
      createdAt: session.session?.createdAt,
    });
    await next();
  };
}
