/**
 * A `WebSocket`-shaped pair, in memory, for putting a relay a test controls
 * between the two harness halves.
 *
 * Only what `frame-socket.mjs` and `relay/src/relay.ts` actually use:
 * `addEventListener` for `open` / `message` / `close`, `send`, and `close`.
 * Delivery is a microtask later, as a real socket's is — a synchronous one
 * would let a peer observe its own frame before its caller returned, which is
 * an ordering no network provides.
 */

class MemorySocket {
  constructor() {
    this.peer = null;
    this.closed = false;
    this.opened = false;
    this.handlers = new Map();
  }

  addEventListener(type, handler) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    // A late `open` listener still fires. The two peers are handed to their
    // halves several awaits apart — the Client is built after the Host's own
    // upgrade and a sign-in — so a one-shot event would be missed by whichever
    // half attached second, and its `ready` would never settle.
    if (type === 'open' && this.opened) queueMicrotask(() => handler({}));
  }

  emit(type, event) {
    if (type === 'open') this.opened = true;
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }

  send(data) {
    if (this.closed) throw new Error('socket is closed');
    queueMicrotask(() => {
      if (this.peer && !this.peer.closed) this.peer.emit('message', { data });
    });
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', { code, reason });
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer && !peer.closed) {
        peer.closed = true;
        peer.emit('close', { code, reason });
      }
    });
  }
}

/**
 * Two linked sockets. Both fire `open` on the next macrotask, so a caller that
 * attaches its listeners synchronously — which both harness halves do — always
 * sees it.
 */
export function memorySocketPair() {
  const a = new MemorySocket();
  const b = new MemorySocket();
  a.peer = b;
  b.peer = a;
  setTimeout(() => {
    a.emit('open', {});
    b.emit('open', {});
  }, 0);
  return [a, b];
}

/**
 * A one-sided `RelaySocket` that records rather than delivers: what the hub
 * sent it, and how it was closed. For the cases that drive `RelayHub` directly
 * — revocation, displacement, the socket sweeps — where a peer would only add
 * timing to an assertion about a decision.
 *
 * `closed` is derived, so a case may assert either "it was closed" or the exact
 * code the contract names.
 */
export function recordingSocket() {
  return {
    sent: [],
    closeCode: null,
    closeReason: null,
    get closed() {
      return this.closeCode !== null;
    },
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    close(code = 1000, reason = '') {
      this.closeCode = code;
      this.closeReason = reason;
    },
  };
}
