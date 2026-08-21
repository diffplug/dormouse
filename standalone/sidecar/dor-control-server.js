const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// Handshake proof domains. Separating the two directions keeps a proof the
// server emitted from being replayable as a client's answer and vice versa.
const CLIENT_PROOF_DOMAIN = 'dor-control/client';
const SERVER_PROOF_DOMAIN = 'dor-control/server';

// A client that connects and then says nothing holds a socket (and, on Windows,
// a pipe instance) open forever. Nothing legitimate needs longer than this to
// answer a challenge it already has the token for.
const HANDSHAKE_BUDGET_MS = 10_000;

function proveToken(token, domain, nonce) {
  return crypto.createHmac('sha256', token).update(`${domain} ${nonce}`).digest('hex');
}

// Constant-time proof check. A short-circuiting `!==` compare leaks the expected
// proof byte-by-byte to a co-resident local process that can time the response,
// so hash both sides to fixed-length digests (side-stepping timingSafeEqual's
// length-mismatch throw, which would itself leak the length) and compare those.
// Mirrors the SHA-256 + timingSafeEqual pattern the selfhost server uses in
// server/src/state.ts.
function proofMatches(provided, expected) {
  if (typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * The per-user directory the POSIX control socket lives in.
 *
 * `os.tmpdir()` is world-writable, so a socket sitting directly in it can be
 * created first by any other principal on the box. A private directory they
 * cannot write to takes that away before the handshake has to. Mirrors
 * `peerDirPath()` in vscode-ext/src/peer-link.ts.
 */
function controlDirPath() {
  return path.join(os.tmpdir(), `dormouse-dor-${process.getuid?.() ?? 0}`);
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/**
 * Make the per-user socket directory and report whether it is safe to use.
 *
 * Anything but a plain directory of ours at mode 0700 is somebody else's,
 * possibly on purpose, and no amount of retrying makes it ours — so the caller
 * stands the control channel down rather than binding inside it. Returns the
 * directory when it is safe, `null` when it is not.
 */
function ensureControlDir(dir = controlDirPath()) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Already there, or unwritable — the checks below decide either way.
  }
  const uid = process.getuid?.();
  let info = lstatOrNull(dir);
  // Ours but loose — a permissive umask, or a directory from before this check
  // existed. Tightening something we already own is safe and keeps the test
  // below exact rather than "0700 or better".
  if (info?.isDirectory() && info.uid === uid && (info.mode & 0o777) !== 0o700) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Not ours to tighten; the re-stat below fails the check.
    }
    info = lstatOrNull(dir);
  }
  const safe =
    !!info &&
    info.isDirectory() &&
    // `lstat` does not follow, so a symlink reports as one rather than as
    // whatever it points at — which is the whole reason it is `lstat`.
    !info.isSymbolicLink() &&
    info.uid === uid &&
    (info.mode & 0o777) === 0o700;
  return safe ? dir : null;
}

/**
 * A fresh, unguessable path for this host process's control channel.
 *
 * Random rather than derived from the PID: a PID is enumerable and recycled, so
 * a PID-derived name lets another principal create the path (POSIX) or take the
 * pipe name (Windows) before Dormouse gets there. 8 bytes keeps the POSIX path
 * clear of the ~104-byte sun_path cap on macOS, whose `os.tmpdir()` is already
 * ~50 bytes on its own.
 *
 * Returns `null` when the POSIX directory cannot be made private — the caller
 * must treat that as a dead control channel, not as a reason to bind anyway.
 */
function resolveControlSocketPath(dir) {
  const unique = crypto.randomBytes(8).toString('hex');
  if (process.platform === 'win32') {
    // Named pipes are not filesystem objects and carry their own ACL, so there
    // is no directory to harden here; unpredictability is what is left.
    return `\\\\.\\pipe\\dormouse-dor-${unique}`;
  }
  const safeDir = ensureControlDir(dir);
  if (!safeDir) return null;
  return path.join(safeDir, `${unique}.sock`);
}

// The server timeout must outlast the dor client's own deadline so the client
// always controls the outcome — its longest is `dor ensure --restart` at 60s, so
// 65s clears it. (A shorter server timeout would fire first and send the client a
// spurious "timed out waiting for surface.ensure" while the webview was still
// legitimately working, e.g. waiting on shell integration or a server restart.)
// In practice socket close reaps pending entries the instant the client gives up;
// this timer only releases a pending entry if the webview never answers at all.
//
// `socketPath` and `socketDir` are test seams: production callers leave both
// unset and take the hardened path this module picks, which they then hand to
// spawned shells.
function createDorControlServer({ socketPath, socketDir, token, send, timeoutMs = 65000 }) {
  if (!token) return null;

  const effectiveSocketPath = socketPath || resolveControlSocketPath(socketDir);
  if (!effectiveSocketPath) {
    const error = new Error(
      `${socketDir || controlDirPath()} is not a private directory of this user; the dor control channel is off`,
    );
    console.error(`[dor-control] ${error.message}`);
    const failed = Promise.reject(error);
    failed.catch(() => {});
    return { close() {}, ready: failed, respond() {}, socketPath: null };
  }

  const pending = new Map();
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {
    // Callers gate the environment of spawned shells on `ready` and keep the
    // sidecar/pty-host alive for normal PTY work; this handler only stops an
    // unhandled rejection from taking the process down first.
  });
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let authenticated = false;
    const challenge = crypto.randomBytes(16).toString('hex');
    const handshakeTimer = setTimeout(() => socket.destroy(), HANDSHAKE_BUDGET_MS);
    handshakeTimer.unref?.();

    // A `dor` client that times out destroys its socket; without this handler
    // the resulting ECONNRESET would surface as an uncaught exception and take
    // down the long-lived sidecar/pty-host.
    socket.on('error', () => {});

    // If the client disconnects (timeout/Ctrl-C) before the webview answers,
    // release any entries owned by this socket right away rather than letting
    // them linger until their own timeout fires against a dead socket.
    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      for (const [requestId, entry] of pending) {
        if (entry.socket !== socket) continue;
        if (entry.timeout) clearTimeout(entry.timeout);
        pending.delete(requestId);
      }
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!authenticated) {
          // Nothing is answered — not even an error — until the peer has proven
          // it holds the token. A wrong answer is indistinguishable from a port
          // scan, and neither deserves a reply.
          if (!acceptHello(socket, line, challenge)) {
            socket.destroy();
            return;
          }
          authenticated = true;
          clearTimeout(handshakeTimer);
        } else {
          handleRequest(socket, line);
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });

    // The server speaks first, on purpose: a client that has not yet seen proof
    // of the token must not volunteer one into whatever bound this path.
    socket.write(`${JSON.stringify({ kind: 'challenge', nonce: challenge })}\n`);
  });

  function acceptHello(socket, line, challenge) {
    let hello;
    try {
      hello = JSON.parse(line);
    } catch {
      return false;
    }
    if (!hello || hello.kind !== 'hello' || typeof hello.nonce !== 'string' || !hello.nonce) return false;
    if (!proofMatches(hello.proof, proveToken(token, CLIENT_PROOF_DOMAIN, challenge))) return false;
    // Our half, over the nonce *it* chose: answering a challenge proves nothing
    // about the challenger, so the client sends no request until it has this.
    socket.write(
      `${JSON.stringify({ kind: 'welcome', proof: proveToken(token, SERVER_PROOF_DOMAIN, hello.nonce) })}\n`,
    );
    return true;
  }

  function handleRequest(socket, line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      writeResponse(socket, { ok: false, error: 'invalid JSON request' });
      return;
    }

    if (typeof request.requestId !== 'string' || typeof request.method !== 'string') {
      writeResponse(socket, { ok: false, error: 'invalid Dormouse control request' });
      return;
    }

    const timeout = setTimeout(() => {
      pending.delete(request.requestId);
      writeResponse(socket, { requestId: request.requestId, ok: false, error: `timed out waiting for ${request.method}` });
    }, timeoutMs);

    pending.set(request.requestId, { socket, timeout });
    send('dor:controlRequest', {
      requestId: request.requestId,
      surfaceId: typeof request.surfaceId === 'string' ? request.surfaceId : undefined,
      method: request.method,
      params: request.params ?? {},
    });
  }

  function respond(response) {
    const requestId = response?.requestId;
    if (typeof requestId !== 'string') return;
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timeout);
    writeResponse(entry.socket, response);
  }

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
        fs.unlinkSync(effectiveSocketPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error(`[dor-control] failed to remove socket: ${error.message}`);
        }
      }
    }
  }

  // Clear a socket file left behind by a crash. A failure here means somebody
  // else's file is sitting on the path — which is fatal to the control channel
  // but, like a lost `listen`, must not be fatal to the host: throwing from this
  // constructor would take the sidecar (and every PTY in it) down with it.
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(effectiveSocketPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`[dor-control] ${error.message}`);
        rejectReady(error);
        // Not `close`: nothing is listening and nothing is pending, and its
        // unlink would delete the very file we just failed to claim.
        return { close() {}, ready, respond() {}, socketPath: null };
      }
    }
  }

  server.listen(effectiveSocketPath, () => {
    console.error(`[dor-control] listening on ${effectiveSocketPath}`);
    resolveReady();
  });
  server.on('error', (error) => {
    console.error(`[dor-control] ${error.message}`);
    rejectReady(error);
  });

  return { close, ready, respond, socketPath: effectiveSocketPath };
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

module.exports = {
  createDorControlServer,
  controlDirPath,
  ensureControlDir,
  resolveControlSocketPath,
  proveToken,
  CLIENT_PROOF_DOMAIN,
  SERVER_PROOF_DOMAIN,
};
