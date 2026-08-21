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

describe('shellEscapePath shell dispatch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('./platform');
    vi.doUnmock('./shell-defaults');
  });

  async function importShellEscape(opts: {
    isMac: boolean;
    isWindows: boolean;
    platformString?: string;
    shell?: string;
  }) {
    vi.doMock('./platform', () => ({
      IS_MAC: opts.isMac,
      IS_WINDOWS: opts.isWindows,
      PLATFORM_STRING: opts.platformString ?? (opts.isWindows ? 'Windows' : opts.isMac ? 'macOS' : 'Linux'),
    }));
    vi.doMock('./shell-defaults', () => ({
      getDefaultShellOpts: () => (opts.shell === undefined ? null : { shell: opts.shell }),
    }));
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

  it('uses cmd escape on Windows when no shell has been selected', async () => {
    const { shellEscapePath } = await importShellEscape({ isMac: false, isWindows: true });
    expect(shellEscapePath('a b.png')).toBe(`"a b.png"`);
  });

  it('uses cmd escape when the selected shell is cmd.exe', async () => {
    const { shellEscapePath } = await importShellEscape({
      isMac: false,
      isWindows: true,
      shell: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(shellEscapePath('a b.png')).toBe(`"a b.png"`);
  });

  // A PowerShell double-quoted string is expandable: `"$(calc.exe).txt"` runs
  // the subexpression. Quote for the pane's shell, not the host platform.
  it('does not leave a subexpression live in a PowerShell pane', async () => {
    const { shellEscapePath } = await importShellEscape({
      isMac: false,
      isWindows: true,
      shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    });
    expect(shellEscapePath('$(calc.exe).txt')).toBe(`'$(calc.exe).txt'`);
  });

  it('does not leave a variable interpolation live in a PowerShell pane', async () => {
    const { shellEscapePath } = await importShellEscape({
      isMac: false,
      isWindows: true,
      shell: 'pwsh.exe',
    });
    expect(shellEscapePath('$env:USERNAME.txt')).toBe(`'$env:USERNAME.txt'`);
  });

  it('doubles embedded single quotes for PowerShell', async () => {
    const { shellEscapePath } = await importShellEscape({
      isMac: false,
      isWindows: true,
      shell: 'pwsh',
    });
    expect(shellEscapePath(`it's.png`)).toBe(`'it''s.png'`);
  });

  it('leaves a quote-free path bare in a PowerShell pane', async () => {
    const { shellEscapePath } = await importShellEscape({
      isMac: false,
      isWindows: true,
      shell: 'powershell.exe',
    });
    expect(shellEscapePath('C:\\Users\\a.png')).toBe('C:\\Users\\a.png');
    expect(shellEscapePath('C:\\Users\\a b.png')).toBe(`'C:\\Users\\a b.png'`);
  });

  // PowerShell's argument mode reads a bare comma as the array operator, so an
  // unquoted `C:\a,b.png` would reach the command as two arguments.
  it('quotes a comma-bearing path in a PowerShell pane', async () => {
    const { shellEscapePath } = await importShellEscape({
      isMac: false,
      isWindows: true,
      shell: 'powershell.exe',
    });
    expect(shellEscapePath('C:\\Users\\a,b.png')).toBe(`'C:\\Users\\a,b.png'`);
  });

  // Git Bash / WSL panes on Windows parse posix quoting, not cmd quoting.
  it('uses posix escape for a bash pane on Windows', async () => {
    const { shellEscapePath } = await importShellEscape({
      isMac: false,
      isWindows: true,
      shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
    });
    expect(shellEscapePath('$(calc.exe).txt')).toBe('\\$\\(calc.exe\\).txt');
  });
});
