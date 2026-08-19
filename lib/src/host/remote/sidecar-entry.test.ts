/**
 * The provider the sidecar hands the service: PTYs answered locally, everything
 * about the webview's *view* of them asked over the bridge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PtySink } from '../../remote/host/host-surface-provider';
import { createSidecarSurfaceBridge, type SidecarSurfaceBridge } from './sidecar-entry';
import { ASK_BUDGET_MS, type RemoteHostAsk } from './service-protocol';

let sent: Array<{ event: string; data: RemoteHostAsk }>;
let written: Array<{ id: string; data: string }>;
let resized: Array<{ id: string; cols: number; rows: number }>;
let bridge: SidecarSurfaceBridge;

/** The ask the bridge is waiting on, most recent last. */
function asks(): RemoteHostAsk[] {
  return sent.filter((message) => message.event === 'remoteHost:ask').map((m) => m.data);
}

function answer(ask: RemoteHostAsk, results: unknown[]): void {
  bridge.onAnswer({ rhId: ask.rhId, results });
}

function sink(): PtySink & { data: string[]; exits: number[] } {
  const record = {
    data: [] as string[],
    exits: [] as number[],
    onData: (chunk: string) => void record.data.push(chunk),
    onExit: (code: number) => void record.exits.push(code),
  };
  return record;
}

beforeEach(() => {
  sent = [];
  written = [];
  resized = [];
  bridge = createSidecarSurfaceBridge({
    send: (event, data) => sent.push({ event, data: data as RemoteHostAsk }),
    mgr: {
      write: (id, data) => void written.push({ id, data }),
      resize: (id, cols, rows) => void resized.push({ id, cols, rows }),
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

  it('resolves everything outstanding when disposed', async () => {
    const pending = bridge.provider.collectDirectory();
    bridge.dispose();
    expect(await pending).toEqual([]);
  });
});

describe('directory invalidation', () => {
  it('fires watchers on a directory notify, and stops after unsubscribe', () => {
    const changes = vi.fn();
    const unsubscribe = bridge.provider.watchDirectory(changes);

    bridge.onNotify({ topic: 'directory' });
    expect(changes).toHaveBeenCalledTimes(1);

    // An unrelated topic is not this watcher's business.
    bridge.onNotify({ topic: 'something-else' });
    expect(changes).toHaveBeenCalledTimes(1);

    // A notify with no topic at all names no other business, so it is ours.
    bridge.onNotify(undefined);
    expect(changes).toHaveBeenCalledTimes(2);

    unsubscribe();
    bridge.onNotify({ topic: 'directory' });
    expect(changes).toHaveBeenCalledTimes(2);
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

  it('routes output by id, stripped', () => {
    const one = sink();
    const two = sink();
    bridge.provider.streamPty('pty-1', one);
    bridge.provider.streamPty('pty-2', two);

    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]133;A\x07$ ` });
    expect(one.data).toEqual(['$ ']);
    expect(two.data).toEqual([]);
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
    bridge.onPtyEvent('exit', { id: 'pty-1', signal: 'SIGTERM' });
    expect(one.exits).toEqual([3, 0]);
  });

  it('stops delivering after unsubscribe', () => {
    const one = sink();
    const unsubscribe = bridge.provider.streamPty('pty-1', one);
    unsubscribe();
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'x' });
    expect(one.data).toEqual([]);
  });

  it('ignores events with no id', () => {
    expect(() => bridge.onPtyEvent('data', { data: 'x' })).not.toThrow();
    expect(() => bridge.onPtyEvent('data', null)).not.toThrow();
  });
});
