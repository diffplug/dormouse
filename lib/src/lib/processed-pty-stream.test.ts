/**
 * The PTY owner's parse boundary: one parser fed from spawn, its results shared
 * by the owner's renderer and every remote sink, plus the two rules that only
 * exist because a sink can arrive at any byte and a read can be any size.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  boundPtyRead,
  createProcessedPtyStream,
  MAX_PARSER_INPUT_CHARS,
  type ProcessedPtyChunk,
} from './processed-pty-stream';
import type { TerminalProtocolEvent } from './terminal-protocol';

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;
/** An inline image: forwarded to the renderer, absent from the text projection. */
const IMAGE_HEAD = `${ESC}]1337;File=inline=1:`;

function owner(colorProvider?: () => string | null) {
  const chunks: ProcessedPtyChunk[] = [];
  const events: TerminalProtocolEvent[] = [];
  const stream = createProcessedPtyStream({
    colorProvider,
    onEvents: (batch) => void events.push(...batch),
    onChunk: (chunk) => void chunks.push(chunk),
  });
  return {
    stream,
    chunks,
    events,
    /** The renderer projection alone, for the assertions that only want it. */
    get data(): string[] {
      return chunks.map((chunk) => chunk.data);
    },
  };
}

function sink() {
  const record = {
    chunks: [] as ProcessedPtyChunk[],
    get data(): string[] {
      return record.chunks.map((chunk) => chunk.data);
    },
    take: (chunk: ProcessedPtyChunk) => void record.chunks.push(chunk),
  };
  return record;
}

describe('the owner’s own feed', () => {
  it('parses once and hands the owner both projections', () => {
    const host = owner();
    host.stream.write('plain');
    host.stream.write(`pre${IMAGE_HEAD}AAAA${BEL}post`);

    expect(host.chunks).toEqual([
      { data: 'plain' },
      { data: `pre${IMAGE_HEAD}AAAA${BEL}post`, textData: 'prepost' },
    ]);
  });

  it('never reports a chunk that was nothing but consumed protocol', () => {
    // Not meaningful output: the activity monitor hangs off this callback.
    const host = owner();
    host.stream.write(`${ESC}]7;file:///tmp${BEL}`);
    expect(host.chunks).toEqual([]);
    expect(host.events).toEqual([{ kind: 'semantic', event: expect.objectContaining({ type: 'cwd' }) }]);
  });

  it('delivers each chunk’s events exactly once, however many sinks watch', () => {
    // A response fanned out per sink would be written to the PTY once per viewer.
    const host = owner(() => '#102030');
    host.stream.subscribe(sink().take);
    host.stream.subscribe(sink().take);
    host.stream.write(`${ESC}]11;?${BEL}`);

    expect(host.events).toEqual([
      { kind: 'response', data: `${ESC}]11;rgb:1010/2020/3030${ST}` },
    ]);
  });

  it('reaches the owner before any sink', () => {
    // The owner's renderer is the local pipe; a remote sink must never be able
    // to come between a chunk and the screen.
    const order: string[] = [];
    const stream = createProcessedPtyStream({
      onEvents: () => {},
      onChunk: () => void order.push('owner'),
    });
    stream.subscribe(() => void order.push('sink'));
    stream.write('hi');

    expect(order).toEqual(['owner', 'sink']);
  });
});

describe('sinks', () => {
  it('gives every sink the same chunk, and stops on unsubscribe', () => {
    const host = owner();
    const first = sink();
    const second = sink();
    const stopFirst = host.stream.subscribe(first.take);
    host.stream.subscribe(second.take);

    host.stream.write('one');
    stopFirst();
    host.stream.write('two');

    expect(first.data).toEqual(['one']);
    expect(second.data).toEqual(['one', 'two']);
    expect(host.stream.hasSinks).toBe(true);
  });

  it('reports when nothing is attached', () => {
    const host = owner();
    expect(host.stream.hasSinks).toBe(false);
    const stop = host.stream.subscribe(sink().take);
    expect(host.stream.hasSinks).toBe(true);
    stop();
    expect(host.stream.hasSinks).toBe(false);
  });

  it('inherits the byte boundaries of everything before it', () => {
    // A sink that joins between two chunks of a *consumed* sequence has nothing
    // to wait for: those bytes reach no renderer at all.
    const host = owner();
    host.stream.write(`${ESC}]133;`);
    const late = sink();
    host.stream.subscribe(late.take);
    host.stream.write(`A${BEL}hi`);

    expect(late.data).toEqual(['hi']);
    expect(host.data).toEqual(['hi']);
  });
});

describe('a sink that joins inside a forwarded string control', () => {
  it('starts at the next ground byte, not mid-payload', () => {
    const host = owner();
    host.stream.write(`${IMAGE_HEAD}AAAA`);
    const late = sink();
    host.stream.subscribe(late.take);
    host.stream.write('BBBB');
    host.stream.write(`CCCC${BEL}after`);

    // The owner, there from spawn, renders the whole image.
    expect(host.data).toEqual([`${IMAGE_HEAD}AAAA`, 'BBBB', `CCCC${BEL}after`]);
    // The late sink gets no payload tail — its xterm would paint the base64 as
    // text — and picks up at the ground text past the terminator.
    expect(late.data).toEqual(['after']);
  });

  it('is released by a cancel as surely as by a terminator', () => {
    const host = owner();
    host.stream.write(`${ESC}Psixel-payload`);
    const late = sink();
    host.stream.subscribe(late.take);
    // CAN aborts the string; the renderer applies its own abort semantics.
    host.stream.write('\x18ground');

    expect(late.data).toEqual(['ground']);
  });

  it('is released by an ESC that opens a sequence of its own', () => {
    const host = owner();
    host.stream.write(`${ESC}_kitty-payload`);
    const late = sink();
    host.stream.subscribe(late.take);
    host.stream.write(`${ESC}[31mred`);

    // The cancelling ESC belongs to the sequence it opens, so the sink sees it.
    expect(late.data).toEqual([`${ESC}[31mred`]);
  });

  it('stays held while the payload runs on with nothing else in the chunk', () => {
    const host = owner();
    host.stream.write(`${IMAGE_HEAD}AAAA`);
    const late = sink();
    host.stream.subscribe(late.take);
    host.stream.write('BBBB');
    host.stream.write('CCCC');

    expect(late.chunks).toEqual([]);
  });

  it('is released by a chunk that ends exactly at the terminator', () => {
    // Nothing to deliver, but the hold is over: the next chunk is ground.
    const host = owner();
    host.stream.write(`${IMAGE_HEAD}AAAA`);
    const late = sink();
    host.stream.subscribe(late.take);
    host.stream.write(BEL);
    expect(late.chunks).toEqual([]);

    host.stream.write('after');
    expect(late.data).toEqual(['after']);
  });

  it('does not hold a sink that joins between two complete sequences', () => {
    const host = owner();
    host.stream.write(`${IMAGE_HEAD}AAAA${BEL}`);
    const late = sink();
    host.stream.subscribe(late.take);
    host.stream.write(`${IMAGE_HEAD}BBBB${BEL}tail`);

    expect(late.data).toEqual([`${IMAGE_HEAD}BBBB${BEL}tail`]);
  });

  it('drops the text projection with the payload it belonged to', () => {
    const host = owner();
    host.stream.write(`${IMAGE_HEAD}AAAA`);
    const late = sink();
    host.stream.subscribe(late.take);
    host.stream.write(`${BEL}see${IMAGE_HEAD}BBBB${BEL}here`);

    // What the sink receives carries its own pair: the second image is in the
    // renderer projection and out of the text one, and both start at ground.
    expect(late.chunks).toEqual([
      { data: `see${IMAGE_HEAD}BBBB${BEL}here`, textData: 'seehere' },
    ]);
  });
});

describe('the input bound', () => {
  it('leaves an ordinary read whole', () => {
    expect(boundPtyRead('hello')).toEqual(['hello']);
  });

  it('splits a read too large for one application message', () => {
    const raw = 'x'.repeat(MAX_PARSER_INPUT_CHARS * 2 + 5);
    const pieces = boundPtyRead(raw);

    expect(pieces).toHaveLength(3);
    expect(pieces.every((piece) => piece.length <= MAX_PARSER_INPUT_CHARS)).toBe(true);
    expect(pieces.join('')).toBe(raw);
  });

  it('never splits a surrogate pair', () => {
    // A lone surrogate does not survive the UTF-8 encode the wire does.
    const pieces = boundPtyRead(`ab\u{1f600}cd`, 3);
    expect(pieces).toEqual(['ab', '\u{1f600}c', 'd']);
    expect(pieces.join('')).toBe('ab\u{1f600}cd');
  });

  it('parses a bounded read as ordered pieces of one stream', () => {
    const host = owner();
    const chunk = 'y'.repeat(MAX_PARSER_INPUT_CHARS + 10);
    host.stream.write(chunk);

    expect(host.chunks).toHaveLength(2);
    expect(host.data.join('')).toBe(chunk);
  });

  it('keeps a sequence split across the bound intact for the renderer', () => {
    const host = owner();
    const payload = 'A'.repeat(MAX_PARSER_INPUT_CHARS);
    host.stream.write(`${IMAGE_HEAD}${payload}${BEL}tail`);

    expect(host.data.join('')).toBe(`${IMAGE_HEAD}${payload}${BEL}tail`);
    // And the payload stays out of the text projection either side of the split.
    expect(host.chunks.map((chunk) => chunk.textData ?? chunk.data).join('')).toBe('tail');
  });
});

describe('a sink that throws', () => {
  it('costs itself the chunk and no one else anything', () => {
    const host = owner();
    const after = sink();
    host.stream.subscribe(() => {
      throw new Error('sink blew up');
    });
    host.stream.subscribe(after.take);
    const noise = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => host.stream.write('one')).not.toThrow();
    expect(host.data).toEqual(['one']);
    expect(after.data).toEqual(['one']);
    noise.mockRestore();
  });

  it('does not cost the owner the rest of a split read', () => {
    const host = owner();
    host.stream.subscribe(() => {
      throw new Error('sink blew up');
    });
    const noise = vi.spyOn(console, 'error').mockImplementation(() => {});

    host.stream.write('z'.repeat(MAX_PARSER_INPUT_CHARS + 10));

    expect(host.chunks).toHaveLength(2);
    expect(host.data.join('')).toHaveLength(MAX_PARSER_INPUT_CHARS + 10);
    noise.mockRestore();
  });
});

describe('the colour provider', () => {
  it('is the owner’s, and declining leaves the query for the renderer', () => {
    const declining = vi.fn(() => null);
    const host = owner(declining);
    host.stream.write(`${ESC}]11;?${BEL}`);

    expect(declining).toHaveBeenCalledWith('background');
    expect(host.data).toEqual([`${ESC}]11;?${BEL}`]);
    expect(host.events).toEqual([]);
  });
});
