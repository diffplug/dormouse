/**
 * The minimal WebSocket surface the remote client and host actually use — just
 * enough to send, close, and listen, so tests can inject a fake in place of a
 * real browser `WebSocket`. Shared by both sides so the contract cannot drift.
 */
export interface RemoteWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    handler: (ev: unknown) => void,
  ): void;
  readyState: number;
}
