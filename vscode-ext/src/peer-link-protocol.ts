/**
 * The wire between VS Code windows (docs/specs/vscode.md → "Peer surfaces
 * across windows").
 *
 * Within a window the extension host can see every webview, so brokering is a
 * function call. Across windows there is no shared process at all — one
 * extension host per window — so the window holding the Host lease listens on a
 * local socket and the others connect to it. This module is the part with no
 * sockets in it: the frame shapes, the newline-delimited framing, the table that
 * remembers which window a streaming PTY came from, and the handshake
 * primitives the two ends prove the shared token with.
 *
 * Kept free of sockets, so the protocol's edge cases (a split frame, a peer that
 * vanishes mid-attach, a proof over the wrong nonce) are testable without
 * spawning processes. `peer-link.ts` is the I/O and the lifecycle on top.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  ASK_BUDGET_MS,
  type RemoteHostCommand,
  type RemoteHostResult,
} from '../../lib/src/host/remote/service-protocol';

/**
 * How long the broker waits for another window to answer before giving up on it.
 *
 * Must exceed {@link ASK_BUDGET_MS}, the budget that window then spends fanning
 * the same question out to its own webviews, or a slow sibling shows up here as
 * a timeout instead of as the incomplete answer it really is — and the broker
 * would discard results that were on their way. The margin also covers the two
 * socket hops the inner budget knows nothing about.
 */
export const PEER_REPLY_BUDGET_MS = ASK_BUDGET_MS + 2_000;

/**
 * Broker → peer window.
 *
 * `request` carries one peer operation, and `op` is opaque here: what a peer
 * may be asked is a property of the remote Host, not of the transport, so the
 * operation map and its real types live in `lib/src/remote/host/peer-surfaces.ts`
 * and this layer only moves the bytes. Adding an operation touches neither this
 * file nor the socket code.
 *
 * Only `request` carries a frame id, because only `request` is awaited. The
 * four PTY frames are one-way instructions to the owning window: nothing waits
 * on them, and the stream they start is correlated by `ptyId`.
 */
export type PeerLinkRequest =
  | { kind: 'request'; id: string; op: string; params: unknown }
  | { kind: 'subscribe'; ptyId: string }
  | { kind: 'unsubscribe'; ptyId: string }
  | { kind: 'write'; ptyId: string; data: string }
  | { kind: 'resizePty'; ptyId: string; cols: number; rows: number }
  /**
   * What the Host service made of a {@link PeerLinkResponse} `command`, sent
   * back to the one window that forwarded it and to no other. There is no frame
   * id because `rhId` already is one: every adapter mints it with a random tag
   * of its own, so it is unique across every window and is exactly what the
   * asking webview correlates by (`lib/src/lib/platform/vscode-adapter.ts`).
   */
  | { kind: 'commandResult'; payload: RemoteHostResult }
  /**
   * A Host UI event, broadcast to every authenticated window. Unsolicited and
   * unaddressed: the pairing queue has to reach whatever webviews exist, since
   * any of them may be the one in front of the user (docs/specs/vscode.md).
   */
  | { kind: 'uiEvent'; payload: unknown };

/** Peer window → broker. */
export type PeerLinkResponse =
  /**
   * Everything that window's webviews answered, concatenated. A peer that owns
   * nothing the request named contributes no results, so an empty array is how
   * "not mine" arrives.
   */
  | { kind: 'result'; id: string; results: unknown[] }
  /** Unsolicited: bytes from a PTY the broker subscribed to. */
  | { kind: 'data'; ptyId: string; data: string }
  /** Unsolicited: that PTY ended. */
  | { kind: 'exit'; ptyId: string; exitCode: number }
  /** Unsolicited: future peer-query answers may differ, so re-collect. */
  | { kind: 'notify' }
  /**
   * Unsolicited: a webview command from a window with no Host of its own. Only
   * the broker runs a service, so a losing window's console hook, pairing
   * answer, and push all travel this way and come back as `commandResult`.
   */
  | { kind: 'command'; payload: RemoteHostCommand };

export type PeerLinkFrame = PeerLinkRequest | PeerLinkResponse;

/**
 * The three-frame opening handshake, in order: `challenge` (server → client),
 * `hello` (client → server), `welcome` (server → client).
 *
 * The shared secret never crosses the socket. Each side proves it knows the
 * token by answering the *other* side's fresh nonce with an HMAC over it, so a
 * co-resident process that guessed the socket path learns nothing it can replay:
 * the proofs are bound to nonces it did not choose, and its own challenge buys
 * it only an HMAC of a value it picked, which is not the token.
 *
 * The server speaks first and the client verifies the `welcome` before it sends
 * or answers anything else. That direction is what makes squatting the path
 * useless rather than merely expensive — a fake server never proves knowledge of
 * the token, so a client hands it no directory, no PTY stream, and no commands
 * (`vscode-ext/src/peer-link.ts`).
 */
export interface PeerLinkChallenge {
  kind: 'challenge';
  /** Server nonce, base64url. The client's proof is over this. */
  nonce: string;
}

export interface PeerLinkHello {
  kind: 'hello';
  /** Client nonce, base64url. The server's proof is over this. */
  nonce: string;
  /** `HMAC-SHA256(token, PEER_CLIENT_PROOF_DOMAIN + serverNonce)`, base64url. */
  proof: string;
}

export interface PeerLinkWelcome {
  kind: 'welcome';
  /** `HMAC-SHA256(token, PEER_SERVER_PROOF_DOMAIN + clientNonce)`, base64url. */
  proof: string;
}

/**
 * Domain separation. Without distinct prefixes the two proofs are the same
 * function of the same key, so a fake server could reflect a client's own proof
 * back as its welcome and pass for a broker that knows the token.
 */
export const PEER_CLIENT_PROOF_DOMAIN = 'client:';
export const PEER_SERVER_PROOF_DOMAIN = 'server:';

export type PeerLinkHandshake = PeerLinkChallenge | PeerLinkHello | PeerLinkWelcome;

/**
 * One side's proof that it holds the token, computed over the *other* side's
 * fresh nonce.
 *
 * The token never crosses the socket, so a process that guessed the path and
 * captured the whole exchange has an HMAC over a nonce that will never be used
 * again, and nothing it can replay. `domain` is what keeps the two directions
 * from being the same function of the same key — without it a fake server could
 * reflect the client's own proof back as its welcome and pass for a broker.
 */
export function proveToken(token: string, domain: string, nonce: string): string {
  return createHmac('sha256', token).update(domain + nonce).digest('base64url');
}

/**
 * Constant-time proof compare, with the same property the `dor` control socket's
 * `tokenMatches` has and for the same reason: `!==` on a secret-derived value
 * leaks it byte-by-byte to a co-resident local process that can time the
 * response, which is precisely the attacker this handshake exists to stop.
 * (That module is CommonJS and cannot import this one, so it keeps a deliberate
 * second copy; this is the one copy for the peer link.)
 */
export function proofMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** 128 bits, so no connection ever reuses another's challenge. */
export function freshNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function encodeFrame(frame: PeerLinkFrame | PeerLinkHandshake): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Accumulates socket chunks and yields whole frames.
 *
 * A socket splits writes wherever it likes, so a frame can arrive in pieces or
 * several can arrive together; anything unparseable is dropped rather than
 * killing the link.
 */
export class FrameDecoder {
  #buffer = '';
  /**
   * Set once one frame has outgrown the cap: everything up to the next newline
   * belongs to that frame and is dropped, and normal accumulation resumes after
   * it. Resetting the buffer without this would resync mid-frame and read the
   * oversized frame's tail as frames of its own.
   */
  #discarding = false;
  readonly #maxFrameBytes: number;

  /** Bounds a peer that never sends a newline; the default fits a screenful. */
  constructor(maxFrameBytes = 4 * 1024 * 1024) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: string): unknown[] {
    this.#buffer += chunk;
    const frames: unknown[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (this.#discarding) {
        // That was the oversized frame's terminator; the bytes after it are a
        // frame boundary again.
        this.#discarding = false;
        continue;
      }
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        // Malformed frame: skip it, keep the link.
      }
    }
    // Whatever is left is one unterminated frame. Past the cap it is a frame we
    // can never read, so it goes — but the whole frames already taken out of
    // the buffer above are real, and dropping them with it would lose traffic
    // from a link that is otherwise healthy.
    if (this.#buffer.length > this.#maxFrameBytes) this.#discarding = true;
    if (this.#discarding) this.#buffer = '';
    return frames;
  }
}

/**
 * The one field the transport reads out of an otherwise opaque answer.
 *
 * Reserved: an answer that names a `ptyId` is claiming the PTY behind it, and
 * that is the only way the broker can learn which window a PTY lives in — a
 * `ptyId` on its own says nothing about where it is, and every later write,
 * resize, and subscribe has to reach that window. Any peer operation whose
 * result carries a `ptyId` therefore gets routed by it; nothing else about the
 * answer is interpreted here.
 */
export function routedPtyId(result: unknown): string | null {
  const ptyId = (result as { ptyId?: unknown } | null | undefined)?.ptyId;
  return typeof ptyId === 'string' ? ptyId : null;
}

/**
 * Drop every PTY routed to `peer`, and report what was dropped.
 *
 * The broker records where a streaming PTY lives when an attach succeeds — a
 * `ptyId` alone says nothing about which window owns it, and input and resizes
 * have to reach that window. When the window goes away its terminals go with
 * it, and a later write must not be posted into a dead socket. The routes
 * themselves are a plain `Map`; only this needs explaining.
 */
export function forgetPeerRoutes<T>(routes: Map<string, T>, peer: T): string[] {
  const dropped: string[] = [];
  for (const [ptyId, owner] of routes) {
    if (owner !== peer) continue;
    dropped.push(ptyId);
    routes.delete(ptyId);
  }
  return dropped;
}
