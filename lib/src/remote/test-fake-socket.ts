/**
 * The fake `WebSocket` both ends of the remote stack are tested against.
 *
 * Test-only, and shared on purpose: the Host controller, the Host service, and
 * the Pocket client all speak {@link RemoteWebSocket} and all need the same four
 * things — record what was sent, deliver a server frame, open, and close with a
 * code. Three private copies drifted into three different ideas of what a close
 * does, which is exactly the behavior the close-code policy turns on.
 */

import type { RemoteWebSocket } from './ws';

export class FakeSocket implements RemoteWebSocket {
  /** `CONNECTING` until {@link open}, as a real socket is. */
  readyState = 0;
  /**
   * Whether `close()` fires its own `close` event. A browser always does; a test
   * that replaces a socket without letting the old one settle sets this false.
   */
  closeEmits = true;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly #handlers = new Map<string, Array<(ev: unknown) => void>>();

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    const list = this.#handlers.get(type) ?? [];
    list.push(handler);
    this.#handlers.set(type, list);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
    if (this.closeEmits) this.closeWith(1000);
  }

  open(): void {
    this.readyState = 1;
    this.#emit('open', {});
  }

  /** Emit a close event with a specific code, as the relay or the network would. */
  closeWith(code: number): void {
    this.readyState = 3;
    this.#emit('close', { code });
  }

  /** The server or the network dropped the connection — no `close()` from us. */
  drop(): void {
    this.closeWith(1006);
  }

  /** A rejected upgrade: the browser fires `error` with no status, never `open`. */
  emitError(): void {
    this.readyState = 3;
    this.#emit('error', {});
  }

  /** Deliver one frame from the far end. */
  receive(frame: unknown): void {
    this.#emit('message', { data: JSON.stringify(frame) });
  }

  /** Every frame this socket was asked to send of one wire type. */
  frames(t: string): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame.t === t);
  }

  #emit(type: string, ev: unknown): void {
    for (const handler of this.#handlers.get(type) ?? []) handler(ev);
  }
}
