import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { createAuthApp } from "@pgstencil/auth/better-auth";
import { developmentDatabase } from "pgstencil/database";
import { EmailDev, SystemTime } from "pgstencil";
import { authPolicy } from "./policy";
import { migrations } from "./migrations";
import { allowedDevRequest } from "./dev-host-guard";
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
voiceTokenRoutes(app, () => ({
  databaseUrl,
  auth: (request: Request) => auth.app.fetch(request),
}));
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
  `Dormouse Hosted: ${origin}\nLocal email inbox: ${origin}/api/dev/emails\nEmail stays local; OAuth is disabled in this development entry.`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    server.close();
    await vite.close();
    await auth.close();
    email.close();
    process.exit(0);
  });
