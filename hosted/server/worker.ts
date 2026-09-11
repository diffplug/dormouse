import {
  createBetterAuthWorker,
  type BetterAuthWorkerBindings,
} from "@pgstencil/auth/better-auth-workers";
import { postmarkEmail } from "@pgstencil/auth/postmark";
import { authPolicy, providerBindings } from "./policy";
import { workerApp } from "./worker-app";

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
const app = workerApp((request, env, ctx) => auth.fetch(request, env, ctx));

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
