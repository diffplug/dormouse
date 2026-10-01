// Rules: docs/specs/hosted.md -> "Relay sockets"; docs/specs/security-hosted.md -> "Relay boundary".
import type { Context, Hono } from "hono";
import { withClient } from "pgstencil/postgres";
import {
  NOT_ENTITLED_ERROR,
  RELAY_PING_INTERVAL_MS,
  UNAUTHORIZED_ERROR,
  UNKNOWN_BURROW_TOKEN_ERROR,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  isRelayBearer,
} from "remote-lib-common";
import type { RelayEnv } from "./bindings";
import { burrowByToken, sessionByToken, type Client } from "./relay-auth";
import type { RelayRoom } from "./relay-room";

type SocketContext = Context<{ Bindings: RelayEnv }>;

/**
 * The verified fields the Worker hands a `RelayRoom` with an upgrade, as
 * search parameters on a request it builds fresh: the account the token
 * named, and the Burrow's id or the session's expiry.
 */
export const RELAY_ROOM_PARAMS = {
  account: "account",
  burrowId: "burrow",
  expiresAt: "expires",
} as const;

/**
 * A `RelayRoom` socket whose last ping is older than this is gone: three
 * intervals, the self-host Relay's idle timeout.
 */
export const RELAY_SILENCE_MS = 3 * RELAY_PING_INTERVAL_MS;

/** The RPC half of a `RelayRoom` stub. */
export type RelayRoomRpc = Pick<RelayRoom, "closeBurrow" | "onlineBurrows">;

/** The account's `RelayRoom`, named from its user id and nothing else. */
export function relayRoom(
  namespace: DurableObjectNamespace<RelayRoomRpc>,
  account: string,
): DurableObjectStub<RelayRoomRpc> {
  return namespace.get(namespace.idFromName(account));
}

/**
 * The relay sockets, at the self-host Relay's paths and refusals: each
 * resolves its token, then hands the account's `RelayRoom` a bare upgrade
 * carrying only what the token resolved to. Register before the `/ws/*` tail.
 */
export function relaySocketRoutes(app: Hono<{ Bindings: RelayEnv }>) {
  app.get(WS_ROUTES.burrow, async (c) => {
    // Only a Node Burrow connects: every browser sends Origin on a WebSocket
    // handshake, so refusing any keeps web pages off the Burrow socket.
    if (c.req.raw.headers.has("origin")) return c.json({ error: "forbidden" }, 403);
    if (!upgrade(c)) return upgradeRequired(c);
    const burrow = await lookup(c, burrowByToken);
    if (!burrow) return c.json({ error: UNKNOWN_BURROW_TOKEN_ERROR }, 401);
    if (!burrow.entitled) return c.json({ error: NOT_ENTITLED_ERROR }, 403);
    return forward(c, WS_ROUTES.burrow, burrow.userId, {
      [RELAY_ROOM_PARAMS.burrowId]: burrow.burrowId,
    });
  });

  app.get(WS_ROUTES.client, async (c) => {
    // Pocket is same-origin; any other page is a cross-site socket hijack.
    if (c.req.raw.headers.get("origin") !== c.env.APP_ORIGIN)
      return c.json({ error: "forbidden" }, 403);
    if (!upgrade(c)) return upgradeRequired(c);
    // An expired, unknown, or de-entitled session is one 401, which Pocket's
    // probe of `GET /api/burrows` then reads as expiry.
    const session = await lookup(c, sessionByToken);
    if (!session?.entitled) return c.json({ error: UNAUTHORIZED_ERROR }, 401);
    return forward(c, WS_ROUTES.client, session.userId, {
      [RELAY_ROOM_PARAMS.expiresAt]: String(session.expiresAt),
    });
  });
}

/** What the token query parameter names, refused by shape before any database read. */
async function lookup<Found>(
  c: SocketContext,
  find: (db: Client, token: string) => Promise<Found | null>,
): Promise<Found | null> {
  const token = c.req.query(WS_TOKEN_PARAM);
  if (!isRelayBearer(token)) return null;
  return withClient(c.env.HYPERDRIVE.connectionString, (db: Client) => find(db, token));
}

function upgrade(c: SocketContext) {
  return c.req.raw.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function upgradeRequired(c: SocketContext) {
  return c.json({ error: "WebSocket upgrade required" }, 426);
}

/**
 * A fresh request carrying only the upgrade, the account, and `fields`, so no
 * header, token, cookie, or address of the caller's reaches the object.
 */
function forward(
  c: SocketContext,
  route: string,
  account: string,
  fields: Record<string, string>,
) {
  const url = new URL(route, c.env.APP_ORIGIN);
  url.searchParams.set(RELAY_ROOM_PARAMS.account, account);
  for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
  return relayRoom(c.env.RELAY_ROOM, account).fetch(
    new Request(url, { headers: { upgrade: "websocket" } }),
  );
}
