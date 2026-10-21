import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { shellEscapePath, shellEscapePosix } from './shell-escape';

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

/** File names, and the form cmd, Windows PowerShell, and pwsh each read back as
 *  that same literal. */
const WINDOWS_LITERAL: [string, string][] = [
  ['C:\\Users\\a.png', 'C:\\Users\\a.png'],
  ['C:\\a file.png', '"C:\\a file.png"'],
  ["C:\\it's.png", `"C:\\it's.png"`],
  // PowerShell closes a single-quoted string at U+2018–U+201B too; inside
  // double quotes, as in cmd, they are plain characters.
  ['C:\\x’; whoami; ’.txt', '"C:\\x’; whoami; ’.txt"'],
  ['a‘b‚c‛d', '"a‘b‚c‛d"'],
  ['C:\\a＂b＇c.txt', '"C:\\a＂b＇c.txt"'],
  ['C:\\a (1)^.txt', '"C:\\a (1)^.txt"'],
  // PowerShell's argument mode reads a bare comma as the array operator and a
  // leading `@` as splatting.
  ['C:\\Users\\a,b.png', '"C:\\Users\\a,b.png"'],
  ['@args', '"@args"'],
  // A `$` before a backslash starts no PowerShell variable: an admin share.
  ['\\\\host\\c$\\a b.txt', '"\\\\host\\c$\\a b.txt"'],
];

/** File names no form keeps literal in cmd, Windows PowerShell, and pwsh. */
const WINDOWS_REFUSED = [
  '',
  'C:\\repo\\a&rem.md',
  'C:\\a;b&whoami&c|d.txt',
  'C:\\a^b.txt',
  'C:\\a<b.txt',
  'C:\\a b\\',
  'C:\\café\\',
  'C:\\dl\\$(whoami).txt',
  '$env:USERNAME.txt',
  'C:\\a$',
  'a`$(whoami).txt',
  'C:\\%PATH%.txt',
  '100%.txt',
  'a!PATH!b.txt',
  'a"b.png',
  'a“; whoami; ”b.txt',
  'a„b.txt',
];

describe('shellEscapePath shell dispatch', () => {
  it('uses posix escaping for a posix Session', () => {
    expect(shellEscapePath('a b.png', 'posix')).toBe('a\\ b.png');
  });

  // Git Bash / WSL Sessions on Windows parse posix quoting, not cmd quoting.
  it('uses posix escape for a posix Session on Windows', () => {
    expect(shellEscapePath('$(calc.exe).txt', 'posix')).toBe('\\$\\(calc.exe\\).txt');
  });

  // A cmd pane can be running PowerShell by the time the path lands, and a
  // PowerShell pane cmd, so either gets the one form all three read alike.
  it.each(['cmd', 'powershell'] as const)('types each path in a %s Session in the form all three read alike, or refuses it', (kind) => {
    const expected = [...WINDOWS_LITERAL, ...WINDOWS_REFUSED.map((path) => [path, null] as const)];
    expect(expected.map(([path]) => [path, shellEscapePath(path, kind)])).toEqual(expected);
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

/** Run `typed` as the arguments of a command line in `shell`, and return the
 *  argv that command received. */
function argvThrough(shell: string, path: string, typed: string[]): unknown {
  if (shell === 'cmd') {
    const line = `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" -- ${typed.join(' ')}`;
    const result = spawnSync(path, ['/d', '/s', '/c', `"${line}"`], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }
  // A PowerShell function, so the shell's own argument parsing is what is read.
  const script = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); '
    + 'function argv { [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($args))) }; '
    + `argv ${typed.join(' ')}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(path, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe.skipIf(process.platform !== 'win32')('a cmd or PowerShell Session\'s path round-trips through every Windows shell', { timeout: 60_000 }, () => {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const shells: [string, string | null][] = [
    ['cmd', findShell(`${root}\\System32\\cmd.exe`)],
    ['powershell', findShell(`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`)],
    ['pwsh', findShell(...(process.env.PATH ?? '').split(delimiter).map(dir => join(dir, 'pwsh.exe')), `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\PowerShell\\7\\pwsh.exe`)],
  ];
  it('has every Windows shell on the CI runner', () => {
    if (process.env.CI) expect(shells.filter(([, shell]) => !shell)).toEqual([]);
  });

  // Exercise the real shipped batch launcher, with only its CLI entrypoint
  // replaced by an argv recorder. A PowerShell function misses this boundary.
  for (const [name, shell] of shells) {
    it.skipIf(!shell)(`passes accepted paths through dor.cmd from ${name}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'dor argv-'));
      try {
        const recorder = join(dir, 'argv.cjs');
        writeFileSync(recorder, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
        const bin = fileURLToPath(new URL('../../../dor/bin/', import.meta.url));
        const paths = [...WINDOWS_LITERAL.map(([path]) => path), ...WINDOWS_REFUSED];
        const accepted = paths.flatMap(path => {
          const quoted = shellEscapePath(path, 'powershell');
          return quoted === null ? [] : [{ path, quoted }];
        });
        const line = 'dor ' + accepted.map(({ quoted }) => quoted).join(' ');
        const env = { ...process.env, DORMOUSE_NODE: process.execPath, DORMOUSE_CLI_JS: recorder, PATH: bin + delimiter + process.env.PATH };
        const args = name === 'cmd' ? ['/d', '/s', '/c', line] : ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(line, 'utf16le').toString('base64')];
        const result = spawnSync(shell!, args, { env, cwd: dir, encoding: 'utf8', windowsVerbatimArguments: name === 'cmd', windowsHide: true, timeout: 10_000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual(accepted.map(({ path }) => path));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // The refused names too: any that were typed must come back literally.
  const paths = [...WINDOWS_LITERAL.map(([path]) => path), ...WINDOWS_REFUSED];
  for (const kind of ['cmd', 'powershell'] as const) {
    for (const [name, shell] of shells) {
      it.skipIf(!shell)(`reads a ${kind} Session's paths back literally in ${name}`, () => {
        const typed = paths.flatMap((path) => {
          const escaped = shellEscapePath(path, kind);
          return escaped === null ? [] : [[path, escaped]];
        });
        expect(argvThrough(name, shell!, typed.map(([, escaped]) => escaped))).toEqual(typed.map(([path]) => path));
      });
    }
  }
});
