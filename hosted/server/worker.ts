import { createBetterAuthWorker } from "@pgstencil/auth/better-auth-workers";
import { postmarkEmail } from "@pgstencil/auth/postmark";
import { accountApp } from "./account-app";
import { accountBindings, type AccountEnv } from "./bindings";
import { authPolicy } from "./policy";

/** The account Worker, `dormouse-hosted` on `hosted.dormouse.sh`. */
const auth = createBetterAuthWorker<AccountEnv>({
  ...authPolicy,
  email: (env) => postmarkEmail(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM),
});

export default accountApp(auth.fetch, accountBindings);
