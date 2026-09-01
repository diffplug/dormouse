/**
 * The relay socket both harness halves speak over: a real `WebSocket`, JSON
 * frames in and out, and the `frames` / `sent` arrays every assertion reads.
 *
 * Shared so `FakeHost` and `FakeClient` cannot drift into two opinions about
 * teardown or frame recording. It stays free of `server/test/helpers.mjs` —
 * `scripts/fake-host.mjs` imports `FakeHost` without a built server.
 */

/**
 * Attach a frame socket to `target` (an `EventEmitter`), setting `ws`,
 * `ready`, `closed`, `frames`, and `sent` on it and emitting `open`, `close`,
 * and `frame`. Returns the socket.
 */
export function attachFrameSocket(target, url) {
  const ws = new WebSocket(url);
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
  target.sent.push(frame);
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
  target.frames.push(frame);
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
