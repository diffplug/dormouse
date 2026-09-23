import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { createServer as createViteServer } from "vite";
import { createAuthApp } from "@pgstencil/auth/better-auth";
import { developmentDatabase } from "pgstencil/database";
import { EmailDev, SystemTime } from "pgstencil";
import { authPolicy } from "./policy";
import { migrations } from "./migrations";
import { allowedDevRequest } from "./dev-host-guard";
import { elevenLabs, voiceRoutes, type Synthesize } from "./voice";

const port = Number(process.env.PORT ?? 5188);
const origin = `http://127.0.0.1:${port}`;
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
// Development only: without a key, speak returns a quarter second of silent MP3
// (MPEG-1 Layer III, 128 kbps, 44.1 kHz; zeroed side info decodes as silence).
const silence: Synthesize = async () => {
  const frame = 417;
  const audio = new Uint8Array(frame * 10);
  for (let i = 0; i < audio.length; i += frame)
    audio.set([0xff, 0xfb, 0x90, 0x64], i);
  return new Response(audio, { headers: { "content-type": "audio/mpeg" } });
};
const upstream = process.env.ELEVENLABS_API_KEY
  ? elevenLabs(process.env.ELEVENLABS_API_KEY)
  : silence;
const app = new Hono();
voiceRoutes(app, {
  origin: () => origin,
  databaseUrl: () => databaseUrl,
  auth: (request) => auth.app.fetch(request),
  synthesize: () => upstream,
});
app.all("*", (c) => auth.app.fetch(c.req.raw));
const listener = getRequestListener((request) => app.fetch(request));
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
    `Dormouse Hosted: ${origin}\nLocal email inbox: ${origin}/api/dev/emails\nEmail stays local; OAuth is disabled in this development entry.\nManaged voice: ${process.env.ELEVENLABS_API_KEY ? "real ElevenLabs key" : "silent fake audio (ELEVENLABS_API_KEY unset)"}.`,
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
