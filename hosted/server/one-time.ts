import type { Context, Hono } from "hono";
import {
  E2E_ID_BYTE_LENGTH,
  isE2eId,
  ONE_TIME_PAGE_PATH,
  ONE_TIME_ROOM_PARAM,
  ONE_TIME_WS_ROUTES,
  toBase64Url,
} from "remote-lib-common";
import type { RelayEnv } from "./bindings";
import { forwardUpgrade, isUpgrade, upgradeRequired } from "./socket-room";

type OneTimeContext = Context<{ Bindings: RelayEnv }>;

/**
 * The one-time rendezvous routes (`docs/specs/one-time.md` -> "Hosted
 * rendezvous"). Each checks the request, then hands a bare upgrade to the
 * room's Durable Object; neither reads a cookie, reaches Hyperdrive, or asks
 * auth anything.
 */
export function oneTimeRoutes(app: Hono<{ Bindings: RelayEnv }>) {
  app.get(ONE_TIME_WS_ROUTES.burrow, async (c) => {
    if (!isUpgrade(c)) return upgradeRequired(c, "message");
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
    if (!isUpgrade(c)) return upgradeRequired(c, "message");
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
 * into the relay's assets under `/connect/`: its shell and its content-hashed
 * assets, and nothing else under the path. The relay's assets have no SPA
 * fallback; an HTML answer to an asset path is refused all the same.
 */
export function oneTimePageRoutes(app: Hono<{ Bindings: RelayEnv }>) {
  const assets = (c: OneTimeContext) => c.env.ASSETS.fetch(c.req.raw);
  app.get(ONE_TIME_PAGE_PATH.slice(0, -1), assets);
  app.get(ONE_TIME_PAGE_PATH, assets);
  app.get(`${ONE_TIME_PAGE_PATH}assets/*`, async (c) => assetOrNotFound(c, await assets(c)));
  app.get(`${ONE_TIME_PAGE_PATH}*`, (c) => c.notFound());
}

/**
 * A content-hashed asset's answer: the file itself, or a 404 — never HTML,
 * which would be cached as immutable under the hashed name.
 */
export function assetOrNotFound(c: OneTimeContext, response: Response) {
  return response.ok &&
    !(response.headers.get("content-type") ?? "").includes("text/html")
    ? response
    : c.notFound();
}

function tooMany(c: OneTimeContext) {
  return c.json({ message: "Too many requests." }, 429);
}

/** Whether `limit` admits this caller, keyed by {@link rateLimitKey}. */
export async function allowed(c: OneTimeContext, limit: RateLimit) {
  return (
    await limit.limit({
      key: rateLimitKey(c.req.raw.headers.get("cf-connecting-ip")),
    })
  ).success;
}

/**
 * The per-client key both limits count under: the connecting IPv4 address, or
 * the /64 of an IPv6 one, since a single subscriber commonly holds a whole /64.
 * An IPv4-mapped IPv6 address (`::ffff:0:0/96`), however it is spelled, is its
 * IPv4 client, or every such client would share one all-zero /64.
 */
export function rateLimitKey(ip: string | null): string {
  if (!ip) return "local";
  if (!ip.includes(":")) return ip;
  const groups = ipv6Groups(ip.toLowerCase());
  if (
    groups.length === 8 &&
    groups.slice(0, 6).join(":") === "0:0:0:0:0:ffff" &&
    groups.slice(6).every(isHexGroup)
  ) {
    const [high, low] = groups.slice(6).map((group) => parseInt(group, 16));
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

function isHexGroup(group: string): boolean {
  return /^[0-9a-f]{1,4}$/.test(group);
}

/**
 * An IPv6 address's groups with `::` expanded, each hex group without leading
 * zeros; an embedded dotted IPv4 tail becomes the last two groups. A group that
 * is neither is kept as it is.
 */
function ipv6Groups(ip: string): string[] {
  const split = (part?: string) =>
    (part ? part.split(":") : []).flatMap((group) => {
      if (isHexGroup(group)) return [parseInt(group, 16).toString(16)];
      const octets = group.split(".");
      const dotted =
        octets.length === 4 &&
        octets.every((octet) => /^\d{1,3}$/.test(octet) && +octet <= 255);
      if (!dotted) return [group];
      const [a, b, c, d] = octets.map(Number);
      return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
    });
  const [head, tail] = ip.split("::");
  const left = split(head);
  if (tail === undefined) return left;
  const right = split(tail);
  return [
    ...left,
    ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"),
    ...right,
  ];
}

/** The room's object, handed a bare upgrade naming the room and nothing else of the caller's. */
function forward(c: OneTimeContext, route: string, room: string) {
  const stub = c.env.ONE_TIME_ROOM.get(c.env.ONE_TIME_ROOM.idFromName(room));
  return forwardUpgrade(stub, new URL(route, c.req.url), { [ONE_TIME_ROOM_PARAM]: room });
}
