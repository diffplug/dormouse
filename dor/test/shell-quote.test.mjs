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
