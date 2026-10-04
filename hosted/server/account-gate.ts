// Rules: docs/specs/hosted.md -> "Managed voice", "Burrow enrollment", and
// "Billing"; docs/specs/security-hosted.md -> "Origin boundary".
import type { Context, MiddlewareHandler } from "hono";
import { queryDatabase } from "pgstencil/postgres";
import { entitled } from "./entitlement";

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
  /** The account's public email, null for a provider-only account. */
  email: string | null;
  /**
   * `get-session`'s `session.createdAt`, unparsed: only a route that needs a
   * recent login reads it, and it fails closed on a value it cannot read.
   */
  createdAt: unknown;
}

type Gate = MiddlewareHandler<{ Variables: { login: AccountLogin } }>;

/**
 * A presented `Origin` is exactly this origin, and a state-changing request
 * must present one — same-site pages, the relay and voice origins among
 * them, share the login cookie — then the Better Auth handler's
 * `get-session` answers the login: the login, or the refusal to send.
 */
async function login(c: Context, host: AccountHost): Promise<AccountLogin | Response> {
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
  const response = await host.auth(
    new Request(new URL("/api/auth/get-session", origin), { headers }),
  );
  if (!response.ok) throw new Error("Login lookup failed");
  const session = (await response.json()) as {
    user?: { id: string; email?: unknown };
    session?: { createdAt?: unknown };
  } | null;
  if (!session?.user) return c.json({ message: "Sign in first." }, 401);
  return {
    userId: session.user.id,
    email: typeof session.user.email === "string" ? session.user.email : null,
    createdAt: session.session?.createdAt,
  };
}

/**
 * The account Worker's gate for a cookie route any signed-in account may use
 * (billing): the origin and login checks, 401 without a login. Sets `login`.
 */
export function cookieLogin(host: (c: Context) => AccountHost): Gate {
  return async (c, next) => {
    const result = await login(c, host(c));
    if (result instanceof Response) return result;
    c.set("login", result);
    await next();
  };
}

/**
 * The account Worker's gate for an entitled account's cookie routes: the
 * origin and login checks, then only an entitled account passes, read per
 * request (`refuse` answers anyone else). Sets `login`.
 */
export function cookieEntitled(
  host: (c: Context) => AccountHost,
  refuse: (c: Context) => Response,
): Gate {
  return async (c, next) => {
    const result = await login(c, host(c));
    if (result instanceof Response) return result;
    if (!(await entitled(host(c).databaseUrl, result.userId))) return refuse(c);
    c.set("login", result);
    await next();
  };
}
