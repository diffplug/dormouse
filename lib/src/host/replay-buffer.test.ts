import { describe, expect, it } from 'vitest';
import { sliceSince } from './replay-buffer';

/** A buffer that trims off the front at `cap`, exactly as both hosts do. */
function buffer(cap: number) {
  const chunks: string[] = [];
  let held = 0;
  let received = 0;
  return {
    write(data: string) {
      chunks.push(data);
      held += data.length;
      received += data.length;
      while (chunks.length > 1 && held - chunks[0].length >= cap) held -= chunks.shift()!.length;
      if (held > cap) { chunks[0] = chunks[0].slice(held - cap); held = cap; }
    },
    get received() { return received; },
    since(mark: number) { return sliceSince(chunks, held, received, mark); },
  };
}

describe('sliceSince', () => {
  it('answers everything after the mark', () => {
    const buf = buffer(200_000);
    const mark = buf.received;
    buf.write('hello');
    expect(buf.since(mark)).toBe('hello');
  });

  it('joins only the chunks that span the mark', () => {
    const buf = buffer(200_000);
    buf.write('before ');
    const mark = buf.received;
    buf.write('one ');
    buf.write('two');
    expect(buf.since(mark)).toBe('one two');
  });

  it('slices into the chunk the mark falls inside', () => {
    const buf = buffer(200_000);
    buf.write('abcdef');
    expect(buf.since(2)).toBe('cdef');
  });

  it('clamps a mark evicted off the front to what is still held', () => {
    const buf = buffer(200_000);
    const before = buf.received;
    for (let i = 0; i < 30; i++) buf.write('x'.repeat(10_000));
    expect(buf.received).toBe(before + 300_000);

    // Less than the pane printed, never stale bytes offered as fresh.
    const since = buf.since(before);
    expect(since.length).toBeLessThanOrEqual(200_000);
    expect(since.length).toBeGreaterThan(0);
    expect(since).toBe('x'.repeat(since.length));
  });

  it('answers empty for a mark at or past the head', () => {
    const buf = buffer(200_000);
    buf.write('hello');
    expect(buf.since(buf.received)).toBe('');
    expect(buf.since(buf.received + 10)).toBe('');
  });

  it('answers empty for an empty buffer', () => {
    expect(sliceSince([], 0, 0, 0)).toBe('');
  });
});
