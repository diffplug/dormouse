import type { Context, Hono } from "hono";
import {
  E2E_ID_BYTE_LENGTH,
  isE2eId,
  ONE_TIME_PAGE_PATH,
  ONE_TIME_ROOM_PARAM,
  ONE_TIME_WS_ROUTES,
  toBase64Url,
} from "remote-lib-common";
import type { Env } from "./worker";

type OneTimeContext = Context<{ Bindings: Env }>;

/**
 * The one-time rendezvous routes (`docs/specs/one-time.md` -> "Hosted
 * rendezvous"). Each checks the request, then hands a bare upgrade to the
 * room's Durable Object; neither reads a cookie, reaches Hyperdrive, or asks
 * auth anything.
 */
export function oneTimeRoutes(app: Hono<{ Bindings: Env }>) {
  app.get(ONE_TIME_WS_ROUTES.burrow, async (c) => {
    if (!upgrade(c)) return upgradeRequired(c);
    // Every browser sends Origin on a WebSocket handshake and the Burrow's
    // native socket sends none, so refusing any Origin keeps web pages from
    // minting rooms.
    if (c.req.raw.headers.has("origin"))
      return c.json({ message: "Forbidden." }, 403);
    if (!(await allowed(c, c.env.ONE_TIME_MINT_LIMIT))) return tooMany(c);
    const room = toBase64Url(
      crypto.getRandomValues(new Uint8Array(E2E_ID_BYTE_LENGTH)),
    );
    return forward(c, ONE_TIME_WS_ROUTES.burrow, room);
  });
  app.get(ONE_TIME_WS_ROUTES.client, async (c) => {
    if (!upgrade(c)) return upgradeRequired(c);
    if (c.req.raw.headers.get("origin") !== c.env.APP_ORIGIN)
      return c.json({ message: "Forbidden." }, 403);
    const rooms = new URL(c.req.url).searchParams.getAll(ONE_TIME_ROOM_PARAM);
    const room = rooms.length === 1 ? rooms[0] : undefined;
    if (!isE2eId(room)) return c.json({ message: "Unknown room." }, 400);
    if (!(await allowed(c, c.env.ONE_TIME_JOIN_LIMIT))) return tooMany(c);
    return forward(c, ONE_TIME_WS_ROUTES.client, room);
  });
}

/**
 * The one-time phone page (`docs/specs/one-time.md` -> "Phone page"), staged
 * into the assets under `/connect/`: its shell and its content-hashed assets,
 * and nothing else under the path, so the SPA fallback never answers there.
 * Mounted ahead of that fallback.
 */
export function oneTimePageRoutes(app: Hono<{ Bindings: Env }>) {
  const assets = (c: OneTimeContext) => c.env.ASSETS.fetch(c.req.raw);
  app.get(ONE_TIME_PAGE_PATH.slice(0, -1), assets);
  app.get(ONE_TIME_PAGE_PATH, assets);
  app.get(`${ONE_TIME_PAGE_PATH}assets/*`, async (c) => {
    const response = await assets(c);
    // A missing file comes back as the SPA fallback's shell, which is never an
    // answer to a script or stylesheet request.
    return (response.headers.get("content-type") ?? "").includes("text/html")
      ? c.notFound()
      : response;
  });
  app.get(`${ONE_TIME_PAGE_PATH}*`, (c) => c.notFound());
}

function upgrade(c: OneTimeContext) {
  return c.req.raw.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function upgradeRequired(c: OneTimeContext) {
  return c.json({ message: "WebSocket upgrade required." }, 426);
}

function tooMany(c: OneTimeContext) {
  return c.json({ message: "Too many requests." }, 429);
}

async function allowed(c: OneTimeContext, limit: RateLimit) {
  return (
    await limit.limit({
      key: rateLimitKey(c.req.raw.headers.get("cf-connecting-ip")),
    })
  ).success;
}

/**
 * The per-client key both limits count under: the connecting IPv4 address, or
 * the /64 of an IPv6 one, since a single subscriber commonly holds a whole /64.
 */
export function rateLimitKey(ip: string | null): string {
  if (!ip) return "local";
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const split = (part?: string) => (part ? part.split(":") : []);
  // An embedded IPv4 tail fills two groups.
  const width = (groups: string[]) =>
    groups.reduce((n, group) => n + (group.includes(".") ? 2 : 1), 0);
  const left = split(head);
  const right = split(tail);
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(Math.max(0, 8 - width(left) - width(right))).fill("0"),
          ...right,
        ];
  const prefix = groups
    .slice(0, 4)
    .map((group) =>
      /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16).toString(16) : group,
    );
  return `${prefix.join(":")}::/64`;
}

/**
 * A fresh request carrying only the upgrade and the room, so no cookie,
 * address, or Origin reaches the room.
 */
function forward(c: OneTimeContext, route: string, room: string) {
  const url = new URL(route, c.req.url);
  url.searchParams.set(ONE_TIME_ROOM_PARAM, room);
  const stub = c.env.ONE_TIME_ROOM.get(c.env.ONE_TIME_ROOM.idFromName(room));
  return stub.fetch(new Request(url, { headers: { upgrade: "websocket" } }));
}
