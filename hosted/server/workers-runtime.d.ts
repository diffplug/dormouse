// The Workers runtime surface `hosted/server/` uses beyond the DOM and Node
// typings, hand-typed to just the members called: `@cloudflare/workers-types`
// redeclares the DOM globals this program already has.

/** The server end of a `WebSocketPair` as a Durable Object holds it. */
interface WorkerWebSocket {
  readonly readyState: number;
  /** Accepts outside hibernation; events then go to listeners, not the object's handlers. */
  accept(): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

declare const WebSocketPair: {
  new (): { 0: WorkerWebSocket; 1: WorkerWebSocket };
};

/** A whole-message request the runtime answers without waking the object. */
declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}

interface DurableObjectState {
  acceptWebSocket(ws: WorkerWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WorkerWebSocket[];
  getTags(ws: WorkerWebSocket): string[];
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void;
  /** When the runtime last answered `ws` through the auto-response pair, or null if never. */
  getWebSocketAutoResponseTimestamp(ws: WorkerWebSocket): Date | null;
  /** The Worker's own named entrypoints, each callable as a loopback binding. */
  readonly exports: Record<string, unknown>;
  /** Run `callback` with no other event delivered to the object until it settles. */
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  readonly storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    list(): Promise<Map<string, unknown>>;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    deleteAll(): Promise<void>;
  };
}

interface DurableObjectId {
  readonly name?: string;
}

/** A Durable Object's stub: `fetch`, plus the RPC methods of the class `Stub` names. */
type DurableObjectStub<Stub = unknown> = {
  fetch(request: Request): Promise<Response>;
} & Stub;

interface DurableObjectNamespace<Stub = unknown> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<Stub>;
}

/** The base class whose public methods a stub calls as RPC. */
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
  /** A named entrypoint, its public methods called as RPC. */
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
  }
}

/** A `ratelimits` binding. */
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The runtime accepts the client end of a pair on a 101 response. */
interface ResponseInit {
  webSocket?: WorkerWebSocket;
}
