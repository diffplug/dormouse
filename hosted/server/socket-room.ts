// What the relay Worker's two socket families share: the one-time rendezvous
// (`one-time.ts`, `one-time-room.ts`) and the relay sockets (`relay-sockets.ts`,
// `relay-room.ts`). Each route checks its request, then hands its Durable
// Object a fresh upgrade; each object refuses by closing an accepted socket.
import type { Context } from "hono";

/** `WebSocket.OPEN`. */
export const OPEN = 1;

/** Whether the request asks for a WebSocket upgrade. */
export function isUpgrade(c: Context): boolean {
  return c.req.raw.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** The 426 a socket route answers a plain request with, under its family's error key. */
export function upgradeRequired(c: Context, key: "error" | "message"): Response {
  return c.json({ [key]: "WebSocket upgrade required." }, 426);
}

/**
 * A fresh request carrying only the upgrade and `params`, so no header,
 * token, cookie, or address of the caller's reaches the object.
 */
export function forwardUpgrade(
  stub: { fetch(request: Request): Promise<Response> },
  url: URL,
  params: Record<string, string>,
): Promise<Response> {
  const target = new URL(url);
  target.search = "";
  for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
  return stub.fetch(new Request(target, { headers: { upgrade: "websocket" } }));
}

/**
 * Accept-then-close, so the refused end reads a code rather than a failed
 * upgrade. Accepted outside hibernation: the socket is never the object's, so
 * none of its events reach the object's handlers.
 */
export function refuseSocket(code: number, reason: string): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}
