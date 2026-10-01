import { RELAY_PING, RELAY_PING_INTERVAL_MS } from 'remote-lib-common';

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

/**
 * A relay socket's heartbeat (`docs/specs/relay.md` -> "Routing"): a
 * {@link RELAY_PING} every {@link RELAY_PING_INTERVAL_MS} while the socket is
 * held. Once a pong has arrived on it, a ping still unanswered when the next
 * one is due ends the socket through `onDead`; until then nothing is
 * enforced, so a Relay that never answers costs nothing.
 */
export class RelayHeartbeat {
  readonly #ws: RemoteWebSocket;
  readonly #setTimer: RemoteTimer;
  readonly #onDead: () => void;
  #cancel: (() => void) | null = null;
  /** A pong has arrived on this socket: from now on each ping must be answered. */
  #enforced = false;
  #answered = true;

  constructor(ws: RemoteWebSocket, setTimer: RemoteTimer, onDead: () => void) {
    this.#ws = ws;
    this.#setTimer = setTimer;
    this.#onDead = onDead;
    this.#arm();
  }

  /** The Relay's {@link RELAY_PONG} arrived. */
  pong(): void {
    this.#enforced = true;
    this.#answered = true;
  }

  /**
   * Stop pinging until {@link resume}: a page whose timers the browser
   * throttles would otherwise judge a pong it could not yet read.
   */
  pause(): void {
    this.stop();
  }

  /** Ping again from now, the last ping forgiven. */
  resume(): void {
    this.stop();
    this.#answered = true;
    this.#arm();
  }

  stop(): void {
    this.#cancel?.();
    this.#cancel = null;
  }

  #arm(): void {
    this.#cancel = this.#setTimer(() => {
      this.#cancel = null;
      if (this.#enforced && !this.#answered) {
        this.#onDead();
        return;
      }
      this.#answered = false;
      try {
        this.#ws.send(RELAY_PING);
      } catch {
        // socket mid-close
      }
      this.#arm();
    }, RELAY_PING_INTERVAL_MS);
  }
}
