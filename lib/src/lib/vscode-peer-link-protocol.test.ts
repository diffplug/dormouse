import { describe, expect, it } from 'vitest';
import { FrameDecoder, encodeFrame, forgetPeerRoutes, routedPtyId } from './vscode-peer-link-protocol';

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

  it('drops a peer that never terminates a frame', () => {
    const decoder = new FrameDecoder(64);
    expect(decoder.push('x'.repeat(100))).toEqual([]);
    // The buffer was reset, so a well-formed frame still gets through after.
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
