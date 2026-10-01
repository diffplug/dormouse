import { createBetterAuthWorker } from "@pgstencil/auth/better-auth-workers";
import { accountApp } from "./account-app";
import { accountPreviewBindings, type AccountEnv } from "./bindings";
import { authPolicy } from "./policy";
import { postgresInbox, inboxPage, messagePage } from "./preview-inbox";

/** The account Worker's PR preview: mail lands in the preview database's inbox. */
const auth = createBetterAuthWorker<AccountEnv>({
  ...authPolicy,
  email: (env) => postgresInbox(env.HYPERDRIVE.connectionString),
});
export default accountApp(
  auth.fetch,
  accountPreviewBindings,
  (app) => {
    app.get("/api/dev/emails", async (c) =>
      c.json(await postgresInbox(c.env.HYPERDRIVE.connectionString).all()),
    );
    app.get("/dev/emails", async (c) =>
      c.html(
        inboxPage(await postgresInbox(c.env.HYPERDRIVE.connectionString).all()),
      ),
    );
    app.get("/dev/emails/:id", async (c) => {
      const id = c.req.param("id");
      if (!/^[1-9]\d{0,17}$/.test(id)) return c.notFound();
      const mail = await postgresInbox(c.env.HYPERDRIVE.connectionString).get(
        id,
      );
      return mail ? c.html(messagePage(mail)) : c.notFound();
    });
  },
);
