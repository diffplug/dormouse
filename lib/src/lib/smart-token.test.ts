import { describe, expect, it } from 'vitest';
import { bufferLine } from './copy-text-fixtures';
import { detectTokenAt, detectTokenInBufferLine } from './smart-token';

function at(line: string, anchor: string) {
  const col = line.indexOf(anchor);
  return detectTokenAt(line, col);
}

describe('detectTokenInBufferLine', () => {
  it.each([['界', 2], ['e\u0301', 1], ['👩‍💻', 2]] as const)(
    'maps token boundaries after %s using cell widths', (prefix, width) => {
      const url = 'https://a.co';
      const line = bufferLine([[prefix, width], [' ', 1], ...[...url].map((c): [string, number] => [c, 1])]);
      expect(detectTokenInBufferLine(line, width + 1)).toEqual({
        kind: 'url', text: url, start: width + 1, end: width + 1 + url.length,
      });
    },
  );

  it('includes both cells of a wide character at the end of a path', () => {
    const line = bufferLine([['/', 1], ['界', 2], [' ', 1]]);
    expect(detectTokenInBufferLine(line, 2)).toEqual({ kind: 'path', text: '/界', start: 0, end: 3 });
    expect(detectTokenInBufferLine(line, 3)).toBeNull();
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
