import { describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  PeerRouteTable,
  encodeFrame,
} from './vscode-peer-link-protocol';

describe('FrameDecoder', () => {
  it('reads one frame per line', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(
      encodeFrame({ kind: 'directory', id: 'a' }) + encodeFrame({ kind: 'ack', id: 'b' }),
    );
    expect(frames).toEqual([
      { kind: 'directory', id: 'a' },
      { kind: 'ack', id: 'b' },
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
    const whole = encodeFrame({ kind: 'ack', id: 'a' });
    expect(decoder.push(`${whole}{"kind":"ack","id":`)).toEqual([{ kind: 'ack', id: 'a' }]);
    expect(decoder.push('"b"}\n')).toEqual([{ kind: 'ack', id: 'b' }]);
  });

  it('skips a malformed frame without dropping the ones around it', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(`{not json}\n${encodeFrame({ kind: 'ack', id: 'a' })}`);
    expect(frames).toEqual([{ kind: 'ack', id: 'a' }]);
  });

  it('ignores blank lines', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push('\n\n')).toEqual([]);
  });

  it('drops a peer that never terminates a frame', () => {
    const decoder = new FrameDecoder(64);
    expect(decoder.push('x'.repeat(100))).toEqual([]);
    // The buffer was reset, so a well-formed frame still gets through after.
    expect(decoder.push(encodeFrame({ kind: 'ack', id: 'a' }))).toEqual([{ kind: 'ack', id: 'a' }]);
  });
});

describe('PeerRouteTable', () => {
  it('routes a pty to the peer that claimed it', () => {
    const table = new PeerRouteTable<string>();
    table.claim('pty-1', 'window-a');
    table.claim('pty-2', 'window-b');

    expect(table.peerFor('pty-1')).toBe('window-a');
    expect(table.peerFor('pty-2')).toBe('window-b');
    expect(table.peerFor('pty-3')).toBeUndefined();
  });

  it('releases a single pty', () => {
    const table = new PeerRouteTable<string>();
    table.claim('pty-1', 'window-a');
    table.release('pty-1');
    expect(table.peerFor('pty-1')).toBeUndefined();
  });

  it('forgets every pty behind a peer that disconnected', () => {
    const table = new PeerRouteTable<string>();
    table.claim('pty-1', 'window-a');
    table.claim('pty-2', 'window-a');
    table.claim('pty-3', 'window-b');

    // Otherwise a later write would be routed into a dead socket.
    expect(table.forgetPeer('window-a').sort()).toEqual(['pty-1', 'pty-2']);
    expect(table.peerFor('pty-1')).toBeUndefined();
    expect(table.peerFor('pty-3')).toBe('window-b');
    expect(table.size).toBe(1);
  });

  it('re-claiming moves a pty to the newer peer', () => {
    const table = new PeerRouteTable<string>();
    table.claim('pty-1', 'window-a');
    table.claim('pty-1', 'window-b');
    expect(table.peerFor('pty-1')).toBe('window-b');
    expect(table.forgetPeer('window-a')).toEqual([]);
  });
});
