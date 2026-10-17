import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { shellEscapePath, shellEscapePosix, shellEscapeWindows } from './shell-escape';

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

  // fish reads `\'` and `\\` as escapes inside single quotes, so a backslash
  // must sit outside them or `'a\'` swallows the rest of the line.
  it('steps a backslash outside the single quotes when it must quote', () => {
    expect(shellEscapePosix('a\\\nb')).toBe("'a'\\\\'\nb'");
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
  it('uses posix escaping for a posix Session', () => {
    expect(shellEscapePath('a b.png', 'posix')).toBe('a\\ b.png');
  });

  it('uses cmd escaping for a cmd Session', () => {
    expect(shellEscapePath('a b.png', 'cmd')).toBe(`"a b.png"`);
  });

  // A PowerShell double-quoted string is expandable: `"$(calc.exe).txt"` runs
  // the subexpression. Quote for the pane's shell, not the host platform.
  it('does not leave a subexpression live in a PowerShell Session', () => {
    expect(shellEscapePath('$(calc.exe).txt', 'powershell')).toBe(`'$(calc.exe).txt'`);
  });

  it('does not leave a variable interpolation live in a PowerShell Session', () => {
    expect(shellEscapePath('$env:USERNAME.txt', 'powershell')).toBe(`'$env:USERNAME.txt'`);
  });

  it('doubles embedded single quotes for PowerShell', () => {
    expect(shellEscapePath(`it's.png`, 'powershell')).toBe(`'it''s.png'`);
  });

  // PowerShell also closes a single-quoted string at U+2018–U+201B.
  it('doubles curly single quotes for PowerShell', () => {
    expect(shellEscapePath('x’; calc; ’.txt', 'powershell')).toBe(`'x’’; calc; ’’.txt'`);
    expect(shellEscapePath('a‘b‚c‛d', 'powershell')).toBe(`'a‘‘b‚‚c‛‛d'`);
  });

  it('leaves an inert path bare in a PowerShell Session', () => {
    expect(shellEscapePath('C:\\Users\\a.png', 'powershell')).toBe('C:\\Users\\a.png');
    expect(shellEscapePath('C:\\Users\\a b.png', 'powershell')).toBe(`'C:\\Users\\a b.png'`);
  });

  // PowerShell's argument mode reads a bare comma as the array operator, so an
  // unquoted `C:\a,b.png` would reach the command as two arguments.
  it('quotes a comma-bearing path in a PowerShell Session', () => {
    expect(shellEscapePath('C:\\Users\\a,b.png', 'powershell')).toBe(`'C:\\Users\\a,b.png'`);
  });

  it('quotes a leading-at path in a PowerShell Session', () => {
    expect(shellEscapePath('@args', 'powershell')).toBe(`'@args'`);
  });

  // Git Bash / WSL Sessions on Windows parse posix quoting, not cmd quoting.
  it('uses posix escape for a posix Session on Windows', () => {
    expect(shellEscapePath('$(calc.exe).txt', 'posix')).toBe('\\$\\(calc.exe\\).txt');
  });
});

/** The first of `candidates` this machine has, or null. */
function findShell(...candidates: string[]): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

describe('shellEscapePosix round-trips through a real shell', () => {
  // Both forms: backslash-escaped, and single-quoted for a line break.
  const paths = ['/tmp/a\\', "/tmp/it's", '/tmp/a b$(x)`y`', '/tmp/a\\\nb', "/tmp/x\\'\n; echo INJECTED; '", '/tmp/~*?[a]{b,c}'];
  const shells: [string, string | null, string[]][] = [
    ['sh', findShell('/bin/sh'), []],
    ['fish', findShell('/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'), ['--no-config']],
  ];
  for (const [name, shell, flags] of shells) {
    it.skipIf(!shell)(`parses each escaped path back in ${name}`, () => {
      const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
      const command = [shellEscapePosix(process.execPath), '-e', `'${script}'`, '--', ...paths.map(shellEscapePosix)].join(' ');
      const result = spawnSync(shell!, [...flags, '-c', command], { encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(paths);
    });
  }
});
