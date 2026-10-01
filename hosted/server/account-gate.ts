// Rules: docs/specs/hosted.md -> "Managed voice" and "Burrow enrollment";
// docs/specs/security-hosted.md -> "Origin boundary".
import type { Context, MiddlewareHandler } from "hono";
import { isAdmin } from "./admin";

/** The login a cookie route acts for. */
export interface AccountLogin {
  userId: string;
  /** When this login was created, epoch ms: how recent it is. */
  createdAt: number;
}

/**
 * The account Worker's cookie routes' gate: a state-changing request carries
 * exactly this origin — same-site pages, the relay and voice origins among
 * them, share the login cookie — then the Better Auth handler's `get-session`
 * answers the login (401 without one), and only the verified admin passes
 * (`refuse` answers anyone else). Sets `login`.
 */
export function cookieAdmin(
  auth: (c: Context) => (request: Request) => Response | Promise<Response>,
  refuse: (c: Context) => Response,
): MiddlewareHandler<{ Variables: { login: AccountLogin } }> {
  return async (c, next) => {
    const origin = new URL(c.req.url).origin;
    if (
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      c.req.header("origin") !== origin
    )
      return c.json({ message: "Invalid origin." }, 403);
    const headers = new Headers();
    for (const name of ["cookie", "cf-connecting-ip"]) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    const response = await auth(c)(
      new Request(new URL("/api/auth/get-session", origin), { headers }),
    );
    if (!response.ok) throw new Error("Login lookup failed");
    const session = (await response.json()) as {
      user?: { id: string; email?: unknown; emailVerified?: unknown };
      session?: { createdAt?: unknown };
    } | null;
    if (!session?.user) return c.json({ message: "Sign in first." }, 401);
    if (!isAdmin(session.user)) return refuse(c);
    const createdAt = Date.parse(String(session.session?.createdAt));
    if (!Number.isFinite(createdAt)) throw new Error("Login has no creation time");
    c.set("login", { userId: session.user.id, createdAt });
    await next();
  };
}
