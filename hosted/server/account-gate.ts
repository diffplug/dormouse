// Rules: docs/specs/hosted.md -> "Managed voice", "Burrow enrollment", and
// "Billing"; docs/specs/security-hosted.md -> "Origin boundary".
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { queryDatabase } from "pgstencil/postgres";
import { entitled, isAdmin } from "./entitlement";
import { LOGIN_METHODS } from "./metric-labels";
import { bestEffort, countMetric } from "./metrics";

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

/** A body limit answering the account's JSON 413. */
export const jsonBodyLimit = (maxSize: number) =>
  bodyLimit({ maxSize, onError: (c) => c.json({ message: "Request too large." }, 413) });

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

/** `get-session`'s answer, as far as Hosted reads it. */
interface SessionAnswer {
  user?: { id: string; email?: unknown; createdAt?: unknown };
  session?: { createdAt?: unknown };
}

/**
 * The Better Auth handler's `get-session` for `cookie`, from `address`; null
 * without a login. A gate admitted the request first, so the lookup is the
 * account's own read: `prelaunchAuth` refuses a login read that does not say so.
 */
async function sessionOf(host: AccountHost, origin: string, cookie?: string, address?: string) {
  const headers = new Headers({ "sec-fetch-site": "same-origin" });
  if (cookie) headers.set("cookie", cookie);
  if (address) headers.set("cf-connecting-ip", address);
  const response = await host.auth(new Request(new URL("/api/auth/get-session", origin), { headers }));
  if (!response.ok) throw new Error("Login lookup failed");
  return (await response.json()) as SessionAnswer | null;
}

/** Which accounts a gate admits, read per request, and its answer to anyone else. */
interface Admission {
  admits: (databaseUrl: string, userId: string) => Promise<boolean>;
  refuse: (c: Context) => Response;
}

/**
 * The account Worker's cookie routes' gate: a read is {@link ownPageRead},
 * and a state-changing request presents exactly this `Origin` — same-site
 * pages, the relay and voice origins among them, share the login cookie —
 * then the Better Auth handler's `get-session` answers the login (401
 * without one), and with `admission` only an account it admits passes.
 * Sets `login`.
 */
function cookieGate(host: (c: Context) => AccountHost, admission?: Admission): Gate {
  return async (c, next) => {
    const origin = new URL(c.req.url).origin;
    const read = c.req.method === "GET" || c.req.method === "HEAD";
    if (read ? !ownPageRead(c.req.raw, origin) : c.req.header("origin") !== origin)
      return c.json({ message: "Invalid origin." }, 403);
    const session = await sessionOf(host(c), origin, c.req.header("cookie"), c.req.header("cf-connecting-ip"));
    if (!session?.user) return c.json({ message: "Sign in first." }, 401);
    if (admission && !(await admission.admits(host(c).databaseUrl, session.user.id)))
      return admission.refuse(c);
    c.set("login", {
      userId: session.user.id,
      email: typeof session.user.email === "string" ? session.user.email : null,
      createdAt: session.session?.createdAt,
    });
    await next();
  };
}

/** {@link cookieGate} for an entitled account's routes; `refuse` answers anyone else. */
export const cookieEntitled = (host: (c: Context) => AccountHost, refuse: (c: Context) => Response) =>
  cookieGate(host, { admits: entitled, refuse });

/** {@link cookieGate} for a route any signed-in account may use (billing, terms). */
export const cookieLogin = (host: (c: Context) => AccountHost) => cookieGate(host);

/**
 * {@link cookieGate} for the admin's routes: only the admin (`adminSql`)
 * passes; anyone else gets the API's 404, so the route does not announce
 * itself.
 */
export const cookieAdmin = (host: (c: Context) => AccountHost) =>
  cookieGate(host, { admits: isAdmin, refuse: (c) => c.json({ message: "Not found." }, 404) });

/** How soon after its account a login's session must start to count as the account's creation. */
export const NEW_ACCOUNT_MS = 10_000;

/**
 * The method an auth response just logged in with: an OAuth callback or the
 * emailed code that set a session cookie (as pgstencil's own
 * `auth.login.succeeded` reads it); null for anything else, linking a
 * provider included.
 */
export function loginMethod(request: Request, response: Response): string | null {
  if (response.status >= 400) return null;
  const path = new URL(request.url).pathname;
  const method =
    path === "/api/auth/sign-in/email-otp"
      ? "email"
      : path.startsWith("/api/auth/callback/")
        ? path.slice("/api/auth/callback/".length)
        : null;
  if (!method || !LOGIN_METHODS.includes(method)) return null;
  const session = response.headers
    .getSetCookie()
    .some((cookie) => cookie.includes(".session_token=") && !/max-age=0/i.test(cookie));
  return session ? method : null;
}

/**
 * Counts an auth response's login by method (docs/specs/hosted.md ->
 * "Metrics") and, when its session started with its account,
 * `account.created`: read back through `get-session` with the cookies it
 * set, after the response.
 */
export function recordLogin(c: Context, host: AccountHost, request: Request, response: Response) {
  const method = loginMethod(request, response);
  if (!method) return;
  const cookie = response.headers
    .getSetCookie()
    .map((set) => set.split(";")[0]!)
    .join("; ");
  bestEffort(
    c,
    "Login metrics",
    (async () => {
      await countMetric(host.databaseUrl, "login", method);
      const read = await sessionOf(host, new URL(request.url).origin, cookie, request.headers.get("cf-connecting-ip") ?? undefined);
      const gap = Date.parse(String(read?.session?.createdAt)) - Date.parse(String(read?.user?.createdAt));
      if (gap >= 0 && gap < NEW_ACCOUNT_MS) await countMetric(host.databaseUrl, "account.created");
    })(),
  );
}
