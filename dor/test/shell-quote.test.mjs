import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { buildShellCommandForKind, buildWindowsPortableCommand, quotePowerShellArg } from '../dist/commands/shell-quote.js';

// Argv a posix-quoted command must hand back unchanged. The backslash cases are
// the ones fish reads differently from sh: inside its single quotes `\'` and
// `\\` are escapes, so `'a\'` would not close and the next element would run.
const TRICKY_ARGV = [
  'a\\', ';echo INJECTED;#',
  "it's", "'", '\\', '\\\\', "\\'", "x\\'; echo INJECTED; '",
  'back\\slash', 'a b', '$(echo INJECTED)', '`echo INJECTED`', '$HOME', '~', '*', '{a,b}',
  'line\nbreak', 'tab\there', '', '-n', 'café’s', '=sh', '~root', 'a=b',
];

const ECHO_ARGV = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';

/** Where each shell lives, or null when this machine has none. */
function findShell(...candidates) {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const SHELLS = [
  ['sh', findShell('/bin/sh'), []],
  ['bash', findShell('/bin/bash'), ['--norc', '--noprofile']],
  ['zsh', findShell('/bin/zsh'), ['-f']],
  ['dash', findShell('/bin/dash', '/usr/bin/dash'), []],
  ['fish', findShell('/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'), ['--no-config']],
];

for (const [name, shell, flags] of SHELLS) {
  test(`posix quoting round-trips tricky argv through ${name}`, { skip: shell ? false : `${name} is not installed` }, () => {
    const command = buildShellCommandForKind('posix', [process.execPath, '-e', ECHO_ARGV, '--', ...TRICKY_ARGV]);
    const result = spawnSync(shell, [...flags, '-c', command], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), TRICKY_ARGV);
  });
}

test('posix quoting steps a backslash outside the single quotes', () => {
  assert.equal(buildShellCommandForKind('posix', ['a\\', ';x;#']), "'a'\\\\'' ';x;#'");
});

test('PowerShell quoting doubles every single-quote character PowerShell reads', () => {
  // U+2018–U+201B close a PowerShell single-quoted string just as `'` does.
  for (const quote of ["'", '‘', '’', '‚', '‛']) {
    assert.equal(quotePowerShellArg(`a${quote}; calc; ${quote}b`), `'a${quote}${quote}; calc; ${quote}${quote}b'`);
  }
  assert.equal(
    buildShellCommandForKind('powershell', ['cat', 'x’; calc; ’.txt']),
    "cat 'x’’; calc; ’’.txt'",
  );
});

// Typed at a prompt that may be cmd, Windows PowerShell, or pwsh: each element
// reads back alike there or the command has no form (`lib/src/lib/shell-escape.test.ts`
// runs the paths through the real shells).
test('a Windows-portable command keeps its program bare and refuses what any of them expands', () => {
  assert.equal(
    buildWindowsPortableCommand(['dor', '__view-file', 'C:\\a b\\it’s (1)&x.md']),
    'dor __view-file "C:\\a b\\it’s (1)&x.md"',
  );
  assert.equal(buildWindowsPortableCommand(['C:\\Program Files\\view.exe', 'a.md']), null);
  for (const arg of ['', 'C:\\a&rem.md', 'C:\\a^b.md', 'C:\\a b\\', 'C:\\$(whoami).md', 'a`b', '%PATH%', 'a!b', 'a"b', 'a“b', 'a\rb']) {
    assert.equal(buildWindowsPortableCommand(['dor', arg]), null, arg);
  }
  assert.equal(buildWindowsPortableCommand([]), null);
});

// Without a zsh to round-trip through, the form itself: EQUALS expands only a
// word's leading `=`.
test('posix quoting quotes a leading = and leaves an inner one bare', () => {
  assert.equal(buildShellCommandForKind('posix', ['=sh', 'a=b']), "'=sh' a=b");
});

// cmd has no round-trip off Windows (`lib/src/lib/shell-escape.test.ts` runs
// one through the real cmd.exe there), so these model the two documented
// parsers a typed cmd line passes through.

/** What cmd hands the program for a typed line, in command-line context with
 *  delayed expansion off: `%NAME%` and `%NAME:…%` expand when NAME is set and
 *  stay literal when not; then outside quotes `^` keeps the next character and
 *  an operator is syntax, while every unescaped `"` toggles quoting. */
function cmdReads(line, vars) {
  let expanded = '';
  for (let i = 0; i < line.length; i++) {
    const end = line[i] === '%' ? line.indexOf('%', i + 1) : -1;
    const name = end > i ? line.slice(i + 1, end).split(':')[0].toUpperCase() : '';
    if (name && Object.hasOwn(vars, name)) {
      expanded += vars[name];
      i = end;
    } else expanded += line[i];
  }
  let out = '';
  let quoted = false;
  for (let i = 0; i < expanded.length; i++) {
    const c = expanded[i];
    if (c === '"') quoted = !quoted;
    if (quoted || c === '"') out += c;
    else if (c === '^') {
      if (i + 1 === expanded.length) throw new Error(`cmd reads a trailing ^ in ${line} as a continuation`);
      out += expanded[++i];
    } else if (/[&|<>()]/.test(c)) throw new Error(`cmd reads ${c} in ${line} as an operator`);
    else out += c;
  }
  return out;
}

/** The program's argv for a command line, by the MSVCRT rules
 *  `CommandLineToArgvW` shares: argv[0] ends at whitespace outside quotes and
 *  has no escapes; after it, 2n backslashes before `"` are n and the quote
 *  toggles, 2n+1 are n and a literal quote. A `""` inside quotes is where the
 *  two disagree, so the model refuses it. */
function msvcrtArgv(line) {
  const blank = (c) => c === ' ' || c === '\t';
  let i = 0;
  let program = '';
  let quoted = false;
  for (; i < line.length && (quoted || !blank(line[i])); i++) {
    if (line[i] === '"') quoted = !quoted;
    else program += line[i];
  }
  const argv = [program];
  for (;;) {
    while (blank(line[i])) i++;
    if (i >= line.length) return argv;
    let arg = '';
    quoted = false;
    while (i < line.length && (quoted || !blank(line[i]))) {
      let slashes = 0;
      while (line[i] === '\\') { slashes++; i++; }
      if (line[i] === '"') {
        arg += '\\'.repeat(slashes >> 1);
        if (slashes % 2) arg += '"';
        else if (quoted && line[i + 1] === '"') throw new Error(`"" inside quotes in ${line} reads differently by runtime`);
        else quoted = !quoted;
        i++;
      } else {
        arg += '\\'.repeat(slashes);
        if (i < line.length && (quoted || !blank(line[i]))) arg += line[i++];
      }
    }
    argv.push(arg);
  }
}

const CMD_VARS = { PATH: 'C:\\Windows', B: 'BEE', 'PATH^': 'unreachable' };
const CMD_TRICKY_ARGV = [
  'say "hi"', '"', 'x"y', 'a"&calc&"b', '"a&b"', '\\"', 'a\\"b', 'a\\\\"b c', 'a b\\', 'a\\', 'a b\\\\', '',
  'a&b', 'a b', 'console.log(process.argv[1])', '(1)', 'a^b', '^', 'x^', 'a|b', '<x>', 'a ^& b',
  '100%', '%PATH%', '%path:Win=Mac%', '%%', '50% of 80%', 'a%b%c', '%"%', '% "x" %', '!PATH!', '"%PATH%"&echo %PATH%',
  'a,b', 'a;b', '@x', 'tab\there', 'café’s', '=x', '-n', 'C:\\Program Files\\x', 'C:\\a b\\it’s (1)&x.md',
];

test('cmd quoting reads back through cmd and then the program argv parser', () => {
  for (const program of ['prog', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\x (86)\\a&b.exe']) {
    const line = buildShellCommandForKind('cmd', [program, ...CMD_TRICKY_ARGV]);
    assert.deepEqual(msvcrtArgv(cmdReads(line, CMD_VARS)), [program, ...CMD_TRICKY_ARGV], line);
  }
  for (const arg of CMD_TRICKY_ARGV) {
    const line = buildShellCommandForKind('cmd', ['prog', arg]);
    assert.deepEqual(msvcrtArgv(cmdReads(line, CMD_VARS)), ['prog', arg], line);
  }
});

test('cmd quoting keeps an argument without " or % in plain quotes', () => {
  assert.equal(
    buildShellCommandForKind('cmd', ['C:\\Program Files\\nodejs\\node.exe', '-e', 'console.log(1)', 'a&b', 'a b\\', 'x^']),
    '"C:\\Program Files\\nodejs\\node.exe" -e "console.log(1)" "a&b" "a b\\\\" "x^"',
  );
  assert.equal(buildShellCommandForKind('cmd', ['echo', 'say "hi"', '100%']), 'echo ^"say \\^"hi\\^"^" ^"100%^"');
});
