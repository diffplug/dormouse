import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { shellEscapePosix, shellEscapeWindows } from './shell-escape';

describe('shellEscapePosix', () => {
  it('leaves safe paths untouched', () => {
    expect(shellEscapePosix('/tmp/a.png')).toBe('/tmp/a.png');
  });

  it('backslash-escapes spaces', () => {
    expect(shellEscapePosix('/tmp/a file.png')).toBe('/tmp/a\\ file.png');
  });

  it('backslash-escapes multiple spaces', () => {
    expect(shellEscapePosix('a b c')).toBe('a\\ b\\ c');
  });

  it('backslash-escapes single quotes', () => {
    expect(shellEscapePosix(`it's.png`)).toBe(`it\\'s.png`);
  });

  it('backslash-escapes double quotes', () => {
    expect(shellEscapePosix('a"b.png')).toBe('a\\"b.png');
  });

  it('backslash-escapes backslashes', () => {
    expect(shellEscapePosix('a\\b.png')).toBe('a\\\\b.png');
  });

  it('single-quote-wraps paths containing newlines (cannot backslash-escape: bash swallows `\\<newline>` as line continuation)', () => {
    expect(shellEscapePosix('a\nb')).toBe("'a\nb'");
  });

  it('single-quote-wraps paths containing carriage returns', () => {
    expect(shellEscapePosix('a\rb')).toBe("'a\rb'");
  });

  it("single-quote-wraps with the '\\'' idiom when input mixes newlines and single quotes", () => {
    expect(shellEscapePosix("a'b\nc")).toBe("'a'\\''b\nc'");
  });

  it('backslash-escapes shell metacharacters', () => {
    expect(shellEscapePosix('a$b')).toBe('a\\$b');
    expect(shellEscapePosix('a`b')).toBe('a\\`b');
    expect(shellEscapePosix('a&b')).toBe('a\\&b');
    expect(shellEscapePosix('a|b')).toBe('a\\|b');
    expect(shellEscapePosix('a;b')).toBe('a\\;b');
    expect(shellEscapePosix('a(b)c')).toBe('a\\(b\\)c');
    expect(shellEscapePosix('a<b>c')).toBe('a\\<b\\>c');
    expect(shellEscapePosix('a[b]c')).toBe('a\\[b\\]c');
    expect(shellEscapePosix('a{b}c')).toBe('a\\{b\\}c');
    expect(shellEscapePosix('a*b')).toBe('a\\*b');
    expect(shellEscapePosix('a?b')).toBe('a\\?b');
    expect(shellEscapePosix('a#b')).toBe('a\\#b');
    expect(shellEscapePosix('a~b')).toBe('a\\~b');
    expect(shellEscapePosix('a!b')).toBe('a\\!b');
  });

  it('handles empty string', () => {
    expect(shellEscapePosix('')).toBe(`''`);
  });

  it('preserves unicode (narrow no-break space is not U+0020 — stays)', () => {
    expect(shellEscapePosix('/tmp/café.png')).toBe('/tmp/café.png');
    expect(shellEscapePosix('a b')).toBe('a b');
  });

  it('preserves safe punctuation', () => {
    expect(shellEscapePosix('/a-b_c.d+e,f%g@h:i=j/k.png')).toBe('/a-b_c.d+e,f%g@h:i=j/k.png');
  });
});

describe('shellEscapeWindows', () => {
  it('wraps in double quotes', () => {
    expect(shellEscapeWindows('C:\\Users\\a.png')).toBe(`"C:\\Users\\a.png"`);
  });

  it('doubles embedded double quotes', () => {
    expect(shellEscapeWindows('a"b.png')).toBe(`"a""b.png"`);
  });

  it('handles spaces', () => {
    expect(shellEscapeWindows('C:\\a file.png')).toBe(`"C:\\a file.png"`);
  });

  it('handles empty string', () => {
    expect(shellEscapeWindows('')).toBe(`""`);
  });
});

describe('shellEscapePath OS dispatch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('./platform');
  });

  async function importShellEscape(opts: { isMac: boolean; isWindows: boolean }) {
    vi.doMock('./platform', () => ({ IS_MAC: opts.isMac, IS_WINDOWS: opts.isWindows }));
    return import('./shell-escape');
  }

  it('uses posix escape on macOS', async () => {
    const { shellEscapePath } = await importShellEscape({ isMac: true, isWindows: false });
    expect(shellEscapePath('a b.png')).toBe('a\\ b.png');
  });

  it('uses posix escape on Linux', async () => {
    const { shellEscapePath } = await importShellEscape({ isMac: false, isWindows: false });
    expect(shellEscapePath('a b.png')).toBe('a\\ b.png');
  });

  it('uses windows escape on Windows', async () => {
    const { shellEscapePath } = await importShellEscape({ isMac: false, isWindows: true });
    expect(shellEscapePath('a b.png')).toBe(`"a b.png"`);
  });
});
