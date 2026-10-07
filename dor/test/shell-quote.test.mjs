import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { buildShellCommandForKind, quotePowerShellArg } from '../dist/commands/shell-quote.js';

// Argv a posix-quoted command must hand back unchanged. The backslash cases are
// the ones fish reads differently from sh: inside its single quotes `\'` and
// `\\` are escapes, so `'a\'` would not close and the next element would run.
const TRICKY_ARGV = [
  'a\\', ';echo INJECTED;#',
  "it's", "'", '\\', '\\\\', "\\'", "x\\'; echo INJECTED; '",
  'back\\slash', 'a b', '$(echo INJECTED)', '`echo INJECTED`', '$HOME', '~', '*', '{a,b}',
  'line\nbreak', 'tab\there', '', '-n', 'café’s',
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
