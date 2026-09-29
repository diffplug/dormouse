/**
 * What both ends of a one-time connection do with their rendezvous socket
 * (`docs/specs/one-time.md` -> "Wire contract"): measure a message before
 * parsing it, keep the path alive, and stop reading the socket before closing
 * it. Shared by the laptop's `OneTimeRuntime` and the phone's `OneTimeClient`,
 * which read and let go of a room the same way; each keeps its own `sendFrame`,
 * since only the phone's may throw.
 */

import {
  MAX_ONE_TIME_FRAME_LENGTH,
  ONE_TIME_PING,
  ONE_TIME_PING_INTERVAL_MS,
} from 'remote-lib-common';

import type { RemoteTimer, RemoteWebSocket } from './ws';

/** The close an end ends its own rendezvous socket with. */
const NORMAL_CLOSURE = 1000;

/**
 * One rendezvous message as JSON, or `undefined`. **Measured before the parse,
 * not after**: every guard reads a value `JSON.parse` has already materialized,
 * so without this a hostile room buys an unbounded parse — on the laptop, in
 * the process that owns every PTY. A non-string payload is dropped the same way.
 */
export function parseOneTimeFrame(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length > MAX_ONE_TIME_FRAME_LENGTH) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The one rendezvous socket an end reads, and the keepalive that runs while it is open. */
export class RendezvousHold {
  readonly #setTimer: RemoteTimer;
  /**
   * The socket, while its end still reads it. Nulled — before `close()`, so its
   * own close event is ignored — at the switch and at the end, and by its own
   * close.
   */
  #ws: RemoteWebSocket | null = null;
  #cancelPing: (() => void) | null = null;

  constructor(setTimer: RemoteTimer) {
    this.#setTimer = setTimer;
  }

  /** The socket still read, or `null`. */
  get socket(): RemoteWebSocket | null {
    return this.#ws;
  }

  /** Read `ws` from here on. */
  hold(ws: RemoteWebSocket): void {
    this.#ws = ws;
  }

  /** Whether `ws` is the socket still read: only its events are events. */
  reads(ws: RemoteWebSocket): boolean {
    return this.#ws === ws;
  }

  /** Keep the socket's path alive while it is open; the room answers without waking. */
  armPing(ws: RemoteWebSocket): void {
    this.#cancelPing = this.#setTimer(() => {
      this.#cancelPing = null;
      if (this.#ws !== ws) return;
      try {
        ws.send(ONE_TIME_PING);
      } catch {
        // socket mid-close
      }
      this.armPing(ws);
    }, ONE_TIME_PING_INTERVAL_MS);
  }

  /** Stop reading the socket: nothing it says or does from here is an event. */
  detach(): RemoteWebSocket | null {
    const ws = this.#ws;
    this.#ws = null;
    this.#cancelPing?.();
    this.#cancelPing = null;
    return ws;
  }

  /** Detach the socket, then close it normally. */
  close(): void {
    const ws = this.detach();
    try {
      ws?.close(NORMAL_CLOSURE);
    } catch {
      // already closing
    }
  }
}
