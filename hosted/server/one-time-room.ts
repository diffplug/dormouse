import {
  MAX_ONE_TIME_FORWARDED,
  MAX_ONE_TIME_FRAME_LENGTH,
  ONE_TIME_EXPIRY_GRACE_MS,
  ONE_TIME_LINK_TTL_MS,
  RELAY_PING,
  RELAY_PONG,
  ONE_TIME_ROOM_PARAM,
  ONE_TIME_WS_ROUTES,
  WS_CLOSE_ONE_TIME_DEADLINE,
  WS_CLOSE_ONE_TIME_DEADLINE_REASON,
  WS_CLOSE_ONE_TIME_EXPIRED,
  WS_CLOSE_ONE_TIME_EXPIRED_REASON,
  WS_CLOSE_ONE_TIME_PEER_GONE,
  WS_CLOSE_ONE_TIME_PEER_GONE_REASON,
  WS_CLOSE_ONE_TIME_TAKEN,
  WS_CLOSE_ONE_TIME_TAKEN_REASON,
  WS_CLOSE_ONE_TIME_UNAVAILABLE,
  WS_CLOSE_ONE_TIME_UNAVAILABLE_REASON,
  WS_CLOSE_ONE_TIME_VIOLATION,
  WS_CLOSE_ONE_TIME_VIOLATION_REASON,
  type OneTimeRoomFrame,
} from "remote-lib-common";

import { OPEN, refuseSocket } from "./socket-room";

/** A socket's role, as its hibernation tag. */
type Role = "burrow" | "client";

/** The room's whole state, held as the Burrow socket's attachment. */
interface RoomState {
  expiresAt: number;
  joined: boolean;
  /** Every frame the room has received, forwarded or dropped. */
  forwarded: number;
}

/**
 * One one-time link's rendezvous (`docs/specs/one-time.md` -> "Hosted
 * rendezvous"): a Burrow socket, at most one phone socket, and nothing else.
 * It forwards each text frame verbatim to the other end and never parses,
 * decodes, stores, or logs one; `scripts/e2e-lint.mjs` holds that textually.
 * Every socket is accepted through the Hibernation API, so a room waiting for
 * its phone costs nothing, and the state lives in the Burrow socket's
 * attachment rather than in memory.
 */
export class OneTimeRoom {
  readonly #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.#ctx = ctx;
    // Answered by the runtime, so a keepalive neither wakes the room nor
    // reaches `webSocketMessage` to be forwarded or counted.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG),
    );
  }

  /** The link's lifetime and the grace past it; a test entry shortens both. */
  protected limits() {
    return {
      linkTtlMs: ONE_TIME_LINK_TTL_MS,
      expiryGraceMs: ONE_TIME_EXPIRY_GRACE_MS,
    };
  }

  // Reached only through `oneTimeRoutes`, which has already checked the
  // upgrade, the Origin, the room id, and the rate limit.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === ONE_TIME_WS_ROUTES.burrow)
      return this.#open(url.searchParams.get(ONE_TIME_ROOM_PARAM) ?? "");
    if (url.pathname === ONE_TIME_WS_ROUTES.client) return this.#join();
    return new Response(null, { status: 404 });
  }

  async #open(roomId: string): Promise<Response> {
    // A room id is minted fresh for each Burrow socket, so a room opens once.
    if (this.#socket("burrow") || this.#socket("client"))
      return refuseSocket(WS_CLOSE_ONE_TIME_UNAVAILABLE, WS_CLOSE_ONE_TIME_UNAVAILABLE_REASON);
    const { 0: client, 1: server } = new WebSocketPair();
    const { linkTtlMs, expiryGraceMs } = this.limits();
    const expiresAt = Date.now() + linkTtlMs;
    await this.#ctx.storage.setAlarm(expiresAt + expiryGraceMs);
    this.#ctx.acceptWebSocket(server, ["burrow"]);
    server.serializeAttachment({
      expiresAt,
      joined: false,
      forwarded: 0,
    } satisfies RoomState);
    server.send(
      JSON.stringify({
        t: "one-time-room",
        roomId,
        expiresAt,
      } satisfies OneTimeRoomFrame),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  #join(): Response {
    // Check and set with no await between them: the one join is decided here.
    const burrow = this.#socket("burrow");
    const state = burrow && this.#state(burrow);
    if (!burrow || !state)
      return refuseSocket(WS_CLOSE_ONE_TIME_UNAVAILABLE, WS_CLOSE_ONE_TIME_UNAVAILABLE_REASON);
    if (state.joined) return refuseSocket(WS_CLOSE_ONE_TIME_TAKEN, WS_CLOSE_ONE_TIME_TAKEN_REASON);
    if (Date.now() > state.expiresAt)
      return refuseSocket(WS_CLOSE_ONE_TIME_EXPIRED, WS_CLOSE_ONE_TIME_EXPIRED_REASON);
    const { 0: client, 1: server } = new WebSocketPair();
    burrow.serializeAttachment({ ...state, joined: true } satisfies RoomState);
    this.#ctx.acceptWebSocket(server, ["client"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WorkerWebSocket, message: string | ArrayBuffer) {
    // Every ending closes both sockets, so a frame in flight when one began
    // finds no open Burrow and goes nowhere.
    const burrow = this.#socket("burrow");
    const state = burrow && this.#state(burrow);
    if (!state) return;
    const forwarded = state.forwarded + 1;
    if (
      typeof message !== "string" ||
      message.length > MAX_ONE_TIME_FRAME_LENGTH ||
      forwarded > MAX_ONE_TIME_FORWARDED
    )
      return this.#end(
        WS_CLOSE_ONE_TIME_VIOLATION,
        WS_CLOSE_ONE_TIME_VIOLATION_REASON,
      );
    burrow.serializeAttachment({ ...state, forwarded } satisfies RoomState);
    const [role] = this.#ctx.getTags(ws) as Role[];
    // Before a phone joins the Burrow has no one to address; its frame is dropped.
    this.#socket(role === "burrow" ? "client" : "burrow")?.send(message);
  }

  // Also the reply to the leaving end's close frame: `#end` closes it too.
  async webSocketClose() {
    await this.#end(
      WS_CLOSE_ONE_TIME_PEER_GONE,
      WS_CLOSE_ONE_TIME_PEER_GONE_REASON,
    );
  }

  async webSocketError() {
    await this.webSocketClose();
  }

  /** The hard deadline, `expiresAt + grace`. */
  async alarm() {
    const burrow = this.#socket("burrow");
    const joined = burrow ? this.#state(burrow)?.joined : false;
    await (joined
      ? this.#end(WS_CLOSE_ONE_TIME_DEADLINE, WS_CLOSE_ONE_TIME_DEADLINE_REASON)
      : this.#end(WS_CLOSE_ONE_TIME_EXPIRED, WS_CLOSE_ONE_TIME_EXPIRED_REASON));
  }

  /** Close every socket the room holds and delete what it stored. */
  async #end(code: number, reason: string) {
    for (const role of ["burrow", "client"] as const)
      for (const ws of this.#ctx.getWebSockets(role)) {
        try {
          ws.close(code, reason);
        } catch {
          // Already closed: the end that left, or one an earlier ending reached.
        }
      }
    await this.#ctx.storage.deleteAlarm();
    await this.#ctx.storage.deleteAll();
  }

  /** The room's open socket for `role`; one the room has closed no longer counts. */
  #socket(role: Role): WorkerWebSocket | undefined {
    return this.#ctx.getWebSockets(role).find((ws) => ws.readyState === OPEN);
  }

  #state(burrow: WorkerWebSocket): RoomState | undefined {
    return (burrow.deserializeAttachment() as RoomState | null) ?? undefined;
  }
}
