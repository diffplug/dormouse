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
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
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

// The sequences that end an OSC string (`stringControlEndScan` in
// lib/src/lib/terminal-controls.ts): BEL, ST, the C1 ST, and the CAN and SUB
// that abort one.
const TERMINATORS = ['\x07', '\x1b\\', '\u009c', '\x18', '\x1a'];

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
    // One fixture carrying all of them, rather than one spawn per terminator
    // for a byte-identical hazard set.
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
    const hostile = `echo hi${TERMINATORS.join('x')}\x1b]9;PWNED\x07`;
    const out = callHelper(bin, '__dormouse_633_escape', hostile);
    for (const t of TERMINATORS) {
      assert.ok(!out.includes(t), `${name}: ${JSON.stringify(t)} survived in ${JSON.stringify(out)}`);
    }
    // Escaped, not dropped — the parser decodes \xNN back, so E stays verbatim.
    assert.ok(out.includes('\\x07'), `${name}: expected \\x07 in ${JSON.stringify(out)}`);
    assert.ok(out.includes('\\x1b'), `${name}: expected \\x1b in ${JSON.stringify(out)}`);
    assert.ok(out.includes('\\x18'), `${name}: expected \\x18 in ${JSON.stringify(out)}`);
    assert.ok(out.includes('\\x1a'), `${name}: expected \\x1a in ${JSON.stringify(out)}`);
  });

  test(`${name}: escape still handles what it always did`, () => {
    assert.equal(callHelper(bin, '__dormouse_633_escape', 'a;b\\c'), 'a\\x3bb\\\\c');
  });

  test(`${name}: escape keeps a multi-line command inside one sequence`, () => {
    assert.equal(callHelper(bin, '__dormouse_633_escape', 'cat <<EOF\nhi\r\nEOF'), 'cat <<EOF\\x0ahi\\x0d\\x0aEOF');
  });
}

// bash 4.0 is where a `bind -x` command runs with READLINE_LINE bound; 5.1
// is where every element of an array PROMPT_COMMAND runs.
const [BASH_MAJOR, BASH_MINOR] = execFileSync(BASH, ['-c', 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).trim().split(' ').map(Number);

/**
 * Drive the real bash integration on a PTY, one submitted line at a time.
 * `run` resolves with every `E` the line emitted (decoded as the parser decodes
 * it) and the text the shell printed, once the next prompt is drawn.
 */
function interactiveBash(profile) {
  const pty = require('node-pty');
  const home = mkdtempSync(path.join(os.tmpdir(), 'dormouse-bash-'));
  if (profile !== undefined) writeFileSync(path.join(home, '.profile'), profile);
  const shell = pty.spawn(BASH, ['--init-file', path.join(dir, 'shell-integration/bash/shellIntegration.bash')], {
    cols: 200,
    rows: 50,
    cwd: home,
    // Bare on purpose: an exported HISTCONTROL, PROMPT_COMMAND or TERM_PROGRAM
    // from the developer's shell would change what history keeps.
    env: { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color' },
  });
  const exited = new Promise((resolve) => shell.onExit(resolve));
  let output = '';
  let prompts = 0;
  let onPrompt = () => {};
  shell.onData((data) => {
    output += data;
    // A prompt is ready at the `B` that follows an `A`: `B` rides PS1, which
    // readline draws after taking the terminal raw, while input written at the
    // bare `A` meets the cooked terminal, where macOS eats Ctrl-T as STATUS. A
    // `bind -x` key redraws PS1, so a `B` with no fresh `A` is not a prompt.
    const seen = (output.match(/\x1b\]633;A\x07[\s\S]*?\x1b\]633;B\x07/g) || []).length;
    if (seen !== prompts) {
      prompts = seen;
      onPrompt();
    }
  });
  const nextPrompt = (count) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no prompt ${count}; tail: ${JSON.stringify(output.slice(-300))}`)), 15_000);
    onPrompt = () => {
      if (prompts >= count) {
        clearTimeout(timer);
        resolve();
      }
    };
    onPrompt();
  });
  const decode = (field) => field.replace(/\\(?:x([0-9a-fA-F]{2})|\\)/g, (_, hex) => (hex ? String.fromCharCode(parseInt(hex, 16)) : '\\'));
  let ready = nextPrompt(1);
  return {
    async run(line) {
      await ready;
      const start = output.length;
      shell.write(`${line}\r`);
      ready = nextPrompt(prompts + 1);
      await ready;
      const chunk = output.slice(start);
      return {
        commands: [...chunk.matchAll(/\x1b\]633;E;([^\x07]*)\x07/g)].map((m) => decode(m[1])),
        starts: chunk.split('\x1b]633;C\x07').length - 1,
        printed: chunk,
      };
    },
    async close() {
      // `exit`, not a signal: SIGHUP intermittently left bash (5.2, in a Linux
      // container) alive, and the live PTY kept the test process from exiting.
      shell.write('exit\r');
      const backstop = setTimeout(() => shell.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(backstop);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

// $BASH_COMMAND is only a line's first simple command, so the bash preexec reads
// the whole line back from history; this pins that it does, and that a line
// history did not take never reports the stale entry left in its place. Both
// hinge on bash's own line reader, which no `bash -c` reaches — hence the PTY.
test('bash: E is the whole submitted line, and never a stale history entry', { timeout: 60_000 }, async () => {
  const bash = interactiveBash();
  try {
    const expect = async (line, expected) => {
      const { commands } = await bash.run(line);
      assert.deepEqual(commands, [expected], `bash reported ${JSON.stringify(commands)} for ${JSON.stringify(line)}`);
    };
    // Seeds history: before 5.1, fc cannot vouch for a history's only entry.
    await expect('true', 'true');
    // $BASH_COMMAND reads `echo spaced`; the entry is matched whitespace aside.
    await expect('echo  spaced  &&  echo x', 'echo  spaced  &&  echo x');
    // Two physical lines, one joined entry: the last line appends, adding nothing.
    await expect('echo m1 && \\\recho m2', 'echo m1 && echo m2');
    await expect('HISTCONTROL=ignoredups', 'HISTCONTROL=ignoredups');
    await expect('echo p && echo q', 'echo p && echo q');
    // Kept out as a duplicate, so the last entry is still this very line.
    await expect('echo p && echo q', 'echo p && echo q');
    await expect('set +o history; echo a && echo b', 'set +o history; echo a && echo b');
    // History is off; the last entry contains `echo a` and is not this line.
    await expect('echo a', 'echo a');
    await expect('set -o history', 'set -o history');
    await expect("HISTIGNORE='cd /'", "HISTIGNORE='cd /'");
    await expect('cd / && echo hi', 'cd / && echo hi');
    // Kept out by HISTIGNORE; the last entry contains `cd /` but is the line before.
    await expect('cd /', 'cd /');
    await expect('unset HISTIGNORE; HISTCONTROL=ignorespace', 'unset HISTIGNORE; HISTCONTROL=ignorespace');
    await expect('cd / && echo hi', 'cd / && echo hi');
    // Kept out by its leading space, with the same stale entry.
    await expect(' cd /', 'cd /');
    // A widget the way fzf's Ctrl-R is one: a `bind -x` key that fills the line.
    const widget = `__widget() { READLINE_LINE='echo widget'; READLINE_POINT=11; }; bind -x '"\\C-t": __widget'`;
    await expect(widget, widget);
    await expect('cd / && echo hi', 'cd / && echo hi');
    // Ctrl-T, then Enter on the line it left.
    const key = await bash.run('\x14');
    if (BASH_MAJOR >= 4) {
      // The key is no command; the line it filled is, with the one E/C pair.
      assert.deepEqual(key.commands, ['echo widget']);
      assert.equal(key.starts, 1);
    } else {
      // 3.2 gives a `bind -x` command no signal, so the key still reads as one.
      // Its trap fires with the previous line last in history, which must not
      // be reported again.
      assert.ok(!key.commands.includes('cd / && echo hi'), `the previous line was re-reported: ${JSON.stringify(key.commands)}`);
    }
    // On 3.2 the widget left READLINE_LINE set; that must not silence a line.
    await expect('echo after && echo key', 'echo after && echo key');
    // The DEBUG trap leaves $_ as its own last word, so it passes the user's.
    const { printed } = await bash.run('echo foo; echo "u=$_"');
    assert.match(printed, /u=foo/);
    // Last, since it leaves every later line without its E/C: a hook appended
    // after ours in PROMPT_COMMAND fires the trap once the prompt is armed. The
    // last entry is then the line just run, which must not be reported again.
    await bash.run(`__sfx() { :; }; PROMPT_COMMAND="$PROMPT_COMMAND; __sfx"`);
    const { commands: afterHook } = await bash.run('cd / && echo hi');
    assert.ok(!afterHook.includes('cd / && echo hi'), `the previous line was re-reported: ${JSON.stringify(afterHook)}`);
  } finally {
    await bash.close();
  }
});

// systemd's /etc/profile.d/80-systemd-osc-context.sh (Ubuntu 26.04) turns
// PROMPT_COMMAND into an array with an empty first slot and appends its hook;
// a legacy rc file then assigns element 0. Startup replaced only element 0, so
// the hook ran after ours re-armed the trap and every line reported the hook's
// name instead of itself.
test('bash: an array PROMPT_COMMAND from the profile keeps E the submitted line', { timeout: 60_000, skip: BASH_MAJOR < 5 || (BASH_MAJOR === 5 && BASH_MINOR < 1) }, async () => {
  const bash = interactiveBash([
    '__sfx_ran() { __sfx_status=$?; __sfx_count=$((${__sfx_count:-0} + 1)); }',
    // systemd's own two lines, verbatim.
    '[ -n "$(declare -p PROMPT_COMMAND 2>/dev/null)" ] || PROMPT_COMMAND+=(\'\')',
    'PROMPT_COMMAND+=(__sfx_ran)',
    'PROMPT_COMMAND=false',
    '',
  ].join('\n'));
  try {
    for (const line of ['true', 'echo p && echo q']) {
      const { commands, starts } = await bash.run(line);
      assert.deepEqual(commands, [line], `bash reported ${JSON.stringify(commands)} for ${JSON.stringify(line)}`);
      assert.equal(starts, 1);
    }
    // Each element sees the command's $?, not the status of the element before it.
    await bash.run('(exit 7)');
    // The profile's hook still runs once per prompt: the first, then three lines.
    const { printed } = await bash.run('echo "n=$__sfx_count s=$__sfx_status"');
    assert.match(printed, /n=4 s=7/);
  } finally {
    await bash.close();
  }
});

// A DEBUG trap the profile set (a title setter, a timer) keeps running beside
// ours, and the line still reports as itself.
test('bash: a DEBUG trap from the profile still runs, and E is the submitted line', { timeout: 60_000 }, async () => {
  const bash = interactiveBash('trap \'__user_trapped="$__user_trapped|$BASH_COMMAND"\' DEBUG\n');
  try {
    const { commands, starts } = await bash.run('echo seen');
    assert.deepEqual(commands, ['echo seen']);
    assert.equal(starts, 1);
    const { printed } = await bash.run('echo "trapped=$__user_trapped"');
    assert.match(printed, /trapped=[\s\S]*\|echo seen\|/);
  } finally {
    await bash.close();
  }
});

// bash-preexec (Atuin, starship, other terminals' integrations) installs its
// DEBUG trap (from bash 5.3, a PS0 hook) and PROMPT_COMMAND at the first
// prompt, from an install string it leaves in PROMPT_COMMAND, and runs the hooks
// registered in its arrays, each preexec given the line `history 1` reads. This
// stand-in keeps that shape: the integration must register there, so the user's
// hooks run and E is the line, not bash-preexec's own function.
const BASH_PREEXEC_STAND_IN = [
  'bash_preexec_imported=defined',
  '__sbp_v=$(( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] ))',
  '__sbp_ret() { return "$1"; }',
  '__sbp_precmd() { local s=$? f; for f in "${precmd_functions[@]}"; do __sbp_ret "$s"; "$f"; done; }',
  '__sbp_interactive() { __sbp_ready=1; }',
  '__sbp_preexec() { local line f; line=$(HISTTIMEFORMAT= builtin history 1); line=${line#*[[:digit:]][* ] }; for f in "${preexec_functions[@]}"; do "$f" "$line"; done; }',
  '__sbp_trap() { [ -n "$__sbp_ready" ] || return; __sbp_ready=; __sbp_preexec; }',
  '__bp_invoke_preexec_from_ps0() { __sbp_preexec; }',
  // Its install, as bash-preexec 0.7 does it: the trap, or from bash 5.3 a PS0
  // hook; then its prologue joins element 0 of PROMPT_COMMAND and its epilogue
  // is appended, so every other element (systemd's hook on Ubuntu) stays between.
  '__sbp_install() {',
  '  if (( __sbp_v >= 503 )); then PS0=${PS0-}\'${ __bp_invoke_preexec_from_ps0 "$_" >&2; }\'; else trap \'__sbp_trap "$_"\' DEBUG; fi',
  '  local i; for i in "${!PROMPT_COMMAND[@]}"; do PROMPT_COMMAND[i]=${PROMPT_COMMAND[i]//"$__sbp_install_string"/}; done',
  '  PROMPT_COMMAND=__sbp_precmd${PROMPT_COMMAND:+$\'\\n\'$PROMPT_COMMAND}',
  '  if (( __sbp_v >= 501 )); then PROMPT_COMMAND+=(__sbp_interactive); else PROMPT_COMMAND+=$\'\\n__sbp_interactive\'; fi',
  '  __sbp_precmd; __sbp_interactive',
  '}',
  // Left in PROMPT_COMMAND for the first prompt, as an element of an array one.
  '__sbp_install_string=$\'trap - DEBUG\\n__sbp_install\'',
  'if (( __sbp_v >= 501 )); then PROMPT_COMMAND+=("$__sbp_install_string"); else PROMPT_COMMAND=${PROMPT_COMMAND:+$PROMPT_COMMAND$\'\\n\'}$__sbp_install_string; fi',
  'user_preexec() { __user_preexecs=$((${__user_preexecs:-0} + 1)); }',
  'preexec_functions+=(user_preexec)',
  '',
].join('\n');
test('bash: with bash-preexec loaded, its hooks run and E is the submitted line', { timeout: 60_000 }, async () => {
  const bash = interactiveBash(BASH_PREEXEC_STAND_IN);
  try {
    for (const line of ['true', 'echo p && echo q']) {
      const { commands, starts } = await bash.run(line);
      assert.deepEqual(commands, [line], `bash reported ${JSON.stringify(commands)} for ${JSON.stringify(line)}`);
      assert.equal(starts, 1);
    }
    const { printed } = await bash.run('(exit 7)');
    assert.match(printed, /\x1b\]633;D;7\x07/);
    const { printed: counted } = await bash.run('echo "preexecs=$__user_preexecs"');
    assert.match(counted, /preexecs=4/);
  } finally {
    await bash.close();
  }
});

// Setting ZDOTDIR in ~/.zshenv is how a user moves the rest of their zsh
// dotfiles. The integration sources that .zshenv itself, so it must follow the
// ZDOTDIR it leaves, or such a user's .zprofile and .zshrc never run. The
// default form only applies if that .zshenv sees ZDOTDIR unset, as it would
// without Dormouse.
for (const zshenv of ['ZDOTDIR="$HOME/.config/zsh"', 'export ZDOTDIR=${ZDOTDIR:-$HOME/.config/zsh}']) test(`zsh: \`${zshenv}\` in the user's .zshenv still finds their .zprofile and .zshrc`, { skip: !ZSH }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dormouse-zsh-'));
  try {
    const moved = path.join(home, '.config', 'zsh');
    mkdirSync(moved, { recursive: true });
    writeFileSync(path.join(home, '.zshenv'), `${zshenv}\n`);
    writeFileSync(path.join(moved, '.zprofile'), 'PROFILE_MARK=profile\n');
    writeFileSync(path.join(moved, '.zshrc'), 'RC_MARK=rc\n');
    const out = execFileSync(ZSH, ['-l', '-i', '-c', 'print -r -- "$PROFILE_MARK $RC_MARK $ZDOTDIR"'], {
      encoding: 'utf8',
      cwd: home,
      // What applyShellIntegration hands a zsh pane whose environment has no ZDOTDIR.
      env: { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', ZDOTDIR: path.join(dir, 'shell-integration/zsh'), USER_ZDOTDIR: home },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    assert.equal(out.trim(), `profile rc ${moved}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
