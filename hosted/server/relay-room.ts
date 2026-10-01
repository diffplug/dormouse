// Rules: docs/specs/hosted.md -> "Relay sockets"; the routing it shares with
// the self-host Relay, docs/specs/relay.md -> "Routing"; what it may read and
// keep, docs/specs/security-hosted.md -> "Relay boundary", which
// scripts/e2e-lint.mjs holds textually here.
import { DurableObject } from "cloudflare:workers";
import {
  MAX_RELAY_CLIENT_SOCKETS,
  MAX_RELAY_FRAME_BYTES,
  NOT_ENTITLED_ERROR,
  RELAY_IDLE_TIMEOUT_MS,
  RELAY_PING,
  RELAY_PONG,
  UNKNOWN_BURROW_TOKEN_ERROR,
  WS_CLOSE_BURROW_NOT_ENTITLED,
  WS_CLOSE_BURROW_NOT_ENTITLED_REASON,
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
  exceedsRelayFrameBytes,
  newClientId,
  offlineError,
  readBurrowFrame,
  readClientFrame,
  toBurrowEnvelope,
  toClientEnvelope,
  type RelayToBurrowFrame,
  type RelayToClientFrame,
} from "remote-lib-common";
import type { RelayBurrow } from "./relay-auth";
import {
  RELAY_ROOM_PARAMS,
  RELAY_ROOM_SWEEP_MS,
  RELAY_ROW_READ_TIMEOUT_MS,
  type RelayRoomRpc,
} from "./relay-room-contract";
import type { RelayRows } from "./relay-rows";
import { OPEN, refuseSocket } from "./socket-room";

/** The key of the object's one durable value: the account it serves, written once. */
const ACCOUNT_KEY = "account";

/**
 * Everything routing needs of a socket, held as its attachment so a woken
 * object rebuilds it from `ctx.getWebSockets` rather than from memory.
 * `retired` is the generation guard: set on a socket unregistered ahead of its
 * close handshake, after which it is neither routed nor torn down again.
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

/** Every socket carries its role as one tag, and its id as the other. */
const burrowTag = (burrowId: string) => `burrow:${burrowId}`;
const clientTag = (clientId: string) => `client:${clientId}`;

/**
 * One account's Hosted Relay: that account's Burrow and Client sockets,
 * routed by `docs/specs/relay.md` -> "Routing" exactly as the self-host
 * `RelayHub` routes them, through the same frame layer. The relay Worker names
 * it from the account an authenticated token resolved to, and it serves that
 * account alone. Every socket is accepted through the Hibernation API, and a
 * ping is answered by the runtime without waking it.
 */
export class RelayRoom extends DurableObject implements RelayRoomRpc {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG));
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
    const account = param(RELAY_ROOM_PARAMS.account);
    const role =
      url.pathname === WS_ROUTES.burrow ? "burrow" : url.pathname === WS_ROUTES.client ? "client" : null;
    if (!role) return new Response(null, { status: 404 });
    if (!(await this.#claim(account))) return new Response(null, { status: 403 });
    return role === "burrow"
      ? this.#openBurrow(account, param(RELAY_ROOM_PARAMS.burrowId))
      : this.#openClient(Number(param(RELAY_ROOM_PARAMS.expiresAt)));
  }

  // --- RPC, from the Workers ------------------------------------------------

  async closeBurrow(account: string, burrowId: string): Promise<boolean> {
    if (!(await this.#serves(account))) return false;
    const held = this.#burrow(burrowId);
    if (!held) return false;
    this.#retire(held, WS_CLOSE_BURROW_REVOKED, WS_CLOSE_BURROW_REVOKED_REASON);
    return true;
  }

  async onlineBurrows(account: string): Promise<string[]> {
    if (!(await this.#serves(account))) return [];
    return this.#held("burrow")
      .filter((held) => !this.#goneSilent(held))
      .map(({ conn }) => conn.burrowId);
  }

  // --- Opening ----------------------------------------------------------------

  /**
   * A Burrow socket, once its row says it may hold one: still enrolled, this
   * account's, its owner entitled — refused as the Worker refuses a token
   * otherwise. The Worker's check ran before this request was queued, so a
   * removal committed since is caught here. Run under `blockConcurrencyWhile`
   * so that removal's `closeBurrow`, sent after its commit, is delivered only
   * once the socket is accepted and never between this read and the accept.
   *
   * One socket per `burrowId`: a second displaces the first — its Clients
   * told `burrow-gone` and their bindings cleared now, since the displaced
   * socket's own close is a no-op — and the first closes 4000.
   */
  #openBurrow(account: string, burrowId: string): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      let row: RelayBurrow | undefined;
      try {
        [row] = await this.#rows([burrowId]);
      } catch {
        console.error("RelayRoom could not read a Burrow's row");
        return new Response(null, { status: 503 });
      }
      if (row?.userId !== account)
        return Response.json({ error: UNKNOWN_BURROW_TOKEN_ERROR }, { status: 401 });
      if (!row.entitled) return Response.json({ error: NOT_ENTITLED_ERROR }, { status: 403 });
      const existing = this.#burrow(burrowId);
      if (existing)
        this.#retire(existing, WS_CLOSE_BURROW_REPLACED, WS_CLOSE_BURROW_REPLACED_REASON);
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, ["burrow", burrowTag(burrowId)]);
      server.serializeAttachment({ role: "burrow", burrowId } satisfies BurrowConn);
      await this.#armBy(this.now() + RELAY_ROOM_SWEEP_MS);
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  /**
   * A Client socket with a fresh secret `clientId`, or 1013 at the cap —
   * refused, never admitted by evicting a live one. A Client silent past the
   * idle timeout is not live, so one is retired here first; only at the cap,
   * since judging silence costs a close.
   */
  async #openClient(expiresAt: number): Promise<Response> {
    if (!(expiresAt > this.now()))
      return refuseSocket(WS_CLOSE_UNAUTHORIZED, WS_CLOSE_UNAUTHORIZED_REASON);
    let clients = this.#held("client");
    if (clients.length >= MAX_RELAY_CLIENT_SOCKETS)
      clients = clients.filter((held) => !this.#goneSilent(held));
    if (clients.length >= MAX_RELAY_CLIENT_SOCKETS)
      return refuseSocket(WS_CLOSE_TRY_AGAIN_LATER, "too many client sockets");
    const clientId = newClientId();
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ["client", clientTag(clientId)]);
    server.serializeAttachment({
      role: "client",
      clientId,
      expiresAt,
      burrowId: null,
    } satisfies ClientConn);
    await this.#armBy(expiresAt);
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Frames -----------------------------------------------------------------

  async webSocketMessage(ws: WorkerWebSocket, message: string | ArrayBuffer) {
    const held = this.#registered(ws);
    if (!held) return;
    // Bounded before anything reads it, in the UTF-8 bytes the self-host
    // Relay's `maxPayload` counts: the size of the text, never its content.
    const oversized =
      typeof message === "string"
        ? exceedsRelayFrameBytes(message)
        : message.byteLength > MAX_RELAY_FRAME_BYTES;
    if (oversized) return this.#retire(held, WS_CLOSE_FRAME_TOO_LARGE, "frame too large");
    if (typeof message !== "string") return;
    if (held.conn.role === "client") this.#onClientFrame(held as Held<ClientConn>, message);
    else this.#onBurrowFrame(held as Held<BurrowConn>, message);
  }

  #onClientFrame({ ws, conn }: Held<ClientConn>, raw: string) {
    const read = readClientFrame(raw);
    if ("error" in read) return send(ws, read.error);
    const { frame } = read;
    // A Burrow silent past the idle timeout is offline; judged here, where a
    // frame would otherwise be routed into a dead socket.
    const burrow = this.#burrow(frame.burrowId);
    if (!burrow || this.#goneSilent(burrow)) return send(ws, offlineError(frame.burrowId));
    if (frame.step === "init") {
      // An `init` binds, telling the Burrow it replaces that this Client is gone.
      if (conn.burrowId !== null && conn.burrowId !== frame.burrowId) {
        const previous = this.#burrow(conn.burrowId);
        if (previous) send(previous.ws, clientGone(conn.clientId));
      }
      conn.burrowId = frame.burrowId;
      ws.serializeAttachment(conn);
    } else if (conn.burrowId !== frame.burrowId) return;
    send(burrow.ws, toBurrowEnvelope(conn.clientId, frame));
  }

  #onBurrowFrame({ conn }: Held<BurrowConn>, raw: string) {
    const frame = readBurrowFrame(raw);
    if (!frame) return;
    const client = this.#client(frame.clientId);
    // Only to a Client bound to this Burrow: a late reply from a Burrow the
    // Client has left goes nowhere.
    if (!client || client.conn.burrowId !== conn.burrowId) return;
    send(client.ws, toClientEnvelope(conn.burrowId, frame));
  }

  // --- Closing ----------------------------------------------------------------

  // A socket the object retired is already torn down; only a registered one
  // tears down here. The alarm is left as it is: `alarm()` re-arms or clears.
  async webSocketClose(ws: WorkerWebSocket, code: number) {
    // Closing by now, so judged by its attachment alone.
    const held = this.#attached(ws);
    if (held) this.#unregister(held);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // The runtime already answered the close.
    }
  }

  async webSocketError(ws: WorkerWebSocket) {
    await this.webSocketClose(ws, 1006);
  }

  /**
   * Every Client whose session has expired closes 1008, its Burrow told
   * `client-gone`; while Burrow sockets are held, each is swept against its
   * row. Then the alarm moves to the earlier of the next expiry and the next
   * sweep, or is cleared while nothing is held. Opening a socket only ever
   * brings the alarm earlier and a close leaves it, so an alarm may find
   * nothing to do.
   */
  async alarm() {
    const now = this.now();
    for (const held of this.#held("client"))
      if (held.conn.expiresAt <= now)
        this.#retire(held, WS_CLOSE_UNAUTHORIZED, WS_CLOSE_UNAUTHORIZED_REASON);
    if (this.#held("burrow").length > 0) await this.#sweep();
    const next = this.#held("client").map(({ conn }) => conn.expiresAt);
    if (this.#held("burrow").length > 0) next.push(this.now() + RELAY_ROOM_SWEEP_MS);
    if (next.length > 0) await this.ctx.storage.setAlarm(Math.min(...next));
    else await this.ctx.storage.deleteAlarm();
  }

  /**
   * The backstop to `closeBurrow`: every held Burrow whose row is gone or is
   * another account's closes 4001, and one whose owner is no longer entitled
   * 4002, its Clients told `burrow-gone`. One query for them all; a failed or
   * timed-out read leaves them to the next sweep.
   */
  async #sweep() {
    const account = await this.ctx.storage.get<string>(ACCOUNT_KEY);
    const burrowIds = this.#held("burrow").map(({ conn }) => conn.burrowId);
    let rows: RelayBurrow[];
    try {
      rows = await this.#rows(burrowIds);
    } catch {
      console.error("RelayRoom could not sweep its Burrows");
      return;
    }
    const owned = new Map(
      rows.filter((row) => row.userId === account).map((row) => [row.burrowId, row.entitled]),
    );
    for (const burrowId of burrowIds) {
      const entitled = owned.get(burrowId);
      if (entitled) continue;
      const held = this.#burrow(burrowId);
      if (!held) continue;
      if (entitled === false) {
        this.#retire(held, WS_CLOSE_BURROW_NOT_ENTITLED, WS_CLOSE_BURROW_NOT_ENTITLED_REASON);
      } else {
        this.#retire(held, WS_CLOSE_BURROW_REVOKED, WS_CLOSE_BURROW_REVOKED_REASON);
      }
    }
  }

  /** The alarm at `time`, unless one is already set sooner. */
  async #armBy(time: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || time < current) await this.ctx.storage.setAlarm(time);
  }

  /**
   * Those of `burrowIds` still enrolled, with their owners, read by the
   * Worker's own `RelayRows` in an invocation of its own: an object that has
   * held a database connection is never evicted (rationale). Rejects past
   * `RELAY_ROW_READ_TIMEOUT_MS`, so a stalled read under
   * `blockConcurrencyWhile` fails as a failed read does, never resetting the
   * object and every socket it holds.
   */
  async #rows(burrowIds: string[]): Promise<RelayBurrow[]> {
    const { RelayRows } = this.ctx.exports as { RelayRows: Pick<RelayRows, "burrows"> };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("RelayRows read timed out")),
        RELAY_ROW_READ_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([RelayRows.burrows(burrowIds), timeout]);
    } finally {
      clearTimeout(timer);
    }
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
   * than `RELAY_IDLE_TIMEOUT_MS`, and it is retired with 1001 here. A socket
   * that never pinged is not judged. Checked where a dead socket would cost
   * something — routing to a Burrow, admitting at the Client cap, reporting a
   * Burrow online — and nowhere on a timer.
   */
  #goneSilent(held: Held): boolean {
    const answered = this.ctx.getWebSocketAutoResponseTimestamp(held.ws);
    if (answered === null || this.now() - answered.getTime() <= RELAY_IDLE_TIMEOUT_MS)
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

  #held<R extends Conn["role"]>(role: R, tag: string = role) {
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
   * Admit `account` to this object: the first upgrade writes it, and one
   * naming any other is refused. The Worker names the object from that same
   * account, so a refusal here is an invariant broken upstream.
   */
  async #claim(account: string): Promise<boolean> {
    if (!account) return false;
    if ((await this.ctx.storage.get<string>(ACCOUNT_KEY)) === undefined)
      await this.ctx.storage.put(ACCOUNT_KEY, account);
    return this.#serves(account);
  }

  /** Whether this object serves `account`; one that never held a socket serves none. */
  async #serves(account: string): Promise<boolean> {
    const stored = await this.ctx.storage.get<string>(ACCOUNT_KEY);
    if (stored === undefined) return false;
    if (stored === account) return true;
    console.error("RelayRoom refused a request for another account");
    return false;
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
