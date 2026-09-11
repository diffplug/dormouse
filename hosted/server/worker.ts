import { Hono } from "hono";
import {
  createBetterAuthWorker,
  type BetterAuthWorkerBindings,
} from "@pgstencil/auth/better-auth-workers";
import { postmarkEmail } from "@pgstencil/auth/postmark";
import { queryDatabase } from "pgstencil/postgres";
import { authPolicy, providerBindings } from "./policy";
import { secureHeaders } from "./headers";

export interface Env extends BetterAuthWorkerBindings {
  ASSETS: { fetch(request: Request): Promise<Response> };
  EMAIL_FROM: string;
  POSTMARK_SERVER_TOKEN: string;
  OAUTH_PROVIDERS?: string;
  BUILD_SHA?: string;
}

const auth = createBetterAuthWorker<Env>({
  ...authPolicy,
  email: (env) => postmarkEmail(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM),
});
const app = new Hono<{ Bindings: Env }>();
secureHeaders(app);
app.use("*", async (c, next) => {
  // A candidate/preview hostname must never act as an alias for production auth.
  if (new URL(c.req.url).origin !== c.env.APP_ORIGIN)
    return c.json({ message: "Unknown origin." }, 421);
  await next();
});
app.get("/api/health", (c) =>
  c.json({ ok: true, revision: c.env.BUILD_SHA ?? null }),
);
app.get("/api/ready", async (c) => {
  const ok = await queryDatabase(
    c.env.HYPERDRIVE.connectionString,
    'SELECT "singleSession", "emailAuthenticated" FROM "session" LIMIT 0',
  ).then(
    () => true,
    () => false,
  );
  return c.json({ ok }, ok ? 200 : 503);
});
app.all("/api/auth/*", (c) => auth.fetch(c.req.raw, c.env, c.executionCtx));
app.get("/api/providers", (c) => auth.fetch(c.req.raw, c.env, c.executionCtx));
app.all("/api/*", (c) => c.json({ message: "Not found." }, 404));
app.all("/dev/*", (c) => c.notFound());
app.all("/__test/*", (c) => c.notFound());
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((_error, c) =>
  c.json(
    { message: "Sign-in is temporarily unavailable. Please try again." },
    503,
  ),
);

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: Parameters<typeof app.fetch>[2],
  ) {
    try {
      return await app.fetch(
        request,
        {
          HYPERDRIVE: env.HYPERDRIVE,
          ASSETS: env.ASSETS,
          APP_ORIGIN: env.APP_ORIGIN,
          AUTH_SECRET: env.AUTH_SECRET,
          EMAIL_FROM: env.EMAIL_FROM,
          POSTMARK_SERVER_TOKEN: env.POSTMARK_SERVER_TOKEN,
          BUILD_SHA: env.BUILD_SHA,
          ...providerBindings(env as unknown as Record<string, unknown>),
        },
        ctx,
      );
    } catch {
      return new Response(
        JSON.stringify({
          message: "Sign-in is temporarily unavailable. Please try again.",
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        },
      );
    }
  },
};
