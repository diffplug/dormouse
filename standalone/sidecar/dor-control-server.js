const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');

// Constant-time control-token check. A short-circuiting `!==` compare leaks the
// token byte-by-byte to a co-resident local process that can time the response,
// so hash both sides to fixed-length digests (side-stepping timingSafeEqual's
// length-mismatch throw, which would itself leak the token length) and compare
// those. Mirrors the SHA-256 + timingSafeEqual pattern the selfhost server uses
// in server/src/state.ts.
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// The server timeout must outlast the dor client's own deadline so the client
// always controls the outcome. (A shorter server timeout would fire first and
// send the client a spurious "timed out waiting for surface.ensure" while the
// webview was still legitimately working, e.g. waiting on shell integration or a
// server restart.) A request that carries its own `timeoutMs` — `dor await
// --timeout` can ask for many minutes — gets that plus a margin; anything else
// falls back to the `timeoutMs` option, whose 65s default clears the longest
// fixed client deadline (`dor ensure --restart` at 60s).
// In practice socket close reaps pending entries the instant the client gives up;
// this timer only releases a pending entry if the webview never answers at all.
const SERVER_TIMEOUT_MARGIN_MS = 10000;
// A parked request is cheap, but not free: cap the ceiling so a client that asks
// for a nonsense-but-finite deadline cannot pin an entry for the session's life.
const MAX_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function serverTimeoutFor(clientTimeoutMs, fallbackMs) {
  if (typeof clientTimeoutMs !== 'number' || !Number.isFinite(clientTimeoutMs) || clientTimeoutMs <= 0) {
    return fallbackMs;
  }
  return Math.min(clientTimeoutMs + SERVER_TIMEOUT_MARGIN_MS, MAX_REQUEST_TIMEOUT_MS);
}

function createDorControlServer({ socketPath, token, send, timeoutMs = 65000 }) {
  if (!socketPath || !token) return null;

  const pending = new Map();
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';

    // A `dor` client that times out destroys its socket; without this handler
    // the resulting ECONNRESET would surface as an uncaught exception and take
    // down the long-lived sidecar/pty-host.
    socket.on('error', () => {});

    // If the client disconnects (timeout/Ctrl-C) before the webview answers,
    // release any entries owned by this socket right away rather than letting
    // them linger until their own timeout fires against a dead socket. The
    // webview has to hear about it too: a long-running handler (a parked
    // `dor await`) holds state — a subscription, an armed watch, a completion
    // claim — that only a cancel releases.
    socket.on('close', () => {
      for (const [requestId, entry] of pending) {
        if (entry.socket !== socket) continue;
        reap(requestId);
        send('dor:controlCancel', { requestId });
      }
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handleRequest(socket, line);
    });
  });

  function handleRequest(socket, line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      writeResponse(socket, { ok: false, error: 'invalid JSON request' });
      return;
    }

    if (!tokenMatches(request.token, token)) {
      writeResponse(socket, { requestId: request.requestId, ok: false, error: 'invalid Dormouse control token' });
      return;
    }

    if (typeof request.requestId !== 'string' || typeof request.method !== 'string') {
      writeResponse(socket, { ok: false, error: 'invalid Dormouse control request' });
      return;
    }

    const timeout = setTimeout(() => {
      reap(request.requestId);
      writeResponse(socket, { requestId: request.requestId, ok: false, error: `timed out waiting for ${request.method}` });
      send('dor:controlCancel', { requestId: request.requestId });
    }, serverTimeoutFor(request.timeoutMs, timeoutMs));

    pending.set(request.requestId, { socket, timeout });
    send('dor:controlRequest', {
      requestId: request.requestId,
      surfaceId: typeof request.surfaceId === 'string' ? request.surfaceId : undefined,
      method: request.method,
      params: request.params ?? {},
    });
  }

  // Forget a pending request and stop its timer. Returns the entry, or
  // undefined if it was already reaped.
  function reap(requestId) {
    const entry = pending.get(requestId);
    if (!entry) return undefined;
    pending.delete(requestId);
    clearTimeout(entry.timeout);
    return entry;
  }

  function respond(response) {
    const requestId = response?.requestId;
    if (typeof requestId !== 'string') return;
    const entry = reap(requestId);
    // Unknown id: the entry was already reaped by a disconnect or a timeout and
    // the webview was told so. A late answer to a cancelled request is expected,
    // not an error — drop it silently.
    if (!entry) return;
    writeResponse(entry.socket, response);
  }

  // No `dor:controlCancel` here: close() runs on host shutdown, so the webview
  // that would act on it is going away too.
  function close() {
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timeout);
      writeResponse(entry.socket, { requestId, ok: false, error: 'Dormouse control server closed' });
    }
    pending.clear();
    try {
      server.close();
    } catch {
      // Already closed or never opened.
    }
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(socketPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error(`[dor-control] failed to remove socket: ${error.message}`);
        }
      }
    }
  }

  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(socketPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  server.listen(socketPath, () => {
    console.error(`[dor-control] listening on ${socketPath}`);
    resolveReady();
  });
  server.on('error', (error) => {
    console.error(`[dor-control] ${error.message}`);
    rejectReady(error);
  });
  ready.catch(() => {
    // `ready` is used by tests; production logs listen failures through the
    // server error handler and keeps the sidecar alive for normal PTY work.
  });

  return { close, ready, respond };
}

function writeResponse(socket, response) {
  // The peer may have already gone away (client timeout/Ctrl-C destroyed the
  // socket) by the time a late webview response or the server timeout fires.
  if (socket.destroyed || socket.writableEnded) return;
  try {
    socket.end(`${JSON.stringify(response)}\n`);
  } catch {
    // Socket closed underneath us; nothing to deliver.
  }
}

module.exports = { createDorControlServer };
