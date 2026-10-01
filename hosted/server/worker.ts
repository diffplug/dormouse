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
  ELEVENLABS_API_KEY?: string;
  OAUTH_PROVIDERS?: string;
  BUILD_SHA?: string;
  ONE_TIME_ROOM: DurableObjectNamespace;
  ONE_TIME_MINT_LIMIT: RateLimit;
  ONE_TIME_JOIN_LIMIT: RateLimit;
}

const auth = createBetterAuthWorker<Env>({
  ...authPolicy,
  email: (env) => postmarkEmail(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM),
});
/** `sweepDelayMs` exists for the test entry; production keeps the default. */
export function hostedWorker({ sweepDelayMs }: { sweepDelayMs?: number } = {}) {
  return workerApp(
    (request, env, ctx) => auth.fetch(request, env, ctx),
    // A rejected allowlist throws inside the request path, where app.onError
    // answers it, and fails the cron run.
    (env) => ({
      HYPERDRIVE: env.HYPERDRIVE,
      ASSETS: env.ASSETS,
      APP_ORIGIN: env.APP_ORIGIN,
      AUTH_SECRET: env.AUTH_SECRET,
      EMAIL_FROM: env.EMAIL_FROM,
      POSTMARK_SERVER_TOKEN: env.POSTMARK_SERVER_TOKEN,
      ELEVENLABS_API_KEY: env.ELEVENLABS_API_KEY,
      BUILD_SHA: env.BUILD_SHA,
      ONE_TIME_ROOM: env.ONE_TIME_ROOM,
      ONE_TIME_MINT_LIMIT: env.ONE_TIME_MINT_LIMIT,
      ONE_TIME_JOIN_LIMIT: env.ONE_TIME_JOIN_LIMIT,
      ...providerBindings(env as unknown as Record<string, unknown>),
    }),
    { sweepDelayMs },
  );
}

export { OneTimeRoom } from "./one-time-room";

export default hostedWorker();
