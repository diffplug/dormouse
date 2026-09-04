/** Socket-free wire primitives; lifecycle is in peer-link.ts, contract in vscode.md. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  ASK_BUDGET_MS,
  type RemoteHostCommand,
  type RemoteHostResult,
} from '../../lib/src/host/remote/service-protocol';

/** Must exceed the nested webview fan-out budget plus its two socket hops. */
export const PEER_REPLY_BUDGET_MS = ASK_BUDGET_MS + 2_000;

/** Broker → peer window. `op` is intentionally opaque to this transport. */
export type PeerLinkRequest =
  | { kind: 'request'; id: string; op: string; params: unknown }
  | { kind: 'subscribe'; id: string; ptyId: string }
  | { kind: 'unsubscribe'; ptyId: string }
  | { kind: 'write'; ptyId: string; data: string }
  | { kind: 'resizePty'; ptyId: string; cols: number; rows: number }
  | { kind: 'commandResult'; payload: RemoteHostResult }
  | { kind: 'uiEvent'; payload: unknown };

/** Peer window → broker. */
export type PeerLinkResponse =
  | { kind: 'result'; id: string; results: unknown[] }
  | { kind: 'subscribed'; id: string; ptyId: string }
  // `textData` rides the frame under the `ProcessedPtyChunk` rule: omitted when
  // it equals `data` (`lib/src/remote/host/host-surface-provider.ts`).
  | { kind: 'data'; ptyId: string; data: string; textData?: string }
  | { kind: 'exit'; ptyId: string; exitCode: number }
  | { kind: 'notify' }
  | { kind: 'command'; payload: RemoteHostCommand };

export type PeerLinkFrame = PeerLinkRequest | PeerLinkResponse;

/** Three-frame mutual-token handshake: server challenge → client hello → welcome. */
export interface PeerLinkChallenge {
  kind: 'challenge';
  nonce: string;
}

export interface PeerLinkHello {
  kind: 'hello';
  nonce: string;
  proof: string;
}

export interface PeerLinkWelcome {
  kind: 'welcome';
  proof: string;
}

/** Distinct domains prevent a fake server reflecting the client's proof as its own. */
export const PEER_CLIENT_PROOF_DOMAIN = 'client:';
export const PEER_SERVER_PROOF_DOMAIN = 'server:';

export type PeerLinkHandshake = PeerLinkChallenge | PeerLinkHello | PeerLinkWelcome;

export function proveToken(token: string, domain: string, nonce: string): string {
  return createHmac('sha256', token).update(domain + nonce).digest('base64url');
}

/** Hash to equal lengths before constant-time comparison. */
export function proofMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

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

/** The sole interpreted field in an otherwise opaque peer answer. */
export function routedPtyId(result: unknown): string | null {
  const ptyId = (result as { ptyId?: unknown } | null | undefined)?.ptyId;
  return typeof ptyId === 'string' ? ptyId : null;
}

export function forgetPeerRoutes<T>(routes: Map<string, T>, peer: T): string[] {
  const dropped: string[] = [];
  for (const [ptyId, owner] of routes) {
    if (owner !== peer) continue;
    dropped.push(ptyId);
    routes.delete(ptyId);
  }
  return dropped;
}
