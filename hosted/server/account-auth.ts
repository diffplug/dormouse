import { createBetterAuthWorker } from "@pgstencil/auth/better-auth-workers";
import { postmarkEmail } from "@pgstencil/auth/postmark";
import type { AccountEnv } from "./bindings";
import { authPolicy } from "./policy";

/** The account Worker's Better Auth handler, mailing through Postmark. */
export const auth = createBetterAuthWorker<AccountEnv>({
  ...authPolicy,
  email: (env) => postmarkEmail(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM),
});
