/**
 * The minimal WebSocket surface the remote client and burrow actually use — just
 * enough to send, close, and listen, so tests can inject a fake in place of a
 * real browser `WebSocket`. Shared by both sides so the contract cannot drift,
 * along with the timer seam each of them arms its deadlines on.
 */
export interface RemoteWebSocket {
  send(data: string): void;
  /** `code` where the caller names one; a real socket defaults to a status-less close. */
  close(code?: number): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    handler: (ev: unknown) => void,
  ): void;
  readyState: number;
}

/** The `code` of a `CloseEvent`, or undefined if the socket gave us none. */
export function closeCode(ev: unknown): number | undefined {
  const code = (ev as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * How both sides arm a timer: `(run, delayMs) => cancel`. Injected so a test
 * driving an injected clock never waits out a real deadline, and so "nothing is
 * armed any more" is a thing a test can observe.
 */
export type RemoteTimer = (run: () => void, delayMs: number) => () => void;

/** {@link RemoteTimer} over the burrow environment's own `setTimeout`. */
export const realTimer: RemoteTimer = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};
