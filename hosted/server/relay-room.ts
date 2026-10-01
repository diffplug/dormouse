// Rules: docs/specs/hosted.md -> "Relay sockets"; the routing it shares with
// the self-host Relay, docs/specs/relay.md -> "Routing".
import { DurableObject } from "cloudflare:workers";
import {
  MAX_RELAY_CLIENT_SOCKETS,
  MAX_RELAY_FRAME_BYTES,
  RELAY_PING,
  RELAY_PONG,
  WS_CLOSE_BURROW_REPLACED,
  WS_CLOSE_BURROW_REPLACED_REASON,
  WS_CLOSE_BURROW_REVOKED,
  WS_CLOSE_BURROW_REVOKED_REASON,
  WS_CLOSE_FRAME_TOO_LARGE,
  WS_CLOSE_IDLE,
  WS_CLOSE_IDLE_REASON,
  WS_CLOSE_TRY_AGAIN_LATER,
  WS_CLOSE_UNAUTHORIZED,
  WS_CLOSE_UNAUTHORIZED_REASON,
  WS_ROUTES,
  isE2eBurrowFrame,
  isE2eClientFrame,
  toBase64Url,
  type RelayToBurrowFrame,
  type RelayToClientFrame,
} from "remote-lib-common";
import { RELAY_ROOM_PARAMS, RELAY_SILENCE_MS } from "./relay-sockets";

/** The object's whole durable state: the account it serves, written once. */
const ACCOUNT_KEY = "account";

/** `WebSocket.OPEN`. */
const OPEN = 1;

/**
 * Everything routing needs of a socket, held as its attachment so a woken
 * object rebuilds it from `ctx.getWebSockets` rather than from memory.
 * `retired` marks a socket unregistered ahead of its close handshake: from
 * then on it is neither routed nor torn down again.
 */
type Conn =
  | { role: "burrow"; burrowId: string; retired?: true }
  | {
      role: "client";
      clientId: string;
      expiresAt: number;
      burrowId: string | null;
      retired?: true;
    };
type BurrowConn = Extract<Conn, { role: "burrow" }>;
type ClientConn = Extract<Conn, { role: "client" }>;

/** A socket and its attachment. */
type Held<C extends Conn = Conn> = { ws: WorkerWebSocket; conn: C };

/** The tag every socket of a role carries, and the one naming it by id. */
const roleTag = (role: Conn["role"]) => role;
const burrowTag = (burrowId: string) => `burrow:${burrowId}`;
const clientTag = (clientId: string) => `client:${clientId}`;

/**
 * One account's Hosted Relay: that account's Burrow and Client sockets,
 * routed by `docs/specs/relay.md` -> "Routing" exactly as the self-host
 * `RelayHub` routes them. The relay Worker names it from the account an
 * authenticated token resolved to, and it serves that account alone. It
 * parses only the routing envelope, after bounding the raw frame, and never
 * stores, logs, or decodes a frame; its one durable value is the account id.
 * Every socket is accepted through the Hibernation API, and a ping is answered
 * by the runtime without waking it.
 */
export class RelayRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG),
    );
  }

  /** The clock expiry and silence are judged on; a test entry moves it. */
  protected now(): number {
    return Date.now();
  }

  // Reached only through the relay Worker's socket routes, which have
  // resolved the token, its account's entitlement, and the Origin.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const param = (name: string) => url.searchParams.get(name) ?? "";
    const role =
      url.pathname === WS_ROUTES.burrow ? "burrow" : url.pathname === WS_ROUTES.client ? "client" : null;
    if (!role) return new Response(null, { status: 404 });
    if (!(await this.#claim(param(RELAY_ROOM_PARAMS.account))))
      return new Response(null, { status: 403 });
    return role === "burrow"
      ? this.#openBurrow(param(RELAY_ROOM_PARAMS.burrowId))
      : this.#openClient(Number(param(RELAY_ROOM_PARAMS.expiresAt)));
  }

  // --- RPC, from the Workers ------------------------------------------------

  /**
   * Close `burrowId`'s socket as revoked (4001), its Clients told
   * `burrow-gone`. The account Worker's removal calls it; it has no route.
   */
  async closeBurrow(account: string, burrowId: string): Promise<boolean> {
    if (!(await this.#serves(account))) return false;
    const held = this.#burrow(burrowId);
    if (!held) return false;
    this.#retire(held, WS_CLOSE_BURROW_REVOKED, WS_CLOSE_BURROW_REVOKED_REASON);
    return true;
  }

  /** Every Burrow holding a live socket: what `GET /api/burrows` reports online. */
  async onlineBurrows(account: string): Promise<string[]> {
    if (!(await this.#serves(account))) return [];
    return this.#held("burrow")
      .filter((held) => !this.#evictedForSilence(held))
      .map(({ conn }) => conn.burrowId);
  }

  // --- Opening ----------------------------------------------------------------

  /**
   * One socket per `burrowId`: a second displaces the first — its Clients
   * told `burrow-gone` and their bindings cleared now, since the displaced
   * socket's own close is a no-op — and the first closes 4000.
   */
  #openBurrow(burrowId: string): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    const existing = this.#burrow(burrowId);
    if (existing)
      this.#retire(existing, WS_CLOSE_BURROW_REPLACED, WS_CLOSE_BURROW_REPLACED_REASON);
    for (const held of this.#held("burrow")) this.#evictedForSilence(held);
    this.ctx.acceptWebSocket(server, [roleTag("burrow"), burrowTag(burrowId)]);
    server.serializeAttachment({ role: "burrow", burrowId } satisfies BurrowConn);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * A Client socket with a fresh secret `clientId`, or 1013 at the cap —
   * refused, never admitted by evicting a live one; a silent one is not live.
   */
  async #openClient(expiresAt: number): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    if (!(expiresAt > this.now()))
      return refuse(client, server, WS_CLOSE_UNAUTHORIZED, WS_CLOSE_UNAUTHORIZED_REASON);
    let clients = this.#held("client");
    if (clients.length >= MAX_RELAY_CLIENT_SOCKETS)
      clients = clients.filter((held) => !this.#evictedForSilence(held));
    if (clients.length >= MAX_RELAY_CLIENT_SOCKETS)
      return refuse(client, server, WS_CLOSE_TRY_AGAIN_LATER, "too many client sockets");
    const clientId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    this.ctx.acceptWebSocket(server, [roleTag("client"), clientTag(clientId)]);
    server.serializeAttachment({
      role: "client",
      clientId,
      expiresAt,
      burrowId: null,
    } satisfies ClientConn);
    await this.#armExpiry();
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Frames -----------------------------------------------------------------

  async webSocketMessage(ws: WorkerWebSocket, message: string | ArrayBuffer) {
    const held = this.#registered(ws);
    if (!held) return;
    // Bounded before anything reads it: the length of the text, never its content.
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > MAX_RELAY_FRAME_BYTES) {
      this.#retire(held, WS_CLOSE_FRAME_TOO_LARGE, "frame too large");
      if (held.conn.role === "client") await this.#armExpiry();
      return;
    }
    if (typeof message !== "string") return;
    if (held.conn.role === "client") this.#onClientFrame(held as Held<ClientConn>, message);
    else this.#onBurrowFrame(held as Held<BurrowConn>, message);
  }

  #onClientFrame({ ws, conn }: Held<ClientConn>, raw: string) {
    const frame = parseFrame(raw);
    if (!frame || typeof frame.t !== "string")
      return send(ws, { t: "error", error: "malformed frame" } satisfies RelayToClientFrame);
    if (frame.t !== "e2e")
      return send(ws, { t: "error", error: "unknown frame type" } satisfies RelayToClientFrame);
    if (!isE2eClientFrame(frame))
      return send(ws, { t: "error", error: "malformed e2e frame" } satisfies RelayToClientFrame);
    const burrow = this.#burrow(frame.burrowId);
    if (!burrow || this.#evictedForSilence(burrow))
      return send(ws, {
        t: "error",
        error: `burrow ${frame.burrowId} is offline`,
      } satisfies RelayToClientFrame);
    if (frame.step === "init") {
      // An `init` binds, telling the Burrow it replaces that this Client is gone.
      if (conn.burrowId !== null && conn.burrowId !== frame.burrowId) {
        const previous = this.#burrow(conn.burrowId);
        if (previous) send(previous.ws, clientGone(conn.clientId));
      }
      conn.burrowId = frame.burrowId;
      ws.serializeAttachment(conn);
    } else if (conn.burrowId !== frame.burrowId) return;
    // Rebuilt field by field: nothing the Client added rides along.
    send(burrow.ws, {
      t: "e2e",
      clientId: conn.clientId,
      burrowId: frame.burrowId,
      kind: frame.kind,
      id: frame.id,
      step: frame.step,
      ct: frame.ct,
    } satisfies RelayToBurrowFrame);
  }

  #onBurrowFrame({ conn }: Held<BurrowConn>, raw: string) {
    const frame = parseFrame(raw);
    if (!frame || !isE2eBurrowFrame(frame)) return;
    const client = this.#client(frame.clientId);
    // Only to a Client bound to this Burrow: a late reply from a Burrow the
    // Client has left goes nowhere.
    if (!client || client.conn.burrowId !== conn.burrowId) return;
    send(client.ws, {
      t: "e2e",
      burrowId: conn.burrowId,
      kind: frame.kind,
      id: frame.id,
      step: frame.step,
      ct: frame.ct,
    } satisfies RelayToClientFrame);
  }

  // --- Closing ----------------------------------------------------------------

  // A socket the object retired is already torn down; only a registered one
  // tears down here.
  async webSocketClose(ws: WorkerWebSocket, code: number) {
    // Closing by now, so judged by its attachment alone.
    const held = this.#attached(ws);
    if (held) this.#unregister(held);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // The runtime already answered the close.
    }
    if (held?.conn.role === "client") await this.#armExpiry();
  }

  async webSocketError(ws: WorkerWebSocket) {
    await this.webSocketClose(ws, 1006);
  }

  /** Every Client whose session has expired closes 1008, its Burrow told `client-gone`. */
  async alarm() {
    const now = this.now();
    for (const held of this.#held("client"))
      if (held.conn.expiresAt <= now)
        this.#retire(held, WS_CLOSE_UNAUTHORIZED, WS_CLOSE_UNAUTHORIZED_REASON);
    await this.#armExpiry();
  }

  /** The alarm at the earliest held session's expiry; none while no Client is held. */
  async #armExpiry() {
    const expiries = this.#held("client").map(({ conn }) => conn.expiresAt);
    if (expiries.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...expiries));
  }

  /**
   * Unregister, then start the close handshake: routing and capacity are
   * released before the handshake, so a frame already buffered acts through
   * nothing.
   */
  #retire(held: Held, code: number, reason: string) {
    this.#unregister(held);
    try {
      held.ws.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  /**
   * The teardown a disconnect performs: a Burrow's Clients get `burrow-gone`
   * and lose their binding; a Client's Burrow gets `client-gone`. The socket's
   * attachment is marked retired first, so a second teardown is a no-op.
   */
  #unregister({ ws, conn }: Held) {
    conn.retired = true;
    try {
      ws.serializeAttachment(conn);
    } catch {
      // A socket the runtime already closed keeps no attachment to protect.
    }
    if (conn.role === "burrow") {
      for (const client of this.#held("client")) {
        if (client.conn.burrowId !== conn.burrowId) continue;
        send(client.ws, { t: "burrow-gone" } satisfies RelayToClientFrame);
        client.conn.burrowId = null;
        client.ws.serializeAttachment(client.conn);
      }
    } else if (conn.burrowId !== null) {
      const burrow = this.#burrow(conn.burrowId);
      if (burrow) send(burrow.ws, clientGone(conn.clientId));
    }
  }

  /**
   * Whether `held` stopped answering pings: its last auto-response is older
   * than {@link RELAY_SILENCE_MS}. A socket that never pinged is not judged.
   * Such a socket is retired with 1001 here.
   */
  #evictedForSilence(held: Held): boolean {
    const answered = this.ctx.getWebSocketAutoResponseTimestamp(held.ws);
    if (answered === null || this.now() - answered.getTime() <= RELAY_SILENCE_MS)
      return false;
    this.#retire(held, WS_CLOSE_IDLE, WS_CLOSE_IDLE_REASON);
    return true;
  }

  // --- What the object holds ----------------------------------------------------

  /** `ws` and its attachment while it is registered: open and not retired. */
  #registered(ws: WorkerWebSocket): Held | null {
    return ws.readyState === OPEN ? this.#attached(ws) : null;
  }

  /** `ws` and its attachment unless the object retired it. */
  #attached(ws: WorkerWebSocket): Held | null {
    const conn = ws.deserializeAttachment() as Conn | null;
    return conn && !conn.retired ? { ws, conn } : null;
  }

  #held<R extends Conn["role"]>(role: R, tag: string = roleTag(role)) {
    return this.ctx
      .getWebSockets(tag)
      .map((ws) => this.#registered(ws))
      .filter((held): held is Held<Extract<Conn, { role: R }>> => held?.conn.role === role);
  }

  #burrow(burrowId: string): Held<BurrowConn> | undefined {
    return this.#held("burrow", burrowTag(burrowId))[0];
  }

  #client(clientId: string): Held<ClientConn> | undefined {
    return this.#held("client", clientTag(clientId))[0];
  }

  /**
   * Admit `account` to this object: the first upgrade writes it, and
   * a request naming any other is refused. The Worker names the object from
   * that same account, so a refusal here is an invariant broken upstream.
   */
  async #claim(account: string): Promise<boolean> {
    if (!account) return false;
    const stored = await this.ctx.storage.get<string>(ACCOUNT_KEY);
    if (stored === undefined) {
      await this.ctx.storage.put(ACCOUNT_KEY, account);
      return true;
    }
    return this.#matches(stored, account);
  }

  /** Whether this object serves `account`; one that never held a socket serves none. */
  async #serves(account: string): Promise<boolean> {
    const stored = await this.ctx.storage.get<string>(ACCOUNT_KEY);
    return stored !== undefined && this.#matches(stored, account);
  }

  #matches(stored: string, account: string): boolean {
    if (stored === account) return true;
    console.error("RelayRoom refused a request for another account");
    return false;
  }
}

/** Parse a raw text frame; `null` if it is not a JSON object. */
function parseFrame(raw: string): (Record<string, unknown> & { t?: unknown }) | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const clientGone = (clientId: string): RelayToBurrowFrame => ({ t: "client-gone", clientId });

/** Serialize and send, swallowing errors from a socket that is mid-close. */
function send(ws: WorkerWebSocket, frame: RelayToClientFrame | RelayToBurrowFrame) {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // The peer vanished between the lookup and this send.
  }
}

/**
 * Accept-then-close, so the refused end reads a code rather than a failed
 * upgrade. Accepted outside hibernation: the socket is never the object's, so
 * none of its events reach the handlers above.
 */
function refuse(client: WorkerWebSocket, server: WorkerWebSocket, code: number, reason: string) {
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}
