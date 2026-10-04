import { createBetterAuthWorker } from "@pgstencil/auth/better-auth-workers";
import { postmarkEmail } from "@pgstencil/auth/postmark";
import { accountApp } from "./account-app";
import { SYSTEM_CLOCK, type Clock } from "./billing";
import { accountBindings, type AccountEnv } from "./bindings";
import { authPolicy } from "./policy";

const auth = createBetterAuthWorker<AccountEnv>({
  ...authPolicy,
  email: (env) => postmarkEmail(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM),
});

/** The account Worker on `clock`; a test entry supplies its own. */
export const accountWorker = (clock: Clock) => accountApp(auth.fetch, accountBindings, clock);

/** The account Worker, `dormouse-hosted` on `hosted.dormouse.sh`. */
export default accountWorker(SYSTEM_CLOCK);
