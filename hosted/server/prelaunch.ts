// Rules: docs/specs/hosted.md -> "Identity and login". Delete at launch,
// with its use in ./worker.ts.
import type { ExecutionContext } from "hono";
import { queryDatabase } from "pgstencil/postgres";
import { ADMIN_EMAIL } from "./admin";
import type { AccountEnv } from "./bindings";

/** The only verified emails the production account Worker signs in. */
export const SIGN_IN_ALLOWLIST: readonly string[] = [
  ADMIN_EMAIL,
  "edgar.twigg@gmail.com",
];

/** Matches the frontend's pre-launch copy in `hosted/src/App.tsx`. */
export const PRELAUNCH_REFUSAL =
  "Coming soon, check out the devlog at nedshed.dev";

type FetchAuth = (
  request: Request,
  env: AccountEnv,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

const listed = (email: unknown) =>
  typeof email === "string" &&
  SIGN_IN_ALLOWLIST.includes(email.trim().toLowerCase());

/**
 * Wraps the Better Auth handler so only {@link SIGN_IN_ALLOWLIST} can hold a
 * login: a request naming any other email is refused before it can send a
 * code or create an account, and on a GET a login whose user is not a
 * verified listed email — a provider sign-in, or one made before the gate —
 * has every one of its user's logins deleted before the handler answers it
 * as signed out. Every read of a login is a GET: the frontend's
 * `get-session`, each cookie route's lookup (`./account-gate.ts`), and a
 * provider callback. The auth writes that take a login only end it or start
 * a callback, so they are left to the handler's Origin and CSRF refusals,
 * which must come before any database read.
 */
export function prelaunchAuth(fetchAuth: FetchAuth): FetchAuth {
  return async (request, env, ctx) => {
    if (request.method === "POST") {
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => null);
      if (
        body &&
        typeof body === "object" &&
        "email" in body &&
        !listed(body.email)
      )
        return Response.json({ message: PRELAUNCH_REFUSAL }, { status: 403 });
    }
    const cookie = request.headers.get("cookie");
    if (cookie && request.method === "GET") {
      const headers = new Headers({ cookie });
      const ip = request.headers.get("cf-connecting-ip");
      if (ip) headers.set("cf-connecting-ip", ip);
      const lookup = await fetchAuth(
        new Request(new URL("/api/auth/get-session", request.url), {
          headers,
        }),
        env,
        ctx,
      );
      if (!lookup.ok) throw new Error("Login lookup failed");
      const session = (await lookup.json()) as {
        user?: { id: string; email?: unknown; emailVerified?: unknown };
      } | null;
      const user = session?.user;
      if (user && !(user.emailVerified === true && listed(user.email)))
        await queryDatabase(
          env.HYPERDRIVE.connectionString,
          'DELETE FROM "session" WHERE "userId" = $1',
          [user.id],
        );
    }
    return fetchAuth(request, env, ctx);
  };
}
