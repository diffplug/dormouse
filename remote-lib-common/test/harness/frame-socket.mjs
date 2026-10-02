/**
 * The relay socket both harness halves speak over: a real `WebSocket`, JSON
 * frames in and out, and the `frames` / `sent` arrays every assertion reads.
 *
 * Shared so `FakeBurrow` and `FakeClient` cannot drift into two opinions about
 * teardown or frame recording. It stays free of any one Relay — the self-host
 * suites, `relay/scripts/fake-burrow.mjs`, and Hosted's Durable Object suite
 * all drive it.
 */

/**
 * The most frames either log keeps. A test case sends tens; `scripts/fake-burrow.mjs`
 * is a long-running dev stand-in driving a live echo terminal, and would
 * otherwise retain every relayed PTY byte for the life of the process.
 */
const MAX_LOGGED_FRAMES = 1000;

function record(log, frame) {
  log.push(frame);
  if (log.length > MAX_LOGGED_FRAMES) log.shift();
}

/**
 * Attach a frame socket to `target` (an `EventEmitter`), setting `ws`,
 * `ready`, `closed`, `frames`, and `sent` on it and emitting `open`, `close`,
 * and `frame`. Returns the socket.
 *
 * `socket` replaces the real `WebSocket` — how the malicious-relay harness puts
 * a peer it controls between the two halves without changing either of them.
 * `init` is Node's `WebSocket` options: `{ headers }` gives a socket the
 * `Origin` a browser would send.
 */
export function attachFrameSocket(target, url, socket, init) {
  const ws = socket ?? new WebSocket(url, init);
  target.ws = ws;
  /** Every frame the relay delivered, and every frame this peer sent. */
  target.frames = [];
  target.sent = [];
  target.ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      target.emit('open');
      resolve();
    });
    ws.addEventListener('error', (ev) => reject(ev.error ?? new Error(`ws error: ${url}`)));
    ws.addEventListener('close', (ev) => reject(new Error(`closed before open (${ev.code})`)));
  });
  target.closed = new Promise((resolve) => ws.addEventListener('close', (ev) => resolve(ev)));
  ws.addEventListener('close', (ev) => target.emit('close', ev));
  return ws;
}

/** Put a frame on the wire exactly as given — the tamper tests' door. */
export function sendFrame(target, frame) {
  record(target.sent, frame);
  try {
    target.ws.send(JSON.stringify(frame));
  } catch {
    /* socket mid-close */
  }
}

/** Parse one incoming message, record it, and emit `frame`; `undefined` if not JSON. */
export function receiveFrame(target, data) {
  let frame;
  try {
    frame = JSON.parse(typeof data === 'string' ? data : '');
  } catch {
    return undefined;
  }
  if (!frame || typeof frame.t !== 'string') return undefined;
  record(target.frames, frame);
  target.emit('frame', frame);
  return frame;
}

/** True if no frame arrives within `ms` — the "the relay dropped it" oracle. */
export async function quiet(target, ms = 80) {
  const before = target.frames.length;
  await new Promise((resolve) => setTimeout(resolve, ms));
  return target.frames.length === before;
}

/**
 * The next frame matching `predicate`, or a rejection after `timeout`.
 * Already-received frames count: a predicate here names one specific answer,
 * so matching one that arrived a tick ago is the intended behavior.
 */
export function waitForFrame(target, predicate, timeout = 2000) {
  const existing = target.frames.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.off('frame', onFrame);
      reject(new Error('no matching frame in time'));
    }, timeout);
    const onFrame = (frame) => {
      if (!predicate(frame)) return;
      clearTimeout(timer);
      target.off('frame', onFrame);
      resolve(frame);
    };
    target.on('frame', onFrame);
  });
}

/** Close the socket, tolerating one that is already closing. */
export function closeSocket(target) {
  try {
    target.ws.close();
  } catch {
    /* already closing */
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `fn` until it returns truthy, or throw after `timeout`ms. */
export async function until(fn, { timeout = 1000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(interval);
  }
}

/**
 * Open a WebSocket and wrap it in a tiny test harness: `ready` resolves on open
 * (rejects on a failed upgrade), `take()` yields received frames in order with
 * an internal cursor — JSON parsed, anything else (a pong) as its text — and
 * `quiet()` asserts no frame arrived in a window. `init` as
 * {@link attachFrameSocket} takes it.
 */
export function openFrameSocket(url, init) {
  const ws = new WebSocket(url, init);
  const messages = [];
  let cursor = 0;
  ws.addEventListener('message', (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : '';
    try {
      messages.push(JSON.parse(text));
    } catch {
      messages.push(text);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (ev) => reject(ev.error ?? new Error('ws error')));
    ws.addEventListener('close', (ev) => reject(new Error(`closed before open (${ev.code})`)));
  });
  // Unhandled when a test expects the upgrade to fail and awaits `closed` instead.
  ready.catch(() => {});
  const closed = new Promise((resolve) => ws.addEventListener('close', (ev) => resolve(ev)));
  return {
    ws,
    ready,
    closed,
    messages,
    send: (frame) => ws.send(JSON.stringify(frame)),
    close: () => ws.close(),
    /** Next unconsumed frame, waiting up to `timeout`ms for it to arrive. */
    async take(timeout = 1000) {
      await until(() => messages.length > cursor, { timeout });
      return messages[cursor++];
    },
    /** True if no new frame arrives within `ms` (i.e. the pipe stayed blocked). */
    async quiet(ms = 60) {
      const before = messages.length;
      await sleep(ms);
      return messages.length === before;
    },
  };
}
