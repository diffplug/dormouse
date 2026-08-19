/**
 * The socket-free half of the peer link: frame shapes, framing, the PTY routing
 * table, and the handshake primitives. `peer-link.test.ts` covers what only
 * exists once there is a real socket.
 */

import { describe, expect, it } from 'vitest';
import { ASK_BUDGET_MS } from '../../lib/src/host/remote/service-protocol';
import {
  FrameDecoder,
  PEER_CLIENT_PROOF_DOMAIN,
  PEER_REPLY_BUDGET_MS,
  PEER_SERVER_PROOF_DOMAIN,
  encodeFrame,
  forgetPeerRoutes,
  freshNonce,
  proofMatches,
  proveToken,
  routedPtyId,
} from '../src/peer-link-protocol';

describe('reply budgets', () => {
  it('gives the cross-window wait more room than the fan-out it contains', () => {
    // Not a tidiness assertion: the broker's wait for a peer window strictly
    // contains that window's own full-budget fan-out to its webviews plus two
    // socket hops. Equal budgets make a slow sibling look like a timeout on the
    // broker's side and throw away results that were on their way, so unifying
    // these two constants is a regression, not a simplification.
    expect(PEER_REPLY_BUDGET_MS).toBeGreaterThan(ASK_BUDGET_MS);
  });
});

describe('FrameDecoder', () => {
  it('reads one frame per line', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(
      encodeFrame({ kind: 'request', id: 'a', op: 'directory', params: {} }) +
        encodeFrame({ kind: 'result', id: 'b', results: [] }),
    );
    expect(frames).toEqual([
      { kind: 'request', id: 'a', op: 'directory', params: {} },
      { kind: 'result', id: 'b', results: [] },
    ]);
  });

  it('reassembles a frame split across chunks', () => {
    const decoder = new FrameDecoder();
    const encoded = encodeFrame({ kind: 'data', ptyId: 'pty-1', data: 'hello' });
    const cut = Math.floor(encoded.length / 2);

    expect(decoder.push(encoded.slice(0, cut))).toEqual([]);
    expect(decoder.push(encoded.slice(cut))).toEqual([
      { kind: 'data', ptyId: 'pty-1', data: 'hello' },
    ]);
  });

  it('holds a trailing partial frame until its newline arrives', () => {
    const decoder = new FrameDecoder();
    const whole = encodeFrame({ kind: 'result', id: 'a', results: [] });
    expect(decoder.push(`${whole}{"kind":"result","id":`)).toEqual([
      { kind: 'result', id: 'a', results: [] },
    ]);
    expect(decoder.push('"b","results":[]}\n')).toEqual([{ kind: 'result', id: 'b', results: [] }]);
  });

  it('skips a malformed frame without dropping the ones around it', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(
      `{not json}\n${encodeFrame({ kind: 'result', id: 'a', results: [] })}`,
    );
    expect(frames).toEqual([{ kind: 'result', id: 'a', results: [] }]);
  });

  it('ignores blank lines', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push('\n\n')).toEqual([]);
  });

  it('carries the one-way PTY frames, which have no id of their own', () => {
    // Nothing awaits them — the stream they start is correlated by `ptyId` —
    // so a frame id would be a field nobody ever reads.
    const decoder = new FrameDecoder();
    expect(
      decoder.push(
        encodeFrame({ kind: 'subscribe', ptyId: 'pty-1' }) +
          encodeFrame({ kind: 'write', ptyId: 'pty-1', data: 'ls\r' }) +
          encodeFrame({ kind: 'resizePty', ptyId: 'pty-1', cols: 120, rows: 40 }) +
          encodeFrame({ kind: 'unsubscribe', ptyId: 'pty-1' }),
      ),
    ).toEqual([
      { kind: 'subscribe', ptyId: 'pty-1' },
      { kind: 'write', ptyId: 'pty-1', data: 'ls\r' },
      { kind: 'resizePty', ptyId: 'pty-1', cols: 120, rows: 40 },
      { kind: 'unsubscribe', ptyId: 'pty-1' },
    ]);
  });

  it('carries a forwarded command and its answer', () => {
    // The Host command bridge rides the same framing, so a window with no
    // service of its own reaches the one that has it.
    const decoder = new FrameDecoder();
    expect(
      decoder.push(
        encodeFrame({ kind: 'command', payload: { rhId: 'rh-1', cmd: 'status' } }) +
          encodeFrame({ kind: 'commandResult', payload: { rhId: 'rh-1', result: { enrolled: true } } }) +
          encodeFrame({ kind: 'commandResult', payload: { rhId: 'rh-2', error: 'nope' } }),
      ),
    ).toEqual([
      { kind: 'command', payload: { rhId: 'rh-1', cmd: 'status' } },
      { kind: 'commandResult', payload: { rhId: 'rh-1', result: { enrolled: true } } },
      { kind: 'commandResult', payload: { rhId: 'rh-2', error: 'nope' } },
    ]);
  });

  it('carries a UI event with no correlation of its own', () => {
    // Broadcast, not addressed: any window's webview may answer the pairing.
    const decoder = new FrameDecoder();
    const event = { name: 'pairing-queue', queue: [{ clientId: 'c1' }] };
    expect(decoder.push(encodeFrame({ kind: 'uiEvent', payload: event }))).toEqual([
      { kind: 'uiEvent', payload: event },
    ]);
  });

  it('drops an oversized frame without losing the ones it arrived with', () => {
    const decoder = new FrameDecoder(64);
    const small = encodeFrame({ kind: 'result', id: 'a', results: [] });

    // One chunk carrying a whole frame and the start of a frame past the cap.
    // Clearing the buffer wholesale would swallow the small frame too, and a
    // dropped `commandResult` or `exit` is a webview waiting out its timeout.
    expect(decoder.push(small + 'x'.repeat(100))).toEqual([
      { kind: 'result', id: 'a', results: [] },
    ]);

    // The rest of the oversized frame is still arriving; none of it is a frame.
    expect(decoder.push('y'.repeat(100))).toEqual([]);
    // Its tail must not be resynced as frames of its own — only its terminating
    // newline puts the stream back on a frame boundary.
    expect(decoder.push(`{"kind":"junk"}\n${small}`)).toEqual([
      { kind: 'result', id: 'a', results: [] },
    ]);
  });

  it('resumes on the newline that ends the oversized frame', () => {
    const decoder = new FrameDecoder(64);
    expect(decoder.push('x'.repeat(100))).toEqual([]);
    expect(decoder.push(`${'x'.repeat(100)}\n`)).toEqual([]);
    expect(decoder.push(encodeFrame({ kind: 'result', id: 'a', results: [] }))).toEqual([
      { kind: 'result', id: 'a', results: [] },
    ]);
  });
});

describe('routedPtyId', () => {
  it('reads the routing hint out of an otherwise opaque answer', () => {
    expect(routedPtyId({ ptyId: 'pty-1', cols: 80, rows: 24 })).toBe('pty-1');
  });

  it('routes nothing for an answer that names no PTY', () => {
    // Directory entries travel the same generic path and must not enter the
    // routing table.
    expect(routedPtyId({ surfaceId: 'pane-1', title: 'zsh' })).toBeNull();
    expect(routedPtyId({ ptyId: 42 })).toBeNull();
    expect(routedPtyId(null)).toBeNull();
    expect(routedPtyId('pty-1')).toBeNull();
  });
});

describe('forgetPeerRoutes', () => {
  it('drops every pty behind a peer that disconnected, and reports them', () => {
    const routes = new Map<string, string>([
      ['pty-1', 'window-a'],
      ['pty-2', 'window-a'],
      ['pty-3', 'window-b'],
    ]);

    // Otherwise a later write would be routed into a dead socket.
    expect(forgetPeerRoutes(routes, 'window-a').sort()).toEqual(['pty-1', 'pty-2']);
    expect(routes.get('pty-1')).toBeUndefined();
    expect(routes.get('pty-3')).toBe('window-b');
    expect(routes.size).toBe(1);
  });

  it('reports nothing for a peer that owns no routes', () => {
    const routes = new Map<string, string>([['pty-1', 'window-a']]);
    expect(forgetPeerRoutes(routes, 'window-b')).toEqual([]);
    expect(routes.size).toBe(1);
  });
});

describe('handshake proofs', () => {
  it('binds a proof to the token, the domain, and the nonce', () => {
    const proof = proveToken('token', PEER_CLIENT_PROOF_DOMAIN, 'nonce-1');
    expect(proofMatches(proof, proveToken('token', PEER_CLIENT_PROOF_DOMAIN, 'nonce-1'))).toBe(true);
    // A different token, a different nonce, or the other direction's domain all
    // produce something that cannot pass for this one.
    expect(proofMatches(proof, proveToken('other', PEER_CLIENT_PROOF_DOMAIN, 'nonce-1'))).toBe(false);
    expect(proofMatches(proof, proveToken('token', PEER_CLIENT_PROOF_DOMAIN, 'nonce-2'))).toBe(false);
    expect(proofMatches(proof, proveToken('token', PEER_SERVER_PROOF_DOMAIN, 'nonce-1'))).toBe(false);
  });

  it('never leaks the token into the proof', () => {
    expect(proveToken('sup3r-s3cret', PEER_SERVER_PROOF_DOMAIN, 'n')).not.toContain('sup3r-s3cret');
  });

  it('refuses anything that is not a string, rather than throwing', () => {
    // The compare runs on a frame a squatter wrote, so every shape has to be a
    // plain `false` — including one whose length would otherwise throw.
    const expected = proveToken('token', PEER_SERVER_PROOF_DOMAIN, 'n');
    expect(proofMatches(undefined, expected)).toBe(false);
    expect(proofMatches({ length: 43 }, expected)).toBe(false);
    expect(proofMatches('short', expected)).toBe(false);
  });

  it('mints a fresh nonce every time', () => {
    const nonces = new Set(Array.from({ length: 32 }, () => freshNonce()));
    expect(nonces.size).toBe(32);
  });
});
