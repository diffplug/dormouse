import { spawn } from "node:child_process";
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
import { stripeDevBilling } from "./billing-dev";
import { BILLING_WEBHOOK_PATH, billingRoutes, type BillingHost } from "./billing-routes";
import { closureRoutes, type ClosureHost } from "./closure";
import { authMetricHooks } from "./metrics";
import { authPolicy } from "./policy";
import { migrations } from "./migrations";
import { allowedDevRequest } from "./dev-host-guard";
import { relayAccountRoutes, type RelayAccountHost } from "./relay-account";
import { voiceAccountRoutes } from "./voice";

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
const port = (server.address() as AddressInfo).port;
const origin = `http://localhost:${port}`;

const email = new EmailDev(new SystemTime());
const databaseUrl = await developmentDatabase(true, migrations);
const auth = createAuthApp({
  ...authPolicy,
  databaseUrl,
  origin,
  secret: "dormouse-hosted-local-development-only",
  email,
  hooks: authMetricHooks(databaseUrl),
});
auth.app.get("/api/dev/emails", (c) =>
  c.json(email.all().map(({ to, text }) => ({ to, text }))),
);
// StripeDev in place of Stripe, so checkout runs end to end without a card or
// a charge. Its state sits beside the development database's, which outlives
// a restart, and its webhook comes back through this server.
const stripe = await stripeDevBilling(
  new SystemTime(),
  new SecureRandom(),
  fileURLToPath(new URL("../.pgstencil/stripe-dev.json", import.meta.url)),
);
stripe.dev.setWebhookTarget(origin + BILLING_WEBHOOK_PATH);
const app = new Hono();
// Built once, so the approval limiter counts across requests.
const host: RelayAccountHost & BillingHost & ClosureHost = {
  databaseUrl,
  auth: (request: Request) => auth.app.fetch(request),
  approveLimit: devLimit(10),
  // The relay Worker runs in its own process (below), out of reach, so a
  // removed Burrow's held socket closes only at its RelayRoom's next sweep
  // (`RELAY_ROOM_SWEEP_MS`); its reconnect is refused at once.
  closeBurrow: async () => {},
  setup: () => stripe.setup,
  // A withdrawal's acknowledgement lands in the local inbox beside sign-in codes.
  mail: () => email,
};
voiceAccountRoutes(app, () => host);
relayAccountRoutes(app, () => host);
billingRoutes(app, () => host);
closureRoutes(app, () => host);
// No speak: a Hosted build speaks only at the fixed voice origin, so no
// Dormouse build could reach one here.
app.all("*", (c) => auth.app.fetch(c.req.raw));
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
  `Dormouse Hosted: ${origin}\nLocal email inbox: ${origin}/api/dev/emails\nEmail stays local; OAuth is disabled in this development entry.\nCheckout runs on StripeDev at ${stripe.dev.origin}: no card, no charge.`,
);
// OSC 367 (docs/specs/dor-tool.md -> OSC 367): frame this origin, not the
// relay's port or Wrangler's inspector, which the same process tree binds.
process.stdout.write(
  `\u001b]367;serve;${JSON.stringify({ v: 1, port })}\u001b\\`,
);
// The relay Worker beside it, on this database and approving codes here, so
// a dev Burrow build enrolls by device code (docs/specs/hosted.md ->
// "Development and release"). At RELAY_PORT, else the one-time loop's fixed
// default, since the Burrow build bakes its origin.
let stopping = false;
const relay = spawn(
  process.execPath,
  [fileURLToPath(new URL("../scripts/dev-one-time.mjs", import.meta.url))],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: process.env.RELAY_PORT ?? "",
      HOSTED_DEV_ACCOUNT_ORIGIN: origin,
      HOSTED_DEV_DATABASE_URL: databaseUrl,
    },
  },
);
const relayExit = once(relay, "exit");
relay.on("exit", (code, signal) => {
  if (!stopping)
    console.error(
      `The relay Worker exited (${code ?? signal}); device-code enrollment is off until a restart. The account still serves.`,
    );
});
// A crash here must not orphan it.
process.on("exit", () => relay.kill("SIGTERM"));
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
    stopping = true;
    relay.kill("SIGTERM");
    server.close();
    await vite.close();
    await auth.close();
    email.close();
    await stripe.dev.close();
    await relayExit;
    process.exit(0);
  });
