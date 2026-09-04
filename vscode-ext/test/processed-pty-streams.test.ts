/**
 * The keyed registry both consumers of this window's own PTY output share. What
 * matters here is the tax: an attachment costs one subscription on the PTY it
 * watches and nothing on any other terminal, and a window with nothing attached
 * costs nothing at all.
 */

import { describe, expect, it } from 'vitest';
import {
  createProcessedPtyStreams,
  type ProcessedPtyChunk,
} from '../src/processed-pty-streams';

/** Stands in for `message-router`'s per-PTY owner streams, counting subscriptions. */
function fakeSource() {
  const chunks = new Map<string, Set<(chunk: ProcessedPtyChunk) => void>>();
  const exit = new Set<(id: string, exitCode: number) => void>();
  const statuses = new Map<string, { alive: boolean; exitCode?: number }>();
  return {
    /** How many chunk subscriptions are installed right now. */
    get subscribed(): number {
      let total = 0;
      for (const sinks of chunks.values()) total += sinks.size;
      return total;
    },
    /** How many exit listeners are installed right now. */
    get exitListeners(): number {
      return exit.size;
    },
    emitData(id: string, chunk: ProcessedPtyChunk): void {
      statuses.set(id, { alive: true });
      for (const listener of [...(chunks.get(id) ?? [])]) listener(chunk);
    },
    emitExit(id: string, exitCode: number): void {
      // The real manager records liveness before it fans out the processed
      // exit, so a listener installed later sees the same ordering.
      statuses.set(id, { alive: false, exitCode });
      for (const listener of [...exit]) listener(id, exitCode);
    },
    spawn(id: string): void {
      statuses.set(id, { alive: true });
    },
    streams: () =>
      createProcessedPtyStreams(
        (ptyId, onChunk) => {
          let sinks = chunks.get(ptyId);
          if (!sinks) {
            sinks = new Set();
            chunks.set(ptyId, sinks);
          }
          const subscribed = sinks;
          subscribed.add(onChunk);
          return () => void subscribed.delete(onChunk);
        },
        (listener) => {
          exit.add(listener);
          return () => void exit.delete(listener);
        },
        (id) => statuses.get(id) ?? { alive: true },
      ),
  };
}

function sink() {
  return {
    chunks: [] as ProcessedPtyChunk[],
    exits: [] as number[],
    /** The renderer projection alone, for assertions that only care about it. */
    get data(): string[] {
      return this.chunks.map((chunk) => chunk.data);
    },
    onData(chunk: ProcessedPtyChunk) {
      this.chunks.push(chunk);
    },
    onExit(code: number) {
      this.exits.push(code);
    },
  };
}

describe('processed pty streams', () => {
  it('costs nothing until something attaches, and nothing again after', () => {
    const source = fakeSource();
    const streams = source.streams();
    expect(source.subscribed).toBe(0);
    expect(source.exitListeners).toBe(0);

    const stop = streams.streamPty('pty-1', sink());
    expect(source.subscribed).toBe(1);
    expect(source.exitListeners).toBe(1);

    stop();
    expect(source.subscribed).toBe(0);
    expect(source.exitListeners).toBe(0);
  });

  it('subscribes each attachment on its own, and only to the PTY it watches', () => {
    // One subscription per sink is what lets a sink that joins mid-sequence be
    // held while the one already attached keeps receiving; a shared one could
    // not. Terminals nobody watches stay untouched either way.
    const source = fakeSource();
    const streams = source.streams();
    const stops = [
      streams.streamPty('pty-1', sink()),
      streams.streamPty('pty-1', sink()),
      streams.streamPty('pty-2', sink()),
    ];

    expect(source.subscribed).toBe(3);
    // One exit listener for the window, however many attachments there are, and
    // it stays until the *last* one goes.
    expect(source.exitListeners).toBe(1);
    stops[0]!();
    stops[1]!();
    expect(source.subscribed).toBe(1);
    expect(source.exitListeners).toBe(1);
    stops[2]!();
    expect(source.subscribed).toBe(0);
    expect(source.exitListeners).toBe(0);
  });

  it('fans one PTY to every sink watching it, and to no others', () => {
    const source = fakeSource();
    const streams = source.streams();
    const first = sink();
    const second = sink();
    const elsewhere = sink();
    streams.streamPty('pty-1', first);
    streams.streamPty('pty-1', second);
    streams.streamPty('pty-2', elsewhere);

    source.emitData('pty-1', { data: 'hello' });
    source.emitData('pty-3', { data: 'nobody is watching this' });

    expect(first.data).toEqual(['hello']);
    expect(second.data).toEqual(['hello']);
    expect(elsewhere.data).toEqual([]);
  });

  it('hands the sink the chunk the owner parsed, both projections and all', () => {
    const source = fakeSource();
    const streams = source.streams();
    const only = sink();
    streams.streamPty('pty-1', only);

    source.emitData('pty-1', { data: 'plain' });
    source.emitData('pty-1', {
      data: 'pre\x1b]1337;File=inline=1:AAAA\x07post',
      textData: 'prepost',
    });

    // The parser already computed both for the owning webview; dropping one
    // here left a Client re-deriving it from bytes it cannot tell apart.
    expect(only.chunks).toEqual([
      { data: 'plain' },
      { data: 'pre\x1b]1337;File=inline=1:AAAA\x07post', textData: 'prepost' },
    ]);
  });

  it('stops one sink without silencing the other', () => {
    const source = fakeSource();
    const streams = source.streams();
    const first = sink();
    const second = sink();
    const stopFirst = streams.streamPty('pty-1', first);
    streams.streamPty('pty-1', second);

    stopFirst();
    source.emitData('pty-1', { data: 'still flowing' });

    expect(first.data).toEqual([]);
    expect(second.data).toEqual(['still flowing']);
  });

  it('tears every sink on a PTY down when it exits', () => {
    const source = fakeSource();
    const streams = source.streams();
    const first = sink();
    const second = sink();
    const other = sink();
    const stopFirst = streams.streamPty('pty-1', first);
    streams.streamPty('pty-1', second);
    streams.streamPty('pty-2', other);

    source.emitExit('pty-2', 3);
    source.emitExit('pty-1', 17);

    expect(first.exits).toEqual([17]);
    expect(second.exits).toEqual([17]);
    expect(other.exits).toEqual([3]);

    // Nothing is attached any more, so the terminals go back to costing nothing
    // — without anyone having to call the unsubscribe.
    expect(source.subscribed).toBe(0);
    expect(source.exitListeners).toBe(0);
    // And an unsubscribe afterwards is a no-op rather than an error.
    expect(() => stopFirst()).not.toThrow();
    source.emitData('pty-1', { data: 'after the exit' });
    expect(first.data).toEqual([]);
  });

  it('replays an exit that landed before the stream was installed', () => {
    const source = fakeSource();
    const streams = source.streams();
    source.emitExit('pty-1', 23);

    const late = sink();
    const stop = streams.streamPty('pty-1', late);

    expect(late.exits).toEqual([23]);
    expect(source.subscribed).toBe(0);
    expect(source.exitListeners).toBe(0);
    expect(() => stop()).not.toThrow();
  });

  it('survives a sink that unsubscribes itself from inside its own exit', () => {
    // Which is exactly what an attachment does: the exit is what tells it to
    // let go, and it lets go by calling the unsubscribe it is holding.
    const source = fakeSource();
    const streams = source.streams();
    const seen: number[] = [];
    const attachment: { stop?: () => void } = {};
    attachment.stop = streams.streamPty('pty-1', {
      onData: () => {},
      onExit: (code) => {
        seen.push(code);
        attachment.stop?.();
      },
    });

    expect(() => source.emitExit('pty-1', 9)).not.toThrow();
    expect(seen).toEqual([9]);
    expect(source.subscribed).toBe(0);
    expect(source.exitListeners).toBe(0);
  });

  it('drops the subscription when it attaches to a PTY that already exited', () => {
    // The registry stands a subscription up before it can know the PTY is dead;
    // whatever the owner created to serve it must not outlive the attempt, since
    // the exit that would have retired it has already been and gone.
    const source = fakeSource();
    const streams = source.streams();
    source.emitExit('pty-1', 7);

    const late = sink();
    streams.streamPty('pty-1', late);

    expect(late.exits).toEqual([7]);
    expect(source.subscribed).toBe(0);
  });

  it('gives a re-attach after an exit a stream of its own', () => {
    const source = fakeSource();
    const streams = source.streams();
    const before = sink();
    const stopBefore = streams.streamPty('pty-1', before);
    source.emitExit('pty-1', 0);

    source.spawn('pty-1');
    const after = sink();
    streams.streamPty('pty-1', after);
    // The dead attachment's unsubscribe must not reach into the live one.
    stopBefore();
    source.emitData('pty-1', { data: 'a new terminal on the same id' });

    expect(after.data).toEqual(['a new terminal on the same id']);
    expect(source.subscribed).toBe(1);
    expect(source.exitListeners).toBe(1);
  });
});
