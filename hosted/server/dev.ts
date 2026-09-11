import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createServer as createViteServer } from "vite";
import { createAuthApp } from "@pgstencil/auth/better-auth";
import { developmentDatabase } from "pgstencil/database";
import { EmailDev, SystemTime } from "pgstencil";
import { authPolicy } from "./policy";
import { migrations } from "./migrations";
import { allowedDevRequest } from "./dev-host-guard";

const port = Number(process.env.PORT ?? 5188);
const origin = `http://127.0.0.1:${port}`;
const email = new EmailDev(new SystemTime());
const auth = createAuthApp({
  ...authPolicy,
  databaseUrl: await developmentDatabase(true, migrations),
  origin,
  secret: "dormouse-hosted-local-development-only",
  email,
});
auth.app.get("/api/dev/emails", (c) =>
  c.json(email.all().map(({ to, text }) => ({ to, text }))),
);
const listener = getRequestListener((request) => auth.app.fetch(request));
const server = createServer((request, response) => {
  if (!allowedDevRequest(request, origin)) {
    response.writeHead(403).end("Local development origin required.");
    return;
  }
  if (request.url?.startsWith("/api/")) {
    void listener(request, response);
    return;
  }
  vite.middlewares(request, response, () => response.writeHead(404).end());
});
server.on("upgrade", (request, socket) => {
  if (!allowedDevRequest(request, origin)) socket.destroy();
});
const vite = await createViteServer({
  server: {
    middlewareMode: true,
    hmr: { server },
    cors: { origin },
    allowedHosts: ["127.0.0.1"],
  },
  appType: "spa",
});
server.listen(port, "127.0.0.1", () => {
  console.log(
    `Dormouse Hosted: ${origin}\nLocal email inbox: ${origin}/api/dev/emails\nEmail stays local; OAuth is disabled in this development entry.`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    server.close();
    await vite.close();
    await auth.close();
    email.close();
    process.exit(0);
  });
