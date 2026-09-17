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
const app = workerApp(
  (request, env, ctx) => auth.fetch(request, env, ctx),
  // A rejected allowlist throws inside the request path, so app.onError answers it.
  (env) => ({
    HYPERDRIVE: env.HYPERDRIVE,
    ASSETS: env.ASSETS,
    APP_ORIGIN: env.APP_ORIGIN,
    AUTH_SECRET: env.AUTH_SECRET,
    EMAIL_FROM: env.EMAIL_FROM,
    POSTMARK_SERVER_TOKEN: env.POSTMARK_SERVER_TOKEN,
    BUILD_SHA: env.BUILD_SHA,
    ...providerBindings(env as unknown as Record<string, unknown>),
  }),
);

export default {
  fetch(request: Request, env: Env, ctx: Parameters<typeof app.fetch>[2]) {
    return app.fetch(request, env, ctx);
  },
};
