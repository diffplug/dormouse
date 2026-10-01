import { describe, expect, it } from 'vitest';
import type { IBuffer, IBufferLine } from '@xterm/xterm';
import { bufferLine, fakeXterm } from './copy-text-fixtures';
import { detectTokenAt, detectTokenInBuffer } from './smart-token';

/** A buffer of `lines`, each row in `wrapped` a soft wrap continuing the one before. */
const bufferOf = (lines: readonly IBufferLine[], wrapped: readonly number[] = []) =>
  ({ length: lines.length, getLine: (r: number) => lines[r] && { ...lines[r], isWrapped: wrapped.includes(r) } }) as unknown as IBuffer;
const cellsOf = (text: string) => [...text].map((c): [string, number] => [c, 1]);

/** `buffer`, recording each row whose cells a read touches, and how many. */
function spied(buffer: IBuffer) {
  const reads: number[] = [];
  const getLine = (r: number) => {
    const line = buffer.getLine(r);
    return line && { ...line, getCell: (c: number) => (reads.push(r), line.getCell(c)) };
  };
  return { buffer: { length: buffer.length, getLine } as unknown as IBuffer, reads };
}

function at(line: string, anchor: string) {
  const col = line.indexOf(anchor);
  return detectTokenAt(line, col);
}

describe('detectTokenInBuffer', () => {
  it.each([['界', 2], ['e\u0301', 1], ['👩‍💻', 2]] as const)(
    'maps token boundaries after %s using cell widths', (prefix, width) => {
      const url = 'https://a.co';
      const line = bufferLine([[prefix, width], [' ', 1], ...cellsOf(url)]);
      expect(detectTokenInBuffer(bufferOf([line]), 0, width + 1)).toEqual({
        kind: 'url', text: url, start: { row: 0, col: width + 1 }, end: { row: 0, col: width + url.length },
      });
    },
  );

  it('includes both cells of a wide character at the end of a path', () => {
    const buffer = bufferOf([bufferLine([['/', 1], ['界', 2], [' ', 1]])]);
    expect(detectTokenInBuffer(buffer, 0, 2)).toEqual({ kind: 'path', text: '/界', start: { row: 0, col: 0 }, end: { row: 0, col: 2 } });
    expect(detectTokenInBuffer(buffer, 0, 3)).toBeNull();
    expect(detectTokenInBuffer(buffer, 1, 0)).toBeNull();
  });

  it('reads a token across the soft wraps either side of the pointer', () => {
    const line = 'see https://github.com/diffplug/dormouse/pull/853 ok';
    const rows = [line.slice(0, 20), line.slice(20, 40), line.slice(40)];
    const buffer = fakeXterm(rows, { cols: 20, wrapped: [1, 2] }).buffer.active;
    const token = { kind: 'url', text: 'https://github.com/diffplug/dormouse/pull/853', start: { row: 0, col: 4 }, end: { row: 2, col: 8 } };
    for (const [row, col] of [[0, 8], [1, 2], [2, 2]]) expect(detectTokenInBuffer(buffer, row, col)).toEqual(token);
    // Trimmed scrollback can leave the buffer's first row a continuation.
    expect(detectTokenInBuffer(fakeXterm(rows, { cols: 20, wrapped: [0, 1, 2] }).buffer.active, 0, 8)).toEqual(token);
    // A row the program ended is whitespace.
    expect(detectTokenInBuffer(fakeXterm(rows, { cols: 20 }).buffer.active, 1, 2)).toBeNull();
  });

  it('reads a row a soft wrap joins only when the token runs into it', () => {
    const rows = ['aaaa bbbb cccc ddddd', 'x https://a.co/b yyy', 'eeee ffff gggg hhhhh'];
    const inside = spied(fakeXterm(rows, { cols: 20, wrapped: [1, 2] }).buffer.active);
    expect(detectTokenInBuffer(inside.buffer, 1, 5)).toMatchObject({ text: 'https://a.co/b', start: { row: 1, col: 2 }, end: { row: 1, col: 15 } });
    expect(new Set(inside.reads)).toEqual(new Set([1]));
    rows[1] = 'see https://a.co/bbb';
    rows[2] = 'ccc dddd eeee ffffff';
    const below = spied(fakeXterm(rows, { cols: 20, wrapped: [1, 2] }).buffer.active);
    expect(detectTokenInBuffer(below.buffer, 1, 5)).toMatchObject({ text: 'https://a.co/bbbccc', start: { row: 1, col: 4 }, end: { row: 2, col: 2 } });
    expect(new Set(below.reads)).toEqual(new Set([1, 2]));
  });

  it('reads only the cell under the pointer when it is blank', () => {
    const rows = ['see https://a.co/bbb'];
    const { buffer, reads } = spied(fakeXterm(rows, { cols: 20 }).buffer.active);
    expect(detectTokenInBuffer(buffer, 0, 3)).toBeNull();
    expect(reads).toHaveLength(1);
  });

  it('re-examines surrounding text when the probed character stays unchanged', () => {
    const rows = ['see https://a.co'];
    const buffer = fakeXterm(rows).buffer.active;
    expect(detectTokenInBuffer(buffer, 0, 5)?.text).toBe('https://a.co');
    rows[0] = 'see https://b.co/longer';
    expect(detectTokenInBuffer(buffer, 0, 5)).toEqual({
      kind: 'url', text: 'https://b.co/longer', start: { row: 0, col: 4 }, end: { row: 0, col: 22 },
    });
    rows[0] = 'see nothing';
    expect(detectTokenInBuffer(buffer, 0, 5)).toBeNull();
    rows[0] = 'see https://c.co';
    expect(detectTokenInBuffer(buffer, 0, 5)?.text).toBe('https://c.co');
  });

  it('re-examines changed soft-wrap contents and boundaries at the same cell', () => {
    const rows = ['see https://a.co/', 'old'];
    const wrapped = [1];
    const buffer = fakeXterm(rows, { cols: 17, wrapped }).buffer.active;
    expect(detectTokenInBuffer(buffer, 0, 5)?.text).toBe('https://a.co/old');
    rows[1] = 'longer';
    expect(detectTokenInBuffer(buffer, 0, 5)).toEqual({
      kind: 'url', text: 'https://a.co/longer', start: { row: 0, col: 4 }, end: { row: 1, col: 5 },
    });
    wrapped.length = 0;
    expect(detectTokenInBuffer(buffer, 0, 5)?.text).toBe('https://a.co/');
  });

  it('skips the blank a wide character leaves when it wraps', () => {
    const buffer = bufferOf([bufferLine([...cellsOf('/a/'), ['', 1]]), bufferLine([['界', 2], ['b', 1]])], [1]);
    expect(detectTokenInBuffer(buffer, 1, 2)).toEqual({ kind: 'path', text: '/a/界b', start: { row: 0, col: 0 }, end: { row: 1, col: 2 } });
  });
});

describe('detectTokenAt: URL', () => {
  it('http URL', () => {
    const line = 'see https://example.com for docs';
    const t = at(line, 'https');
    expect(t).toMatchObject({ kind: 'url', text: 'https://example.com' });
  });

  it('https URL', () => {
    const t = detectTokenAt('https://x.com', 3);
    expect(t?.text).toBe('https://x.com');
  });

  it('file URL', () => {
    const t = at('open file:///tmp/a.txt please', 'file');
    expect(t?.text).toBe('file:///tmp/a.txt');
  });

  it('strips trailing period', () => {
    const t = detectTokenAt('https://x.com.', 3);
    expect(t?.text).toBe('https://x.com');
  });

  it('strips multiple trailing punctuation', () => {
    const t = detectTokenAt('https://x.com?!!', 3);
    expect(t?.text).toBe('https://x.com');
  });

  it('keeps balanced trailing paren (wikipedia)', () => {
    const line = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    const t = detectTokenAt(line, 3);
    expect(t?.text).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('strips unmatched trailing paren', () => {
    const line = '(see https://x.com)';
    const t = at(line, 'https');
    expect(t?.text).toBe('https://x.com');
  });

  it('strips unmatched bracket and period together', () => {
    const t = detectTokenAt('https://x.com].', 3);
    expect(t?.text).toBe('https://x.com');
  });
});

describe('detectTokenAt: path', () => {
  it('absolute path', () => {
    const t = at('run /usr/local/bin/foo now', '/usr');
    expect(t).toMatchObject({ kind: 'path', text: '/usr/local/bin/foo' });
  });

  it('tilde path', () => {
    const t = at('cd ~/projects/repo', '~/');
    expect(t?.text).toBe('~/projects/repo');
  });

  it('dot-slash relative path', () => {
    const t = at('run ./bin/ok.sh', './');
    expect(t?.text).toBe('./bin/ok.sh');
  });

  it('dot-dot relative path', () => {
    const t = at('cp ../a/b .', '../');
    expect(t?.text).toBe('../a/b');
  });

  it('windows path', () => {
    const t = at(String.raw`open C:\Users\me now`, 'C:\\');
    expect(t?.text).toBe(String.raw`C:\Users\me`);
  });

  it('error location file:line', () => {
    const t = at('src/foo.ts:42 panicked', 'src/');
    expect(t).toMatchObject({ kind: 'path', text: 'src/foo.ts:42' });
  });

  it('error location file:line:col preserves trailing colons/digits', () => {
    const t = at('src/foo.ts:42:7 panicked', 'src/');
    expect(t?.text).toBe('src/foo.ts:42:7');
  });

  it('error location with trailing period is detected after stripping', () => {
    const t = at('Error at src/foo.ts:42. See docs.', 'src/');
    expect(t).toMatchObject({ kind: 'path', text: 'src/foo.ts:42' });
  });

  it('strips trailing period on absolute path', () => {
    const t = detectTokenAt('/tmp/a.', 0);
    expect(t?.text).toBe('/tmp/a');
  });
});

describe('detectTokenAt: non-matches', () => {
  it('plain word returns null', () => {
    expect(detectTokenAt('hello world', 0)).toBeNull();
  });

  it('whitespace position returns null', () => {
    expect(detectTokenAt('hello world', 5)).toBeNull();
  });

  it('empty line returns null', () => {
    expect(detectTokenAt('', 0)).toBeNull();
  });

  it('out-of-range column returns null', () => {
    expect(detectTokenAt('hi', -1)).toBeNull();
  });

  it('a bare word with colon but no digits is not an error location', () => {
    expect(detectTokenAt('foo:bar baz', 0)).toBeNull();
  });
});

describe('detectTokenAt: position sensitivity', () => {
  it('anywhere within the token finds it', () => {
    const line = 'go to https://example.com/path now';
    const tokenStart = line.indexOf('https');
    for (let i = tokenStart; i < tokenStart + 'https://example.com/path'.length; i++) {
      expect(detectTokenAt(line, i)?.text).toBe('https://example.com/path');
    }
  });
});
