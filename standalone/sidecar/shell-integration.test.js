// Runs the real bash/zsh integration scripts and checks what they emit, because
// the bug these guard against (W1) is an *emit*-side injection: by the time the
// parser sees the bytes the OSC has already been terminated, so no amount of
// parser hardening can catch it. That makes the shell scripts themselves the
// security boundary, and the only honest test is to run them.
// CommonJS to match its siblings: the sidecar package declares no `type`, so an
// ESM test here warns on every run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const BASH = '/bin/bash';
const ZSH = '/bin/zsh';

// The three sequences that terminate an OSC string (terminal-protocol.ts →
// findOscTerminator): BEL, ST, and the C1 ST.
const TERMINATORS = ['\x07', '\x1b\\', '\u009c'];

/** Source a shell's integration script, then call one of its helpers. */
function callHelper(shell, fn, value, env = {}) {
  const script = shell === BASH
    ? `source ${JSON.stringify(path.join(dir, 'shell-integration/bash/shellIntegration.bash'))} 2>/dev/null; ${fn} "$1"`
    : `source ${JSON.stringify(path.join(dir, 'shell-integration/zsh/.zshrc'))} 2>/dev/null; ${fn} "$1"`;
  // -i because the bash script returns early for a non-interactive shell; the
  // no-rc flags keep the developer's own dotfiles out of the result (and cut a
  // second off zsh).
  const args = shell === BASH
    ? ['--norc', '--noprofile', '-ic', script, 'x']
    : ['-f', '-ic', script, 'x'];
  return execFileSync(shell, [...args, value], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    // bash -i announces "no job control in this shell" on stderr; not our concern.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

const shells = [['bash', BASH], ['zsh', ZSH]].filter(([, bin]) => existsSync(bin));
assert.ok(shells.length > 0, 'expected at least one of bash/zsh to exist');

for (const [name, bin] of shells) {
  test(`${name}: safe_cwd removes every OSC terminator`, () => {
    for (const term of TERMINATORS) {
      const hostile = `/tmp/evil${term}\x1b]9;PWNED\x07`;
      const out = callHelper(bin, '__dormouse_633_safe_cwd', hostile);
      for (const t of TERMINATORS) {
        assert.ok(!out.includes(t), `${name}: ${JSON.stringify(t)} survived in ${JSON.stringify(out)}`);
      }
    }
  });

  test(`${name}: safe_cwd removes the C1 ST under LC_ALL=C too`, () => {
    // [[:cntrl:]] does not match U+009C in the C locale — verified, which is why
    // the scripts strip it explicitly first.
    const out = callHelper(bin, '__dormouse_633_safe_cwd', '/tmp/x\u009cy', { LC_ALL: 'C' });
    assert.ok(!out.includes('\u009c'), `${name}: C1 ST survived as ${JSON.stringify(out)}`);
  });

  test(`${name}: safe_cwd leaves an ordinary path byte-for-byte`, () => {
    const ordinary = '/Users/someone/src/my-project (v2)';
    assert.equal(callHelper(bin, '__dormouse_633_safe_cwd', ordinary), ordinary);
  });

  test(`${name}: safe_cwd keeps backslashes and semicolons, which Cwd= needs raw`, () => {
    // Cwd= is read verbatim by the parser precisely so Windows paths survive;
    // stripping must not become escaping.
    const win = 'C:\\Users\\someone\\proj';
    assert.equal(callHelper(bin, '__dormouse_633_safe_cwd', win), win);
  });

  test(`${name}: escape neutralizes terminators in the E command line`, () => {
    const hostile = `echo hi\x07\x1b]9;PWNED\x07`;
    const out = callHelper(bin, '__dormouse_633_escape', hostile);
    for (const t of TERMINATORS) {
      assert.ok(!out.includes(t), `${name}: ${JSON.stringify(t)} survived in ${JSON.stringify(out)}`);
    }
    // Escaped, not dropped — the parser decodes \xNN back, so E stays verbatim.
    assert.ok(out.includes('\\x07'), `${name}: expected \\x07 in ${JSON.stringify(out)}`);
    assert.ok(out.includes('\\x1b'), `${name}: expected \\x1b in ${JSON.stringify(out)}`);
  });

  test(`${name}: escape still handles what it always did`, () => {
    assert.equal(callHelper(bin, '__dormouse_633_escape', 'a;b\\c'), 'a\\x3bb\\\\c');
  });
}
