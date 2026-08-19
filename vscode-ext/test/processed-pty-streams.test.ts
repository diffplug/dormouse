/**
 * The keyed registry both consumers of this window's own PTY output share. What
 * matters here is the tax: these listeners run on every chunk of every terminal,
 * so there must be exactly one pair no matter how many attachments exist, and
 * none at all when there are none.
 */

import { describe, expect, it } from 'vitest';
import { createProcessedPtyStreams } from '../src/processed-pty-streams';

/** Stands in for `message-router`'s processed-data fan-out, counting listeners. */
function fakeSource() {
  const data = new Set<(id: string, chunk: string) => void>();
  const exit = new Set<(id: string, exitCode: number) => void>();
  return {
    /** How many listener pairs are installed right now. */
    get installed(): number {
      return data.size + exit.size;
    },
    emitData(id: string, chunk: string): void {
      for (const listener of [...data]) listener(id, chunk);
    },
    emitExit(id: string, exitCode: number): void {
      for (const listener of [...exit]) listener(id, exitCode);
    },
    streams: () =>
      createProcessedPtyStreams(
        (listener) => {
          data.add(listener);
          return () => void data.delete(listener);
        },
        (listener) => {
          exit.add(listener);
          return () => void exit.delete(listener);
        },
      ),
  };
}

function sink() {
  return {
    data: [] as string[],
    exits: [] as number[],
    onData(chunk: string) {
      this.data.push(chunk);
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
    expect(source.installed).toBe(0);

    const stop = streams.streamPty('pty-1', sink());
    expect(source.installed).toBe(2);

    stop();
    expect(source.installed).toBe(0);
  });

  it('installs one listener pair for every attachment there is', () => {
    // The whole point: a pair per attachment would tax every keystroke of every
    // terminal in the window once per attached surface.
    const source = fakeSource();
    const streams = source.streams();
    const stops = [
      streams.streamPty('pty-1', sink()),
      streams.streamPty('pty-1', sink()),
      streams.streamPty('pty-2', sink()),
    ];

    expect(source.installed).toBe(2);
    // And the pair stays until the *last* attachment goes.
    stops[0]!();
    stops[1]!();
    expect(source.installed).toBe(2);
    stops[2]!();
    expect(source.installed).toBe(0);
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

    source.emitData('pty-1', 'hello');
    source.emitData('pty-3', 'nobody is watching this');

    expect(first.data).toEqual(['hello']);
    expect(second.data).toEqual(['hello']);
    expect(elsewhere.data).toEqual([]);
  });

  it('stops one sink without silencing the other', () => {
    const source = fakeSource();
    const streams = source.streams();
    const first = sink();
    const second = sink();
    const stopFirst = streams.streamPty('pty-1', first);
    streams.streamPty('pty-1', second);

    stopFirst();
    source.emitData('pty-1', 'still flowing');

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
    expect(source.installed).toBe(0);
    // And an unsubscribe afterwards is a no-op rather than an error.
    expect(() => stopFirst()).not.toThrow();
    source.emitData('pty-1', 'after the exit');
    expect(first.data).toEqual([]);
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
    expect(source.installed).toBe(0);
  });

  it('gives a re-attach after an exit a stream of its own', () => {
    const source = fakeSource();
    const streams = source.streams();
    const before = sink();
    const stopBefore = streams.streamPty('pty-1', before);
    source.emitExit('pty-1', 0);

    const after = sink();
    streams.streamPty('pty-1', after);
    // The dead attachment's unsubscribe must not reach into the live one.
    stopBefore();
    source.emitData('pty-1', 'a new terminal on the same id');

    expect(after.data).toEqual(['a new terminal on the same id']);
    expect(source.installed).toBe(2);
  });
});
