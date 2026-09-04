/**
 * The provider the sidecar hands the service: PTYs answered locally, everything
 * about the webview's *view* of them asked over the bridge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessedPtyChunk, PtySink } from '../../remote/host/host-surface-provider';
import { createSidecarSurfaceBridge, type SidecarSurfaceBridge } from './sidecar-entry';
import { ASK_BUDGET_MS, type RemoteHostAsk } from './service-protocol';

let sent: Array<{ event: string; data: unknown }>;
let written: Array<{ id: string; data: string }>;
let resized: Array<{ id: string; cols: number; rows: number }>;
let livePtys: Set<string>;
/** A PTY that died between the read and a reply write. */
let writeThrows: boolean;
let bridge: SidecarSurfaceBridge;

/** The ask the bridge is waiting on, most recent last. */
function asks(): RemoteHostAsk[] {
  return sent
    .filter((message) => message.event === 'remoteHost:ask')
    .map((message) => message.data as RemoteHostAsk);
}

/** What the bridge told the webview under one event name, most recent last. */
function emitted<T>(event: string): T[] {
  return sent.filter((message) => message.event === event).map((message) => message.data as T);
}

function answer(ask: RemoteHostAsk, results: unknown[]): void {
  bridge.onAnswer({ rhId: ask.rhId, results });
}

function sink(): PtySink & { chunks: ProcessedPtyChunk[]; data: string[]; exits: number[] } {
  const record = {
    chunks: [] as ProcessedPtyChunk[],
    exits: [] as number[],
    /** The renderer projection alone, for the assertions that only care about it. */
    get data(): string[] {
      return record.chunks.map((chunk) => chunk.data);
    },
    onData: (chunk: ProcessedPtyChunk) => void record.chunks.push(chunk),
    onExit: (code: number) => void record.exits.push(code),
  };
  return record;
}

beforeEach(() => {
  sent = [];
  written = [];
  resized = [];
  livePtys = new Set(['pty-1', 'pty-2']);
  writeThrows = false;
  bridge = createSidecarSurfaceBridge({
    send: (event, data) => sent.push({ event, data }),
    mgr: {
      write: (id, data) => {
        if (writeThrows) throw new Error('write EIO');
        written.push({ id, data });
      },
      resize: (id, cols, rows) => void resized.push({ id, cols, rows }),
      hasPty: (id) => livePtys.has(id),
    },
  });
});

afterEach(() => {
  bridge.dispose();
  vi.useRealTimers();
});

describe('asking the webview', () => {
  it('carries the op and its params, and settles on the answer', async () => {
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    expect(ask.op).toBe('directory');
    expect(typeof ask.rhId).toBe('string');

    answer(ask, [{ surfaceId: 's1' }]);
    expect(await pending).toEqual([{ surfaceId: 's1' }]);
  });

  it('settles on the first answer and ignores a later one', async () => {
    // Standalone ships one window, so one answerer; a second is a stale reply.
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    answer(ask, [{ surfaceId: 'first' }]);
    answer(ask, [{ surfaceId: 'second' }]);
    expect(await pending).toEqual([{ surfaceId: 'first' }]);
  });

  it('gives up at the budget rather than hanging', async () => {
    vi.useFakeTimers();
    const pending = bridge.provider.collectDirectory();
    await vi.advanceTimersByTimeAsync(ASK_BUDGET_MS);
    expect(await pending).toEqual([]);
  });

  it('ignores an answer for an ask that is not outstanding', async () => {
    expect(() => bridge.onAnswer({ rhId: 'nope', results: [] })).not.toThrow();
    expect(() => bridge.onAnswer(undefined)).not.toThrow();
  });

  it('marks the directory stale when an answer lands after the budget', async () => {
    // The snapshot the Host already rendered is missing whatever this answer
    // names — an empty picker on a machine that does have terminals. Nothing
    // re-opens a settled ask, so the next collect is the only repair, and an
    // idle machine has no other reason to run one.
    vi.useFakeTimers();
    const changes = vi.fn();
    bridge.provider.watchDirectory(changes);
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    await vi.advanceTimersByTimeAsync(ASK_BUDGET_MS);
    expect(await pending).toEqual([]);

    answer(ask, [{ surfaceId: 's1' }]);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('resolves everything outstanding when disposed', async () => {
    const pending = bridge.provider.collectDirectory();
    bridge.dispose();
    expect(await pending).toEqual([]);
  });
});

describe('directory invalidation', () => {
  it('fires watchers on a notify, and stops after unsubscribe', () => {
    const changes = vi.fn();
    const unsubscribe = bridge.provider.watchDirectory(changes);

    bridge.onNotify();
    expect(changes).toHaveBeenCalledTimes(1);

    unsubscribe();
    bridge.onNotify();
    expect(changes).toHaveBeenCalledTimes(1);
  });
});

describe('resolveSurface', () => {
  it('attaches at the requested size and reports what the owner settled at', async () => {
    const pending = bridge.provider.resolveSurface('s1', { cols: 80, rows: 24 });
    const ask = asks()[0]!;
    expect(ask.op).toBe('surfaceOp');
    expect(ask.params).toEqual({ surfaceId: 's1', op: 'attach', cols: 80, rows: 24 });

    answer(ask, [{ ptyId: 'pty-1', cols: 80, rows: 24 }]);
    const handle = (await pending)!;
    expect(handle.ptyId).toBe('pty-1');
    expect([handle.cols, handle.rows]).toEqual([80, 24]);
  });

  it('is null when nobody owns the surface', async () => {
    const pending = bridge.provider.resolveSurface('gone', {});
    answer(asks()[0]!, []);
    expect(await pending).toBeNull();
  });

  it('resizes through the owner and remembers what it reported', async () => {
    const attach = bridge.provider.resolveSurface('s1', { cols: 80, rows: 24 });
    answer(asks()[0]!, [{ ptyId: 'pty-1', cols: 80, rows: 24 }]);
    const handle = (await attach)!;

    const pending = handle.resize(100, 30);
    const ask = asks()[1]!;
    expect(ask.params).toEqual({ surfaceId: 's1', op: 'resize', cols: 100, rows: 30 });
    // The owner clamped it.
    answer(ask, [{ ptyId: 'pty-1', cols: 100, rows: 28 }]);

    expect(await pending).toEqual({ cols: 100, rows: 28 });
    expect([handle.cols, handle.rows]).toEqual([100, 28]);
  });

  it('leaves the last known size standing when nobody answers a resize', async () => {
    const attach = bridge.provider.resolveSurface('s1', {});
    answer(asks()[0]!, [{ ptyId: 'pty-1', cols: 80, rows: 24 }]);
    const handle = (await attach)!;

    const pending = handle.resize(100, 30);
    answer(asks()[1]!, []);
    expect(await pending).toEqual({ cols: 80, rows: 24 });
  });

  it('releases without asking anyone — the stream owns itself', async () => {
    const attach = bridge.provider.resolveSurface('s1', {});
    answer(asks()[0]!, [{ ptyId: 'pty-1', cols: 80, rows: 24 }]);
    const handle = (await attach)!;

    handle.release();
    expect(asks()).toHaveLength(1);
  });
});

describe('PTYs', () => {
  it('writes and resizes straight through to the manager', () => {
    bridge.provider.writePty('pty-1', 'ls\r');
    bridge.provider.resizePty('pty-1', 80, 24);
    expect(written).toEqual([{ id: 'pty-1', data: 'ls\r' }]);
    expect(resized).toEqual([{ id: 'pty-1', cols: 80, rows: 24 }]);
  });

  it('routes output by id, parsed', () => {
    const one = sink();
    const two = sink();
    bridge.provider.streamPty('pty-1', one);
    bridge.provider.streamPty('pty-2', two);

    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]133;A\x07$ ` });
    expect(one.data).toEqual(['$ ']);
    expect(two.data).toEqual([]);
  });

  it('carries the text projection only when it differs from the renderer one', () => {
    const one = sink();
    bridge.provider.streamPty('pty-1', one);

    bridge.onPtyEvent('data', { id: 'pty-1', data: 'plain' });
    bridge.onPtyEvent('data', { id: 'pty-1', data: `pre\x1b]1337;File=inline=1:AAAA\x07post` });

    expect(one.chunks).toEqual([
      { data: 'plain' },
      { data: `pre\x1b]1337;File=inline=1:AAAA\x07post`, textData: 'prepost' },
    ]);
  });

  it('drops a chunk that was nothing but protocol', () => {
    const one = sink();
    bridge.provider.streamPty('pty-1', one);
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]7;file:///tmp\x07' });
    expect(one.data).toEqual([]);
  });

  it('parses each PTY once, so a late joiner inherits the byte boundaries', () => {
    const one = sink();
    const two = sink();
    bridge.provider.streamPty('pty-1', one);
    // A second attachment starts mid-stream, after the OSC introducer. It
    // inherits the parser rather than starting a fresh one mid-sequence, so it
    // sees the same stripped output as the attachment that was there first.
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]133;' });
    bridge.provider.streamPty('pty-1', two);
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'A\x07hi' });

    expect(one.data).toEqual(['hi']);
    expect(two.data).toEqual(['hi']);
  });

  it('holds a sink that attached inside a forwarded image to the next ground byte', () => {
    const one = sink();
    bridge.provider.streamPty('pty-1', one);
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]1337;File=inline=1:AAAA' });

    const late = sink();
    bridge.provider.streamPty('pty-1', late);
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'BBBB\x07after' });

    // The attachment that was there for the introducer renders the whole image;
    // the one that arrived mid-payload would have painted the base64 as text.
    expect(one.data).toEqual(['\x1b]1337;File=inline=1:AAAA', 'BBBB\x07after']);
    expect(late.data).toEqual(['after']);
  });

  it('keeps one PTY’s half-read sequence out of another’s', () => {
    const one = sink();
    const two = sink();
    bridge.provider.streamPty('pty-1', one);
    bridge.provider.streamPty('pty-2', two);

    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]133;' });
    bridge.onPtyEvent('data', { id: 'pty-2', data: 'plain' });
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'A\x07hi' });

    expect(one.data).toEqual(['hi']);
    expect(two.data).toEqual(['plain']);
  });

  it('reports an exit, defaulting a missing code to 0', () => {
    const one = sink();
    bridge.provider.streamPty('pty-1', one);
    bridge.onPtyEvent('exit', { id: 'pty-1', exitCode: 3 });
    bridge.provider.streamPty('pty-1', one);
    bridge.onPtyEvent('exit', { id: 'pty-1', signal: 'SIGTERM' });
    expect(one.exits).toEqual([3, 0]);
  });

  it('replays an exit that landed before the stream was installed', () => {
    // pty-core emits before removing the generation from its live map.
    bridge.onPtyEvent('exit', { id: 'pty-1', exitCode: 23 });
    livePtys.delete('pty-1');

    const late = sink();
    const subscription = bridge.provider.streamPty('pty-1', late);

    expect(late.exits).toEqual([23]);
    expect(() => subscription.stop()).not.toThrow();
  });

  it('does not replay an old exit after the PTY id is reused', () => {
    bridge.onPtyEvent('exit', { id: 'pty-1', exitCode: 23 });
    // The manager has already installed a fresh generation under the id.
    expect(livePtys.has('pty-1')).toBe(true);

    const replacement = sink();
    bridge.provider.streamPty('pty-1', replacement);
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'new generation' });

    expect(replacement.exits).toEqual([]);
    expect(replacement.data).toEqual(['new generation']);
  });

  it('stops delivering after unsubscribe', () => {
    const one = sink();
    const subscription = bridge.provider.streamPty('pty-1', one);
    subscription.stop();
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'x' });
    expect(one.data).toEqual([]);
  });

  it('does not let a spent unsubscribe silence the attachment that replaced it', () => {
    const first = sink();
    const subscription = bridge.provider.streamPty('pty-1', first);
    subscription.stop();

    const second = sink();
    bridge.provider.streamPty('pty-1', second);
    subscription.stop();

    bridge.onPtyEvent('data', { id: 'pty-1', data: 'still flowing' });
    expect(second.data).toEqual(['still flowing']);
    expect(first.data).toEqual([]);
  });

  it('ignores events with no id', () => {
    expect(() => bridge.onPtyEvent('data', { data: 'x' })).not.toThrow();
    expect(() => bridge.onPtyEvent('data', null)).not.toThrow();
  });
});

describe('the webview’s half of the parse', () => {
  it('sends the projection pair as pty:data, and nothing for an empty chunk', () => {
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'plain' });
    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]1337;File=inline=1:AAAA\x07x` });
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]7;file:///tmp\x07' });

    expect(emitted('pty:data')).toEqual([
      { id: 'pty-1', data: 'plain' },
      { id: 'pty-1', data: `\x1b]1337;File=inline=1:AAAA\x07x`, textData: 'x' },
    ]);
  });

  it('parses a PTY nothing is attached to, because the webview is a consumer too', () => {
    bridge.onPtyEvent('data', { id: 'pty-9', data: `\x1b]0;title\x07hello` });
    expect(emitted('pty:data')).toEqual([{ id: 'pty-9', data: 'hello' }]);
    expect(emitted<{ id: string; events: unknown[] }>('terminal:semanticEvents')).toHaveLength(1);
  });

  it('forwards the alert half of a parse, and the semantic half, in that order', () => {
    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]9;Build finished\x07` });

    expect(sent.map((message) => message.event)).toEqual([
      'terminal:protocolEvents',
      'terminal:semanticEvents',
    ]);
    expect(emitted('terminal:protocolEvents')).toEqual([
      {
        id: 'pty-1',
        events: [
          { kind: 'notification', notification: { source: 'OSC 9', title: null, body: 'Build finished' } },
        ],
      },
    ]);
  });

  it('still sends the chunk when the reply write throws', () => {
    // A PTY that died between the read and the reply write throws out of
    // `mgr.write`; the webview must still get what the parse produced.
    const noise = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge.setThemeColors({ foreground: '#ffffff', background: '#102030', cursor: '#abcdef' });
    writeThrows = true;

    expect(() =>
      bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]11;?\x07visible` }),
    ).not.toThrow();
    expect(emitted('pty:data')).toEqual([{ id: 'pty-1', data: 'visible' }]);
    noise.mockRestore();
  });

  it('never forwards a response — the owner writes it to the PTY itself', () => {
    bridge.setThemeColors({ foreground: '#ffffff', background: '#102030', cursor: '#abcdef' });
    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]11;?\x07` });

    expect(written).toEqual([{ id: 'pty-1', data: `\x1b]11;rgb:1010/2020/3030\x1b\\` }]);
    expect(sent).toEqual([]);
  });

  it('leaves a colour query for xterm.js until the webview has pushed a theme', () => {
    // Null before the first push, exactly as the VS Code host documents.
    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]11;?\x07` });
    expect(written).toEqual([]);
    expect(emitted('pty:data')).toEqual([
      // Declined, so the query stays in the renderer projection — and out of
      // the text one, like every other string control.
      { id: 'pty-1', data: `\x1b]11;?\x07`, textData: '' },
    ]);
  });

  it('ignores a malformed theme push rather than half-applying it', () => {
    bridge.setThemeColors({ foreground: '#ffffff' });
    bridge.setThemeColors(null);
    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]11;?\x07` });
    expect(written).toEqual([]);
  });

  it('gives a reused id a parser of its own at spawn', () => {
    // Half of an OSC the previous generation never finished must not be spliced
    // onto the new PTY's first bytes.
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]133;' });
    bridge.onPtySpawn('pty-1');
    // The stale `pending` would have swallowed this whole chunk instead.
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'plain' });

    expect(emitted('pty:data')).toEqual([{ id: 'pty-1', data: 'plain' }]);
  });

  it('closes the sinks a respawn strands, rather than leaving them waiting', () => {
    // `pty-core` lets a spawn displace a live generation without killing it, and
    // the exit it eventually reports belongs to the stream that replaced this
    // one — so nothing else would ever tell this attachment its pane is gone.
    const attached = sink();
    bridge.provider.streamPty('pty-1', attached);
    bridge.onPtySpawn('pty-1');

    expect(attached.exits).toEqual([0]);
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'new generation' });
    expect(attached.data).toEqual([]);
  });

  it('starts a fresh parser after an exit', () => {
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]133;' });
    bridge.onPtyEvent('exit', { id: 'pty-1', exitCode: 0 });
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'plain' });

    expect(emitted('pty:data')).toEqual([{ id: 'pty-1', data: 'plain' }]);
  });
});
