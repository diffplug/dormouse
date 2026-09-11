import { createBetterAuthWorker } from "@pgstencil/auth/better-auth-workers";
import { authPolicy } from "./policy";
import { workerApp } from "./worker-app";
import { postgresInbox, inboxPage, messagePage } from "./preview-inbox";
import type { Env } from "./worker";

const auth = createBetterAuthWorker<Env>({
  ...authPolicy,
  email: (env) => postgresInbox(env.HYPERDRIVE.connectionString),
});
const app = workerApp(
  (request, env, ctx) => auth.fetch(request, env, ctx),
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
export default {
  fetch(request: Request, env: Env, ctx: Parameters<typeof app.fetch>[2]) {
    // Ignore stale production/OAuth bindings on an existing preview Worker.
    return app.fetch(
      request,
      {
        HYPERDRIVE: env.HYPERDRIVE,
        ASSETS: env.ASSETS,
        APP_ORIGIN: env.APP_ORIGIN,
        AUTH_SECRET: env.AUTH_SECRET,
        BUILD_SHA: env.BUILD_SHA,
        EMAIL_FROM: "",
        POSTMARK_SERVER_TOKEN: "",
      },
      ctx,
    );
  },
};
