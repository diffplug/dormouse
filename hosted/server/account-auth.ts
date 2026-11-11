import { createBetterAuthWorker } from "@pgstencil/auth/better-auth-workers";
import { postmarkEmail } from "@pgstencil/auth/postmark";
import type { AccountEnv } from "./bindings";
import { authMetricHooks } from "./metrics";
import { authPolicy } from "./policy";

/** The account Worker's Better Auth handler, mailing through Postmark. */
export const auth = createBetterAuthWorker<AccountEnv>({
  ...authPolicy,
  email: (env) => postmarkEmail(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM),
  // Postmark sends from `EMAIL_FROM` whatever the message says; this makes the
  // message itself say so too.
  emailFrom: (env) => env.EMAIL_FROM,
  hooks: (env) => authMetricHooks(env.HYPERDRIVE.connectionString),
});
