/**
 * The wire between VS Code windows (docs/specs/vscode.md → "Peer surfaces
 * across windows").
 *
 * Within a window the extension host can see every webview, so brokering is a
 * function call. Across windows there is no shared process at all — one
 * extension host per window — so the window holding the Host lease listens on a
 * local socket and the others connect to it. This module is the part with no
 * sockets in it: the frame shapes, the newline-delimited framing, and the table
 * that remembers which window a streaming PTY came from.
 *
 * Kept free of sockets — and of Node imports, so the webview side can share
 * its types and budgets — meaning the protocol's edge cases (a split frame, a peer
 * that vanishes mid-attach) are testable without spawning processes.
 */

/** How long the broker waits for a window to answer before giving up on it. */
export const PEER_REPLY_BUDGET_MS = 1_000;

/**
 * The webview's budget for a round trip through the broker. Must exceed
 * {@link PEER_REPLY_BUDGET_MS}, or a slow sibling shows up as a timeout on the
 * asking side instead of as an incomplete answer.
 */
export const PEER_REQUEST_TIMEOUT_MS = 3_000;

/**
 * Broker → peer window.
 *
 * `request` carries one peer operation, and `op` is opaque here: what a peer
 * may be asked is a property of the remote Host, not of the transport, so the
 * operation map and its real types live in `lib/src/remote/host/peer-surfaces.ts`
 * and this layer only moves the bytes. Adding an operation touches neither this
 * file nor the socket code.
 */
export type PeerLinkRequest =
  | { kind: 'request'; id: string; op: string; params: unknown }
  | { kind: 'subscribe'; id: string; ptyId: string }
  | { kind: 'unsubscribe'; id: string; ptyId: string }
  | { kind: 'write'; id: string; ptyId: string; data: string }
  | { kind: 'resizePty'; id: string; ptyId: string; cols: number; rows: number };

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
  /** Unsolicited: future peer-query answers for this topic may differ. */
  | { kind: 'notify'; topic: string | null };

export type PeerLinkFrame = PeerLinkRequest | PeerLinkResponse;

/** The first frame a client sends; the server drops the socket if it mismatches. */
export interface PeerLinkHello {
  kind: 'hello';
  token: string;
}

export function encodeFrame(frame: PeerLinkFrame | PeerLinkHello): string {
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
  readonly #maxFrameBytes: number;

  /** Bounds a peer that never sends a newline; the default fits a screenful. */
  constructor(maxFrameBytes = 4 * 1024 * 1024) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: string): unknown[] {
    this.#buffer += chunk;
    if (this.#buffer.length > this.#maxFrameBytes) {
      // A peer that will not terminate a frame is not one we can talk to.
      this.#buffer = '';
      return [];
    }
    const frames: unknown[] = [];
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim()) {
        try {
          frames.push(JSON.parse(line));
        } catch {
          // Malformed frame: skip it, keep the link.
        }
      }
      newline = this.#buffer.indexOf('\n');
    }
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
