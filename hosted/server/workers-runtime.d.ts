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
  readonly storage: {
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    deleteAll(): Promise<void>;
  };
}

interface DurableObjectId {
  readonly name?: string;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

/** A `ratelimits` binding. */
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The runtime accepts the client end of a pair on a 101 response. */
interface ResponseInit {
  webSocket?: WorkerWebSocket;
}
