import type { ExecutionContext } from "hono";
import { WS_ROUTES } from "remote-lib-common";
import { RELAY_ROOM_PARAMS } from "../relay-room-contract";
import worker, {
  OneTimeRoom,
  RelayRoom as ProductionRoom,
  RelayRows as ProductionRows,
} from "../relay-worker";

// Module state outlives an evicted object, so it counts what woke one.
let constructed = 0;
let handled = 0;
let skewMs = 0;
/** Whether a row read stalls, as a slow database would. */
let rowsStalled = false;
/** What each upgrade handed the object: its header names and search parameters. */
const upgrades: { headers: string[]; params: string[] }[] = [];

/**
 * The production `RelayRoom`, counting its wake-ups and handler calls, keeping
 * what each upgrade carried, and on a clock a test can move.
 */
export class RelayRoom extends ProductionRoom {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    constructed += 1;
  }

  protected override now() {
    return Date.now() + skewMs;
  }

  override async fetch(request: Request) {
    upgrades.push({
      headers: [...request.headers.keys()],
      params: [...new URL(request.url).searchParams.keys()],
    });
    return super.fetch(request);
  }

  override async webSocketMessage(ws: WorkerWebSocket, message: string | ArrayBuffer) {
    handled += 1;
    return super.webSocketMessage(ws, message);
  }

  override async webSocketClose(ws: WorkerWebSocket, code: number) {
    handled += 1;
    return super.webSocketClose(ws, code);
  }

  override async alarm() {
    handled += 1;
    return super.alarm();
  }

  /** The counters, the upgrades so far, every socket's attachment, what storage holds, and the alarm. */
  async probe() {
    return {
      constructed,
      handled,
      upgrades,
      attachments: this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment()),
      storage: Object.fromEntries(await this.ctx.storage.list()),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  /** Move this object's clock by `ms` from real time. */
  async skew(ms: number) {
    skewMs = ms;
  }

  /** Run the alarm now, as its time arriving would. */
  async fire() {
    await this.alarm();
  }

  /** Stall every row read from now, or stop stalling new ones. */
  async stallRows(on: boolean) {
    rowsStalled = on;
  }
}

/**
 * The production `RelayRows`, whose read, while stalled, waits past the 30 s
 * the runtime gives a `blockConcurrencyWhile` callback; a pending timer keeps
 * workerd from cancelling it as a hung request.
 */
export class RelayRows extends ProductionRows {
  override async burrows(burrowIds: string[]) {
    if (rowsStalled) await new Promise((resolve) => setTimeout(resolve, 60_000));
    return super.burrows(burrowIds);
  }
}

export { OneTimeRoom };

type TestEnv = { RELAY_ROOM: DurableObjectNamespace<Record<string, (...args: unknown[]) => unknown>> };

/**
 * The relay Worker, plus `POST /__test/room/<method>?account=<id>`: that
 * RPC on the account's object with the JSON body as its arguments, from
 * inside workerd so no stub outlives the request. `forge` instead hands the
 * object a Burrow upgrade naming the account and the Burrow in the body, as
 * the Worker would after resolving a token, and answers its status; a socket
 * it opens is closed at once.
 */
export default {
  async fetch(request: Request, env: TestEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const method = /^\/__test\/room\/(\w+)$/.exec(url.pathname)?.[1];
    if (!method) return worker.fetch(request, env as never, ctx);
    const account = url.searchParams.get("account")!;
    const room = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(account));
    const args = (await request.json()) as unknown[];
    if (method === "forge") {
      const target = new URL(WS_ROUTES.burrow, url.origin);
      target.searchParams.set(RELAY_ROOM_PARAMS.account, String(args[0]));
      target.searchParams.set(RELAY_ROOM_PARAMS.burrowId, String(args[1]));
      const response = await room.fetch(new Request(target, { headers: { upgrade: "websocket" } }));
      const socket = (response as { webSocket?: WorkerWebSocket | null }).webSocket;
      if (socket) {
        socket.accept();
        socket.close(1000);
      }
      return Response.json(response.status);
    }
    return Response.json((await room[method](...args)) ?? null);
  },
};
