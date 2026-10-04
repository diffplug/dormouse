import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { createAuthApp } from "@pgstencil/auth/better-auth";
import { developmentDatabase } from "pgstencil/database";
import { EmailDev, SecureRandom, SystemTime } from "pgstencil";
import { adminRoutes } from "./admin";
import { stripeDevBilling } from "./billing-dev";
import { BILLING_WEBHOOK_PATH, billingRoutes } from "./billing-routes";
import { authPolicy } from "./policy";
import { migrations } from "./migrations";
import { allowedDevRequest } from "./dev-host-guard";
import { recordLogin } from "./account-gate";
import { relayAccountRoutes, type RelayAccountHost } from "./relay-account";
import { voiceTokenRoutes } from "./voice";

// Bind first, then derive the origin from the port actually bound, so an unset
// PORT runs beside another checkout's server. `localhost`, not `127.0.0.1`: it
// is the host Dor Tools and `dor agent-browser open surface:N` put in the URL.
let ready:
  | {
      origin: string;
      listener: ReturnType<typeof getRequestListener>;
      vite: ViteDevServer;
    }
  | undefined;
const server = createServer((request, response) => {
  if (!ready) {
    response.writeHead(503).end("Starting.");
    return;
  }
  if (!allowedDevRequest(request, ready.origin)) {
    response.writeHead(403).end("Local development origin required.");
    return;
  }
  if (request.url?.startsWith("/api/")) {
    void ready.listener(request, response);
    return;
  }
  ready.vite.middlewares(request, response, () =>
    response.writeHead(404).end(),
  );
});
server.on("upgrade", (request, socket) => {
  if (!ready || !allowedDevRequest(request, ready.origin)) socket.destroy();
});
server.listen(Number(process.env.PORT || 0), "127.0.0.1");
await once(server, "listening");
const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

const email = new EmailDev(new SystemTime());
const databaseUrl = await developmentDatabase(true, migrations);
const auth = createAuthApp({
  ...authPolicy,
  databaseUrl,
  origin,
  secret: "dormouse-hosted-local-development-only",
  email,
});
auth.app.get("/api/dev/emails", (c) =>
  c.json(email.all().map(({ to, text }) => ({ to, text }))),
);
const app = new Hono();
// Built once, so the approval limiter counts across requests.
const host: RelayAccountHost = {
  databaseUrl,
  auth: (request: Request) => auth.app.fetch(request),
  approveLimit: devLimit(10),
  // No relay runs here, so no Burrow holds a socket to close.
  closeBurrow: async () => {},
};
voiceTokenRoutes(app, () => host);
relayAccountRoutes(app, () => host);
// Billing against StripeDev, its state beside the development database.
const { dev: stripeDev, setup: billing } = await stripeDevBilling(
  new SystemTime(),
  new SecureRandom(),
  fileURLToPath(new URL("../.pgstencil/stripe-dev.json", import.meta.url)),
);
stripeDev.setWebhookTarget(origin + BILLING_WEBHOOK_PATH);
const billingHost = () => ({ ...host, setup: () => billing });
billingRoutes(app, billingHost);
adminRoutes(app, billingHost);
// No speak: a Hosted build speaks only at the fixed voice origin, so no
// Dormouse build could reach one here.
app.all("*", async (c) => {
  const response = await auth.app.fetch(c.req.raw);
  recordLogin(c, host, c.req.raw, response);
  return response;
});
const vite = await createViteServer({
  server: {
    middlewareMode: true,
    hmr: { server },
    cors: { origin },
    allowedHosts: ["localhost"],
  },
  appType: "spa",
});
ready = {
  origin,
  listener: getRequestListener((request) => app.fetch(request)),
  vite,
};
console.log(
  `Dormouse Hosted: ${origin}\nLocal email inbox: ${origin}/api/dev/emails\nEmail stays local; OAuth is disabled in this development entry.\nCheckout: ${origin}/checkout?plan=founding (StripeDev at ${stripeDev.origin}; no card, no charge)`,
);
/** A `ratelimits` binding's stand-in: `perMinute` per key per wall-clock minute. */
function devLimit(perMinute: number): RateLimit {
  const counts = new Map<string, number>();
  let minute = 0;
  return {
    async limit({ key }) {
      const now = Math.floor(Date.now() / 60_000);
      if (now !== minute) {
        minute = now;
        counts.clear();
      }
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= perMinute };
    },
  };
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    server.close();
    await vite.close();
    await auth.close();
    await stripeDev.close();
    email.close();
    process.exit(0);
  });
