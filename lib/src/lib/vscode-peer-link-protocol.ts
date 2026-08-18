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
 * Kept pure so the protocol's edge cases (a split frame, a peer that vanishes
 * mid-attach) are testable without spawning processes.
 */

/** Broker → peer window. */
export type PeerLinkRequest =
  | { kind: 'directory'; id: string }
  | {
      kind: 'surfaceOp';
      id: string;
      surfaceId: string;
      op: 'attach' | 'detach' | 'resize';
      cols?: number;
      rows?: number;
    }
  | { kind: 'subscribe'; id: string; ptyId: string }
  | { kind: 'unsubscribe'; id: string; ptyId: string }
  | { kind: 'write'; id: string; ptyId: string; data: string }
  | { kind: 'resizePty'; id: string; ptyId: string; cols: number; rows: number };

/** Peer window → broker. */
export type PeerLinkResponse =
  | { kind: 'directoryResult'; id: string; entries: unknown[] }
  | {
      kind: 'surfaceResult';
      id: string;
      ok: boolean;
      ptyId?: string;
      cols?: number;
      rows?: number;
    }
  | { kind: 'ack'; id: string }
  /** Unsolicited: bytes from a PTY the broker subscribed to. */
  | { kind: 'data'; ptyId: string; data: string }
  /** Unsolicited: that PTY ended. */
  | { kind: 'exit'; ptyId: string; exitCode: number };

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
 * Which peer a streaming PTY belongs to.
 *
 * The broker learns this when an attach succeeds, and needs it afterwards to
 * send input and resizes to the right window — a `ptyId` alone says nothing
 * about where it lives. Entries are dropped when the peer disconnects so a
 * later attach cannot be routed into a dead socket.
 */
export class PeerRouteTable<T> {
  readonly #byPty = new Map<string, T>();

  claim(ptyId: string, peer: T): void {
    this.#byPty.set(ptyId, peer);
  }

  release(ptyId: string): void {
    this.#byPty.delete(ptyId);
  }

  peerFor(ptyId: string): T | undefined {
    return this.#byPty.get(ptyId);
  }

  /** Forget everything routed to `peer`, and report what was dropped. */
  forgetPeer(peer: T): string[] {
    const dropped: string[] = [];
    for (const [ptyId, owner] of this.#byPty) {
      if (owner !== peer) continue;
      dropped.push(ptyId);
      this.#byPty.delete(ptyId);
    }
    return dropped;
  }

  get size(): number {
    return this.#byPty.size;
  }
}
