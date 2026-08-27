// Runs the real bash/zsh integration scripts and checks what they emit, because
// the bug these guard against (W1) is an *emit*-side injection: by the time the
// parser sees the bytes the OSC has already been terminated, so no amount of
// parser hardening can catch it. That makes the shell scripts themselves the
// security boundary, and the only honest test is to run them.
// CommonJS to match its siblings: the sidecar package declares no `type`, so an
// ESM test here warns on every run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const dir = __dirname;

/**
 * Resolve a shell off PATH, then the usual absolute spellings. Hardcoding
 * `/bin/<shell>` silently dropped zsh on CI, where it lives in `/usr/bin` — the
 * suite went green having covered half of what it claims to.
 */
function findShell(name) {
  const fromPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  const resolved = fromPath.status === 0 ? fromPath.stdout.split('\n')[0].trim() : '';
  if (resolved && existsSync(resolved)) return resolved;
  return [`/bin/${name}`, `/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`]
    .find((candidate) => existsSync(candidate)) ?? null;
}

const BASH = findShell('bash');
const ZSH = findShell('zsh');

// The three sequences that terminate an OSC string (terminal-protocol.ts →
// findOscTerminator): BEL, ST, and the C1 ST.
const TERMINATORS = ['\x07', '\x1b\\', '\u009c'];

/**
 * Source a shell's integration script, call one of its helpers, and echo the
 * out-param it sets. The helpers assign `__dormouse_633_out` rather than
 * printing, so the emitters can avoid a `$(...)` fork on every prompt.
 */
function callHelper(shell, fn, value, env = {}) {
  const source = shell === BASH
    ? path.join(dir, 'shell-integration/bash/shellIntegration.bash')
    : path.join(dir, 'shell-integration/zsh/.zshrc');
  const script = `source ${JSON.stringify(source)} 2>/dev/null; ${fn} "$1"; printf '%s' "$__dormouse_633_out"`;
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

const shells = [['bash', BASH], ['zsh', ZSH]].filter(([, bin]) => bin);
// Say out loud what was and was not covered. A shell that is merely absent
// still reads as a pass in the summary line, which is how the zsh half of this
// suite went unnoticed on CI for a run.
const missing = [['bash', BASH], ['zsh', ZSH]].filter(([, bin]) => !bin).map(([n]) => n);
console.error(`shell-integration: covering ${shells.map(([n]) => n).join(', ') || '(none)'}`
  + (missing.length ? `; NOT covered (not installed): ${missing.join(', ')}` : ''));
// bash is the floor: it is the one shell present on every platform we test on,
// and a run that covers neither is not a pass.
assert.ok(BASH, 'bash must be available to test the shell-integration emitters');

for (const [name, bin] of shells) {
  test(`${name}: safe_cwd removes every OSC terminator`, () => {
    // One fixture carrying all three, rather than one spawn per terminator for
    // a byte-identical hazard set.
    const hostile = `/tmp/evil${TERMINATORS.join('x')}\x1b]9;PWNED\x07`;
    const out = callHelper(bin, '__dormouse_633_safe_cwd', hostile);
    for (const t of TERMINATORS) {
      assert.ok(!out.includes(t), `${name}: ${JSON.stringify(t)} survived in ${JSON.stringify(out)}`);
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
