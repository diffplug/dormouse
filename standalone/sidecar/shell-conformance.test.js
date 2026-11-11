// The real-shell conformance lane: every shell Dormouse offers on this OS,
// spawned the way the sidecar spawns a pane (`create` in pty-core.js over the
// pinned node-pty, the shipped integration scripts, the env pty-core builds),
// with its output read by the repo's own parser and reducer, the way the
// owner process reads it. Per shell it asserts what a user relies on and no
// other test spawns on every OS: their dotfiles load, the reported command line
// is the typed one, the reported cwd is local and right, prompt and command
// boundaries arrive in order, a graceful stop ends the shell and its child,
// and the pane's environment is Dormouse's, with the host's own left behind.
//
// Shells and cases are tables below: a shell, or a hostile command line, is one
// row. A shell that is not installed skips by name; a leg that lists it in
// DORMOUSE_REQUIRE_SHELLS fails instead (TESTING_AND_MODIFICATION_GUIDE.md).
// A case the product gets wrong is listed in KNOWN and runs as a `todo`.
//
// Cases already run elsewhere on the same OS are not repeated here: an idle
// bash's stop on POSIX (graceful-kill-posix.test.js) and an idle cmd.exe's on
// Windows (graceful-kill-windows.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const nodePty = require('node-pty');
const { create, detectAvailableShells } = require('./pty-core');

const PLATFORM = process.platform;
const WIN = PLATFORM === 'win32';
const GUARD_TEST = 'every shell DORMOUSE_REQUIRE_SHELLS names is installed';
const REQUIRED = (process.env.DORMOUSE_REQUIRE_SHELLS || '').split(',').map((name) => name.trim()).filter(Boolean);

// ── The repo's parser ─────────────────────────────────────────────────────
// Bundled from lib source with standalone's esbuild, as build-sidecar-proxy.mjs
// bundles the host modules: the owner's stream, the semantic events and
// replies it collects, the reducer, and the command-line equality Tools use.
const { createProcessedPtyStream, collectTerminalSemanticEvents, collectTerminalProtocolResponses,
  createTerminalPaneState, reduceTerminalState, isReportedCommandLine } = (() => {
  const esbuild = require(require.resolve('esbuild', { paths: [path.join(__dirname, '..')] }));
  const { workspaceSourceAliases } = require('../../scripts/workspace-sources.mjs');
  const built = esbuild.buildSync({
    stdin: {
      contents: [
        "export { createProcessedPtyStream } from './processed-pty-stream';",
        "export { collectTerminalSemanticEvents, collectTerminalProtocolResponses } from './terminal-protocol';",
        "export { createTerminalPaneState, reduceTerminalState } from './terminal-state';",
        "export { isReportedCommandLine } from './osc-sanitize';",
      ].join('\n'),
      resolveDir: path.join(__dirname, '../../lib/src/lib'),
      loader: 'ts',
      sourcefile: 'shell-conformance-parser.ts',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error',
    alias: workspaceSourceAliases(),
  });
  const parserModule = new module.constructor(path.join(__dirname, 'shell-conformance-parser.cjs'), module);
  parserModule._compile(built.outputFiles[0].text, parserModule.id);
  return parserModule.exports;
})();

// ── The sidecar's environment ─────────────────────────────────────────────
// Every pane here is spawned from an environment like a real launch's: the
// developer's own shell configuration removed, then what a launch from another
// terminal, a Claude Code session, the VS Code pty-host, or (macOS) Finder
// leaves in it. Outcome 6 asserts the pane keeps none of it.
for (const key of Object.keys(process.env)) {
  if (/^(?:DORMOUSE_.*|ZDOTDIR|USER_ZDOTDIR|BASH_ENV|ENV|PROMPT_COMMAND|PS[1-4]|HIST.*|XDG_[A-Z]+_HOME|fish_.*|__fish.*|__dormouse.*|NODE_TEST_CONTEXT)$/i.test(key)) {
    delete process.env[key];
  }
}
const SCRATCH = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dormouse-conformance-')));
process.on('exit', () => fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const CLI_BIN = path.join(SCRATCH, 'dor cli bin');
fs.mkdirSync(CLI_BIN);
const PLANTED = {
  // Another terminal's identity and a launching Claude Code session's markers
  // (FOREIGN_TERMINAL_ENV in pty-core.js).
  TERM_PROGRAM: 'Planted.app', TMUX: '/tmp/tmux-planted/default,1,0', TMUX_PANE: '%9', ITERM_SESSION_ID: 'w0t0p0:planted',
  TERM_SESSION_ID: 'planted', WT_SESSION: 'planted', KITTY_WINDOW_ID: '9', VTE_VERSION: '7000', COLORFGBG: '15;0',
  CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'planted', CLAUDE_CODE_MESSAGING_TOKEN: 'planted',
  // Dormouse's internals and the sidecar's storage roots (docs/specs/dor-cli.md).
  DORMOUSE_CLI_BIN: CLI_BIN,
  DORMOUSE_SHELL_INTEGRATION_DIR: path.join(__dirname, 'shell-integration'),
  DORMOUSE_STATE_DIR: path.join(SCRATCH, 'state'),
  DORMOUSE_RECOVERY_DIR: path.join(SCRATCH, 'recovery'),
  DORMOUSE_DEHYDRATE: 'planted',
  // The VS Code pty-host runs as Electron-as-Node.
  ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1',
};
// Gone from the pane, whatever the platform; the identity is replaced.
const MUST_NOT_LEAK = Object.keys(PLANTED).filter((key) => key !== 'TERM_PROGRAM');
const APPDIR = path.join(SCRATCH, 'appdir');
const GUI_NODE_DIR = path.join(SCRATCH, 'gui-node');
Object.assign(process.env, PLANTED);
if (PLATFORM === 'linux') {
  // The AppImage launcher's additions (withoutAppImageEnv).
  Object.assign(process.env, { APPDIR, APPIMAGE: path.join(SCRATCH, 'Dormouse.AppImage'), ARGV0: 'Dormouse.AppImage',
    PYTHONHOME: path.join(APPDIR, 'usr'), LD_LIBRARY_PATH: path.join(APPDIR, 'usr/lib') });
  MUST_NOT_LEAK.push('APPDIR', 'APPIMAGE', 'ARGV0', 'PYTHONHOME', 'LD_LIBRARY_PATH');
}
if (WIN) {
  // Standalone's GUI-subsystem node.exe directory (withoutGuiNodeDir).
  process.env.DORMOUSE_GUI_NODE_DIR = GUI_NODE_DIR;
  process.env.PATH = `${GUI_NODE_DIR};${process.env.PATH}`;
  MUST_NOT_LEAK.push('DORMOUSE_GUI_NODE_DIR');
}
// A Finder or Dock launch has no locale.
if (PLATFORM === 'darwin') for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE']) delete process.env[key];
const HOST_LANG = process.env.LANG;

// ── Shells ────────────────────────────────────────────────────────────────
// `find` picks the shell out of what `detectAvailableShells` offers on this OS,
// so the table follows the picker. `family` chooses the command syntax below;
// `integrated` is whether the shell reports boundaries (outcomes 2 to 4), and
// `prompt` is how a pane without them shows it is ready for input.
const PWSH_PROMPT = /(?:PS [^\r\n]*|DMPROMPT)> /;
const SHELLS = [
  { name: 'zsh', platforms: ['darwin', 'linux'], family: 'posix', integrated: true, find: (offered) => byName(offered, 'zsh') },
  { name: 'bash', platforms: ['darwin', 'linux'], family: 'posix', integrated: true, find: (offered) => byName(offered, 'bash') },
  // No shipped script: fish >= 4 emits OSC 133 and OSC 7 itself
  // (docs/specs/terminal-state.md), so an older fish reports nothing.
  { name: 'fish', platforms: ['darwin', 'linux'], family: 'fish', integrated: true, prompt: /@[^\r\n]*[>#] /, find: (offered) => byName(offered, 'fish'),
    unreported: (shell) => {
      const version = spawnSync(shell.path, ['--version'], { encoding: 'utf8' }).stdout?.match(/(\d+)\.\d+/);
      return version && Number(version[1]) < 4 ? `${version[0]} predates fish's own OSC 133 (fish 4)` : null;
    } },
  // POSIX offers pwsh only as the user's $SHELL.
  { name: 'pwsh', platforms: ['darwin', 'linux', 'win32'], family: 'pwsh', integrated: true, prompt: PWSH_PROMPT, find: (offered) => (WIN ? byLabel(offered, 'PowerShell') : pwshAsLoginShell()) },
  { name: 'powershell', platforms: ['win32'], family: 'pwsh', integrated: true, prompt: PWSH_PROMPT, find: (offered) => byLabel(offered, 'Windows PowerShell') },
  { name: 'cmd', platforms: ['win32'], family: 'cmd', integrated: false, prompt: /[A-Za-z]:\\[^\r\n>]*>/, find: (offered) => byLabel(offered, 'Command Prompt') },
  { name: 'git-bash', platforms: ['win32'], family: 'posix', integrated: true, msys: true, find: (offered) => byLabel(offered, 'Git Bash') },
  { name: 'wsl', platforms: ['win32'], family: 'posix', integrated: true, wsl: true, find: (offered) => offered.find((shell) => /[\\/]wsl\.exe$/i.test(shell.path)) ?? null },
].filter((row) => row.platforms.includes(PLATFORM));

const byName = (offered, name) => offered.find((shell) => shell.name === name) ?? null;
const byLabel = (offered, label) => offered.find((shell) => shell.name === label) ?? null;
function pwshAsLoginShell() {
  const found = spawnSync('which', ['pwsh'], { encoding: 'utf8' });
  const resolved = found.status === 0 ? found.stdout.trim() : '';
  return resolved ? { name: 'pwsh', path: resolved, args: [] } : null;
}

/** name -> the offered `{ path, args }`, or null. POSIX detection runs without
 *  the developer's $SHELL, so its order, not theirs, picks between two bashes.
 *  `unreported` says why an integrated shell reports no boundaries here. */
const LOCATED = (async () => {
  const env = { ...process.env };
  if (!WIN) delete env.SHELL;
  const offered = await detectAvailableShells({ env });
  return new Map(SHELLS.map((row) => {
    const shell = row.find(offered);
    return [row.name, shell && { ...shell, unreported: knownUnintegrated(row) ?? row.unreported?.(shell) ?? null }];
  }));
})();

/** Which of `required` this leg lacks: not in the table for this OS, or not found. */
function missingShells(required, located) {
  return required.filter((name) => !located.get(name));
}

test(GUARD_TEST, { timeout: 60_000 }, async () => {
  const located = await LOCATED;
  console.error(`shell-conformance on ${PLATFORM}: ${SHELLS.map(({ name }) => `${name}=${located.get(name)?.path ?? 'NOT INSTALLED'}`).join(', ')}`);
  const missing = missingShells(REQUIRED, located);
  assert.deepEqual(missing, [], `DORMOUSE_REQUIRE_SHELLS names shells this ${PLATFORM} leg does not have: ${missing.join(', ')}`);
});

test('the require-shells guard fails a leg that lacks a named shell', { timeout: 60_000 }, () => {
  const located = new Map([['zsh', { path: '/bin/zsh' }], ['fish', null]]);
  assert.deepEqual(missingShells(['zsh', 'fish', 'tcsh'], located), ['fish', 'tcsh']);
  // And end to end: this file, run as CI runs it, with a shell no leg has.
  const env = { ...process.env, DORMOUSE_REQUIRE_SHELLS: 'zsh,no-such-shell' };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${GUARD_TEST}$`, __filename],
    { env, encoding: 'utf8', timeout: 50_000 });
  assert.notEqual(run.status, 0, `the guard passed with a missing shell:\n${run.stdout}`);
  assert.match(run.stdout, /no-such-shell/);
});

/** Skip a case that cannot run here, by name; a shell the leg requires fails instead. */
function cannotRun(t, row, reason) {
  if (REQUIRED.includes(row.name)) assert.fail(`${row.name} is required on this leg, but ${reason}`);
  t.skip(reason);
}

// ── Product bugs this lane found ──────────────────────────────────────────
// Each case whose name `case` matches runs as a `todo`: reported, not failing.
// `unintegrated` marks a shell whose integration is not injected here: its
// boundary cases are todos that end at once, and its other cases wait on the
// prompt text instead. Delete the entry with the fix.
const BOUNDARY_CASES_RE = /^(?:the shipped integration reports a prompt|the reported command line|the reported cwd|prompt and command boundaries)/;
const KNOWN = [
  {
    shells: ['pwsh'], platforms: ['darwin', 'linux'], unintegrated: true, case: BOUNDARY_CASES_RE,
    why: 'pwsh as the login shell spawns as `pwsh -l`, and powerShellIntegratedArgs injects only into a bare or -NoExit launch, so the pane gets no integration',
  },
];

const knownFor = (row, test) => KNOWN.find((entry) => entry.shells.includes(row.name)
  && (!entry.platforms || entry.platforms.includes(PLATFORM)) && test(entry));
const todoFor = (row, caseName) => knownFor(row, (entry) => entry.case.test(caseName))?.why;
const knownUnintegrated = (row) => knownFor(row, (entry) => entry.unintegrated)?.why;

// ── Commands ──────────────────────────────────────────────────────────────
const NODE = process.execPath;
const ENV_DUMP = path.join(SCRATCH, 'env-dump.js');
fs.writeFileSync(ENV_DUMP, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.env));\n");
const CHILD = path.join(SCRATCH, 'child.js');
fs.writeFileSync(CHILD, "console.log('CHILD=' + process.pid); setInterval(() => {}, 1 << 30);\n");

/** A Windows path as Git Bash spells it: `C:\a b` is `/c/a b`. */
const msysPath = (winPath) => winPath.replace(/^([A-Za-z]):[\\/]?/, (_, drive) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/').replace(/(.)\/$/, '$1');
/** Running node on `args`, in the row's syntax. */
function nodeCommand(row, args) {
  const all = [NODE, ...args];
  if (row.family === 'cmd') return all.map((arg) => `"${arg}"`).join(' ');
  const quoted = all.map((arg) => `'${arg}'`).join(' ');
  return row.family === 'pwsh' ? `& ${quoted}` : quoted;
}
function cdCommand(row, dir) {
  if (row.family === 'pwsh') return `Set-Location -LiteralPath '${dir}'`;
  return `cd '${dir}'`;
}

// ── A pane ────────────────────────────────────────────────────────────────
let paneCount = 0;

/** A fresh home, its files written from `{ relative: contents }`. */
function freshHome(files = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, 'home-'));
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, relative)), { recursive: true });
    fs.writeFileSync(path.join(home, relative), contents);
  }
  return home;
}

/**
 * Spawn `row`'s shell as a pane through pty-core, feeding its output to the
 * owner's parse and answering the queries xterm.js would. Killed after the test.
 */
function openPane(t, row, located, { home = freshHome(), cwd = home } = {}) {
  const id = `surface:conformance-${++paneCount}`;
  const spawned = [];
  const ptyModule = { spawn: (...args) => { const p = nodePty.spawn(...args); spawned.push(p); return p; } };
  const waiters = new Set();
  const notify = () => { for (const check of [...waiters]) check(); };
  const pane = {
    id, home, raw: '', visible: '', semantic: [], state: createTerminalPaneState(),
    prompts: 0, exit: null, acks: [],
  };
  let promptOpen = false;
  let answeredTo = 0;
  const mgr = create((event, data) => {
    if (event === 'data' && data.id === id) {
      pane.raw += data.data;
      stream.write(data.data);
    } else if (event === 'exit' && data.id === id) {
      pane.exit = data;
    } else if (event === 'gracefulKillDone') {
      pane.acks.push({ at: Date.now(), ...data });
    }
    notify();
  }, ptyModule);
  const stream = createProcessedPtyStream({
    // The owner answers color queries from the theme.
    colorProvider: (target) => (target === 'background' ? '#000000' : '#ffffff'),
    localHost: os.hostname(),
    onEvents(events) {
      for (const event of collectTerminalSemanticEvents(events)) {
        pane.semantic.push(event);
        pane.state = reduceTerminalState(pane.state, event);
        // A prompt is ready at the B that closes an A (as shell-integration.test.js reads bash).
        if (event.type === 'promptStart') promptOpen = true;
        if (event.type === 'promptEnd' && promptOpen) { promptOpen = false; pane.prompts += 1; }
      }
      for (const reply of collectTerminalProtocolResponses(events)) mgr.write(id, reply);
    },
    onChunk({ data }) {
      // What xterm.js answers in the renderer: device attributes, which fish
      // waits up to 10 s for; cursor position, which .NET's console asks.
      pane.visible += data;
      const queries = /\x1b\[(?:0?c|6n|>0?q)/g;
      queries.lastIndex = answeredTo;
      for (let match; (match = queries.exec(pane.visible));) {
        answeredTo = queries.lastIndex;
        const reply = match[0].endsWith('c') ? '\x1b[?62;22c' : match[0].endsWith('n') ? '\x1b[1;1R' : '\x1bP>|xterm.js(6.1.0)\x1b\\';
        mgr.write(id, reply);
      }
      answeredTo = Math.max(answeredTo, pane.visible.length - 6);
    },
  });
  t.after(() => {
    try { mgr.killAll(); } catch { /* already gone */ }
    for (const p of spawned) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
  });

  /** Resolve with `predicate()` once truthy, checked on every event from the
   *  pane, and every `poll` ms for a condition outside it (a process's end). */
  pane.waitFor = (predicate, what, ms = 30_000, poll = 0) => new Promise((resolve, reject) => {
    const ticker = poll ? setInterval(() => check(), poll) : undefined;
    const done = () => { clearTimeout(timer); clearInterval(ticker); waiters.delete(check); };
    const check = () => {
      let value;
      try { value = predicate(); } catch (error) { done(); reject(error); return; }
      if (value) { done(); resolve(value); }
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`${row.name}: no ${what} within ${ms} ms; output tail ${JSON.stringify(pane.raw.slice(-800))}`));
    }, ms);
    waiters.add(check);
    check();
  });
  pane.text = () => pane.raw.replace(/\x1b\[[0-9;?>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>]/g, '');
  pane.pid = () => spawned.at(-1)?.pid;
  pane.write = (data) => mgr.write(id, data);
  /** Ready for input: the first prompt the shell reports, else its prompt text. */
  pane.ready = () => (row.integrated && !located.unreported
    ? pane.waitFor(() => pane.prompts >= 1, 'first prompt', 60_000)
    : pane.waitFor(() => row.prompt.test(pane.text()), 'prompt text', 60_000));
  /** Submit `line` (a `\r` inside it is a further Enter) and wait for the next prompt. */
  pane.run = async (line, what = JSON.stringify(line)) => {
    // A line that never came back leaves the shell mid-command: every later
    // case on this pane fails at once rather than waiting out its own timeout.
    if (pane.stuck) throw new Error(`${row.name}: the pane is still running ${pane.stuck}`);
    await pane.ready();
    const before = pane.prompts;
    const mark = pane.semantic.length;
    pane.write(`${line}\r`);
    pane.stuck = what;
    await pane.waitFor(() => pane.prompts > before, `prompt after ${what}`);
    pane.stuck = null;
    return pane.semantic.slice(mark);
  };
  /** Run node on the env dump, answering the pane's environment. */
  pane.env = async () => {
    const out = path.join(SCRATCH, `${id.replace(/\W/g, '-')}-env.json`);
    const line = nodeCommand(row, [ENV_DUMP, out]);
    await pane.ready();
    pane.write(`${line}\r`);
    return pane.waitFor(() => { try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch { return null; } }, 'env dump');
  };
  pane.gracefulKill = (timeout) => {
    const started = Date.now();
    const count = pane.acks.length;
    mgr.gracefulKill([id], timeout, `stop-${id}`);
    return pane.waitFor(() => pane.acks.length > count, 'graceful stop acknowledgement', timeout + 5_000)
      .then(() => pane.acks.at(-1).at - started);
  };
  pane.hasPty = () => mgr.hasPty(id);

  const spawnOptions = { cwd, shell: located.path, args: located.args, cols: 200, rows: 50 };
  // HOME is where POSIX shells, fish and pwsh look for the user's files; Git
  // Bash reads it too. Windows PowerShell and WSL do not (see the profile case).
  if (!WIN || row.msys) spawnOptions.env = { HOME: home };
  mgr.spawn(id, spawnOptions);
  return pane;
}

/** Each applicable row's case `name`, as one test: skipped by name where the
 *  shell is missing, a `todo` where KNOWN lists it, killed afterwards. A case
 *  that reads boundaries (`reads`) does not run where the shell reports none. */
function shellCase(name, applies, body, { timeout = 60_000, reads = false } = {}) {
  for (const row of SHELLS) {
    if (!applies(row)) continue;
    const todo = todoFor(row, name);
    test(`${row.name}: ${name}`, { timeout, ...(todo ? { todo } : {}) }, async (t) => {
      const located = (await LOCATED).get(row.name);
      if (!located) return cannotRun(t, row, `${row.name} is not installed`);
      if (reads && located.unreported) {
        if (todo) return undefined;
        return cannotRun(t, row, `${row.name} reports no boundaries: ${located.unreported}`);
      }
      return body(t, row, located);
    });
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const envValue = (env, key) => {
  const found = Object.keys(env).find((name) => (WIN ? name.toUpperCase() === key.toUpperCase() : name === key));
  return found === undefined ? undefined : env[found];
};

// ── 0. The integration is there to read ───────────────────────────────────
// Every boundary case below rests on this one; it runs even where KNOWN says
// the shell is not integrated, to show what the shell does instead.
shellCase('the shipped integration reports a prompt', (row) => row.integrated, async (t, row, located) => {
  if (located.unreported && !todoFor(row, 'the shipped integration reports a prompt')) {
    return cannotRun(t, row, `${row.name} reports no boundaries: ${located.unreported}`);
  }
  const pane = openPane(t, row, located);
  await pane.waitFor(() => pane.prompts >= 1 || row.prompt?.test(pane.text()), 'a prompt', 60_000);
  await pane.waitFor(() => pane.prompts >= 1, 'a reported prompt (OSC 633/133 A then B)', 5_000);
});

// ── 1. The user's dotfiles load ───────────────────────────────────────────
// Each file exports a marker; the pane's environment must hold every one.
const DOTFILES = {
  zsh: [{
    files: { '.zshenv': 'export DM_ZSHENV=1\n', '.zprofile': 'export DM_ZPROFILE=1\n', '.zshrc': 'export DM_ZSHRC=1\n', '.zlogin': 'export DM_ZLOGIN=1\n' },
    loaded: ['DM_ZSHENV', 'DM_ZPROFILE', 'DM_ZSHRC', 'DM_ZLOGIN'],
  }],
  // The integration replaces a login shell, which reads the first profile it
  // finds; .bashrc loads when the profile sources it, as it would without us.
  bash: [{
    files: { '.bash_profile': 'export DM_BASH_PROFILE=1\n. "$HOME/.bashrc"\n', '.bashrc': 'export DM_BASHRC=1\n', '.profile': 'export DM_PROFILE=1\n' },
    loaded: ['DM_BASH_PROFILE', 'DM_BASHRC'], notLoaded: ['DM_PROFILE'],
  }, {
    files: { '.profile': 'export DM_PROFILE=1\n' },
    loaded: ['DM_PROFILE'],
  }],
  fish: [{
    files: { '.config/fish/config.fish': 'set -gx DM_FISH_CONFIG 1\n', '.config/fish/conf.d/dormouse-conformance.fish': 'set -gx DM_FISH_CONFD 1\n' },
    loaded: ['DM_FISH_CONFIG', 'DM_FISH_CONFD'],
  }],
  'git-bash': [{
    files: { '.bash_profile': 'export DM_BASH_PROFILE=1\n. "$HOME/.bashrc"\n', '.bashrc': 'export DM_BASHRC=1\n' },
    loaded: ['DM_BASH_PROFILE', 'DM_BASHRC'],
  }],
};
// pwsh reads $HOME/.config/powershell on POSIX. The profile also replaces the
// prompt, which the integration must keep (it wraps the user's prompt).
const PWSH_PROFILE = "$env:DM_PWSH_PROFILE = '1'\nfunction prompt { 'DMPROMPT> ' }\n";
if (!WIN) DOTFILES.pwsh = [{ files: { '.config/powershell/Microsoft.PowerShell_profile.ps1': PWSH_PROFILE }, loaded: ['DM_PWSH_PROFILE'], prompt: 'DMPROMPT> ' }];

shellCase('the user\'s dotfiles load', (row) => DOTFILES[row.name], async (t, row, located) => {
  for (const [index, fixture] of DOTFILES[row.name].entries()) {
    const pane = openPane(t, row, located, { home: freshHome(fixture.files) });
    const env = await pane.env();
    for (const key of fixture.loaded) assert.equal(env[key], '1', `${row.name} fixture ${index}: ${key} did not load`);
    for (const key of fixture.notLoaded ?? []) assert.equal(env[key], undefined, `${row.name} fixture ${index}: ${key} loaded`);
    if (fixture.prompt) assert.ok(pane.text().includes(fixture.prompt), `${row.name}: the user's prompt is not shown`);
  }
});

// Windows PowerShell's $PROFILE is under the Documents known folder, which no
// environment variable moves, so this writes the real profile. Only where
// DORMOUSE_CONFORMANCE_WRITE_PROFILE=1 says the machine is disposable (CI); the
// original is put back.
shellCase('the user\'s PowerShell profile loads', (row) => WIN && row.family === 'pwsh', async (t, row, located) => {
  if (process.env.DORMOUSE_CONFORMANCE_WRITE_PROFILE !== '1') {
    return cannotRun(t, row, 'writing the real $PROFILE needs DORMOUSE_CONFORMANCE_WRITE_PROFILE=1');
  }
  const asked = spawnSync(located.path, ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserCurrentHost'], { encoding: 'utf8', timeout: 30_000 });
  const profile = asked.stdout.trim();
  assert.ok(profile, `${row.name}: no $PROFILE path (${asked.stderr})`);
  const original = fs.existsSync(profile) ? fs.readFileSync(profile) : null;
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, PWSH_PROFILE);
  t.after(() => (original ? fs.writeFileSync(profile, original) : fs.rmSync(profile, { force: true })));
  const pane = openPane(t, row, located);
  const env = await pane.env();
  assert.equal(envValue(env, 'DM_PWSH_PROFILE'), '1');
  assert.ok(pane.text().includes('DMPROMPT> '), `${row.name}: the user's prompt is not shown`);
});

// ── 2. The reported command line is the typed one ─────────────────────────
// `lines` is one command for every integrated shell, or one per shell name or
// family. A `\r` inside a line is a further Enter, which the report keeps as a
// line break. Compared with `isReportedCommandLine`, the equality Tools and
// `dor ensure` use, which allows for the parser's whitespace and length clamp.
const LONG = `'${'ab;c$d`e\\f |&>< '.repeat(160)}'`;
const HOSTILE = [
  ['single quotes', `echo 'it''s'`],
  ['double quotes with a double space', 'echo "a  b" "c"'],
  ['mixed quotes', `echo "it's" 'say "hi"'`],
  ['backslashes', String.raw`echo 'C:\Users\new\x41' "a\\b"`],
  ['dollar signs', `echo '$HOME $(id) \${x} $$'`],
  ['backticks', { posix: 'echo \'`id`\' "\\`x\\`"', fish: 'echo \'`id`\' "`x`"', pwsh: 'echo \'`id`\' "``x``"' }],
  ['semicolons', `echo a; echo 'b;c'`],
  ['ampersands', { all: `echo 'a & b' && echo c`, powershell: `echo 'a & b'; echo c` }],
  ['a pipe', { posix: 'echo a | tr a b', fish: 'echo a | tr a b', pwsh: 'echo a | ForEach-Object { $_ }' }],
  ['a newline inside quotes', `echo 'one\rtwo'`],
  ['unicode, with no-break and ideographic spaces', 'echo \'héllo wörld ✓ 日本語 🐭 a\u00a0b\u3000c\''],
  ['a leading dash', '-dormouse-no-such-command --flag'],
  ['a dash argument', `echo -- -n -e '-x'`],
  ['percent signs', `echo '%s %d %% %0A %E2%9C%93'`],
  ['a comment', 'echo hi # trailing comment'],
  ['a leading space', ' echo leading-space'],
  ['a very long line', `echo ${LONG}`],
  ['the shell\'s own metacharacters', {
    posix: 'echo {a,b} $((1+2)) "$(printf sub)" ~ >/dev/null',
    fish: 'echo (printf sub) {a,b} $status ~ >/dev/null',
    pwsh: 'echo $(1+2) @(1,2) "$(2*3)" $env:PATH > $null',
  }],
];
const hostileLine = (row, lines) => (typeof lines === 'string' ? lines : lines[row.name] ?? lines[row.family] ?? lines.all);

shellCase('the reported command line is the typed one', (row) => row.integrated, async (t, row, located) => {
  const pane = openPane(t, row, located);
  for (const [name, lines] of HOSTILE) {
    const line = hostileLine(row, lines);
    if (line === undefined) continue;
    const todo = todoFor(row, `command line: ${name}`);
    await t.test(name, todo ? { todo } : {}, async () => {
      const events = await pane.run(line, name);
      const typed = line.replace(/\r/g, '\n');
      const starts = events.filter((event) => event.type === 'commandStart');
      assert.equal(starts.length, 1, `${row.name}: ${starts.length} command starts for one line`);
      const reported = pane.state.lastCommand?.rawCommandLine;
      assert.ok(isReportedCommandLine(reported, typed), `${row.name}: typed ${JSON.stringify(typed)}, reported ${JSON.stringify(reported)}`);
    });
  }
}, { timeout: 120_000, reads: true });

// ── 3. The reported cwd is local and right ────────────────────────────────
shellCase('the reported cwd is local and right', (row) => row.integrated, async (t, row, located) => {
  const pane = openPane(t, row, located);
  const base = fs.mkdtempSync(path.join(SCRATCH, 'cwd-'));
  const targets = [];
  const dir = (name) => { const full = path.join(base, name); fs.mkdirSync(full); return full; };
  if (row.wsl) {
    // The distro's own directories; Windows cannot make them.
    const linux = `/tmp/dormouse-conformance-${process.pid}`;
    await pane.run(`mkdir -p '${linux}/dir with spaces' '${linux}/ünïcødé 目录 🐭'`);
    targets.push(['spaces', `${linux}/dir with spaces`], ['unicode', `${linux}/ünïcødé 目录 🐭`]);
  } else {
    targets.push(['spaces', dir('dir with spaces')], ['unicode', dir('ünïcødé 目录 🐭')]);
    if (!WIN) {
      fs.symlinkSync(path.join(base, 'dir with spaces'), path.join(base, 'a link'));
      targets.push(['a symlink', path.join(base, 'a link')]);
    } else {
      targets.push(['the drive root', path.parse(base).root]);
    }
  }
  for (const [name, target] of targets) {
    const todo = todoFor(row, `cwd: ${name}`);
    await t.test(name, todo ? { todo } : {}, async () => {
      const spelled = row.msys ? msysPath(target) : target;
      await pane.run(cdCommand(row, spelled));
      const cwd = pane.state.cwd;
      assert.ok(cwd, `${row.name}: no cwd reported`);
      assert.equal(cwd.path, spelled);
      assert.equal(cwd.isRemote, false, `${row.name}: ${JSON.stringify(cwd)} is remote`);
      assert.equal(cwd.host, undefined, `${row.name}: ${JSON.stringify(cwd)} names a host`);
    });
  }
}, { reads: true });

// ── 4. Prompt and command boundaries arrive in order ──────────────────────
const FAIL_7 = { posix: "sh -c 'exit 7'", fish: "sh -c 'exit 7'", pwsh: WIN ? 'cmd /c exit 7' : "sh -c 'exit 7'" };
const CMDLET_FAILS = "Get-Item -LiteralPath '/dormouse/no/such/path' -ErrorAction SilentlyContinue";
const BOUNDARY_CASES = [
  ['a command that succeeds', { all: 'echo ok' }, 0],
  ['a command that fails', { posix: 'false', fish: 'false', pwsh: CMDLET_FAILS }, 1],
  ['a command that exits 7', FAIL_7, 7],
  ['a cmdlet that fails after a native exit code', { pwsh: CMDLET_FAILS }, 1],
  ['an empty Enter', { all: '' }, null],
];

shellCase('prompt and command boundaries arrive in order', (row) => row.integrated, async (t, row, located) => {
  const pane = openPane(t, row, located);
  for (const [name, lines, exitCode] of BOUNDARY_CASES) {
    const line = hostileLine(row, lines);
    if (line === undefined) continue;
    const todo = todoFor(row, `boundaries: ${name}`);
    await t.test(name, todo ? { todo } : {}, async () => {
      const lastBefore = pane.state.lastCommand;
      const events = await pane.run(line, name);
      const kinds = events.map((event) => event.type);
      const at = (kind) => kinds.indexOf(kind);
      const count = (kind) => kinds.filter((each) => each === kind).length;
      assert.ok(kinds.includes('promptStart') && kinds.lastIndexOf('promptEnd') > kinds.lastIndexOf('promptStart'), `${row.name}: no prompt in ${kinds}`);
      if (exitCode === null) {
        assert.equal(count('commandStart'), 0, `${row.name}: an empty line started a command: ${kinds}`);
        assert.equal(pane.state.lastCommand?.id, lastBefore?.id, `${row.name}: an empty line recorded a command`);
        return;
      }
      assert.equal(count('commandStart'), 1, `${row.name}: ${kinds}`);
      assert.equal(count('commandFinish'), 1, `${row.name}: ${kinds}`);
      assert.ok(at('commandStart') < at('commandFinish') && at('commandFinish') < kinds.lastIndexOf('promptStart')
        && kinds.lastIndexOf('promptStart') < kinds.lastIndexOf('promptEnd'), `${row.name}: out of order: ${kinds}`);
      assert.equal(events[at('commandFinish')].exitCode, exitCode, `${row.name}: exit code`);
      assert.equal(pane.state.lastCommand?.exitCode, exitCode);
      assert.equal(pane.state.activity.kind, 'editing');
    });
  }
}, { reads: true });

// ── 5. A graceful stop ends the shell, and the child it runs ──────────────
// The bound both hosts pass (GRACEFUL_KILL_MS in standalone/src/quit.ts and
// window-close.ts; vscode-ext's gracefulKillLive default).
const GRACEFUL_KILL_MS = 2000;
const IDLE_STOP_COVERED = (row) => (!WIN && row.name === 'bash') || (WIN && row.name === 'cmd');

shellCase('a graceful stop ends the idle shell at once', (row) => !IDLE_STOP_COVERED(row), async (t, row, located) => {
  const pane = openPane(t, row, located);
  await pane.ready();
  const pid = pane.pid();
  const waited = await pane.gracefulKill(GRACEFUL_KILL_MS);
  assert.ok(pane.exit, `${row.name}: no exit reached the host`);
  assert.equal(pane.hasPty(), false);
  assert.ok(waited < GRACEFUL_KILL_MS, `${row.name}: acknowledged after ${waited} ms, at the deadline, not the hangup`);
  assert.equal(alive(pid), false, `${row.name}: pid ${pid} outlived its stop`);
});

shellCase('a graceful stop ends the shell and the program it runs', (row) => !row.wsl, async (t, row, located) => {
  const pane = openPane(t, row, located);
  await pane.ready();
  pane.write(`${nodeCommand(row, [CHILD])}\r`);
  const child = Number((await pane.waitFor(() => /CHILD=(\d+)/.exec(pane.text()), 'the child pid'))[1]);
  t.after(() => { try { process.kill(child, 'SIGKILL'); } catch { /* gone */ } });
  const pid = pane.pid();
  const waited = await pane.gracefulKill(GRACEFUL_KILL_MS);
  assert.ok(pane.exit, `${row.name}: no exit reached the host`);
  assert.ok(waited < GRACEFUL_KILL_MS, `${row.name}: acknowledged after ${waited} ms, at the deadline, not the hangup`);
  assert.equal(alive(pid), false, `${row.name}: the shell outlived its stop`);
  await pane.waitFor(() => !alive(child), `the child ${child} to end`, 3_000, 25);
});

// ── 6. The pane's environment is Dormouse's ───────────────────────────────
shellCase('the pane environment is clean', (row) => !row.wsl, async (t, row, located) => {
  const pane = openPane(t, row, located);
  const env = await pane.env();
  const get = (key) => envValue(env, key);
  assert.equal(get('TERM_PROGRAM'), 'iTerm.app');
  assert.match(get('TERM_PROGRAM_VERSION') ?? '', /^\d+\.\d+\.\d+$/);
  assert.equal(get('LC_TERMINAL'), 'iTerm2');
  assert.equal(get('LC_TERMINAL_VERSION'), get('TERM_PROGRAM_VERSION'));
  assert.equal(get('COLORTERM'), 'truecolor');
  assert.equal(get('DORMOUSE_SURFACE_ID'), pane.id);
  // Read by node, so in Windows form even from Git Bash, which converts on exec.
  const pathEntries = (get('PATH') ?? '').split(path.delimiter);
  assert.ok(pathEntries.includes(CLI_BIN), `${row.name}: ${CLI_BIN} is not on PATH ${get('PATH')}`);
  if (PLATFORM === 'darwin') assert.match(get('LANG') ?? '', /\.UTF-8$/i, `${row.name}: a Finder launch's pane has no UTF-8 locale`);
  else if (!WIN && HOST_LANG) assert.equal(get('LANG'), HOST_LANG);
  for (const key of MUST_NOT_LEAK) assert.equal(get(key), undefined, `${row.name}: the host's ${key} reached the pane`);
  if (WIN) assert.ok(!pathEntries.some((entry) => entry.toLowerCase() === GUI_NODE_DIR.toLowerCase()), `${row.name}: the GUI node directory is on PATH`);
  // A child zsh must not take the shipped directory as its own, or it writes
  // its history into the signed bundle (docs/specs/terminal-state.md).
  assert.notEqual(get('ZDOTDIR'), path.join(__dirname, 'shell-integration', 'zsh'));
});

// WSL forwards only what WSLENV names into the distro; the dor CLI's context
// is the contract there (WSL_CLI_ENV in pty-core.js).
shellCase('the pane environment reaches the WSL distro', (row) => row.wsl, async (t, row, located) => {
  const pane = openPane(t, row, located);
  const out = path.join(SCRATCH, 'wsl-env.txt');
  await pane.run(`env > '${msysPath(out).replace(/^\//, '/mnt/')}'`);
  const env = Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.equal(env.DORMOUSE_SURFACE_ID, pane.id);
  assert.equal(env.TERM_PROGRAM, 'iTerm.app');
  assert.equal(env.COLORTERM, 'truecolor');
  for (const key of MUST_NOT_LEAK) assert.equal(env[key], undefined, `wsl: the host's ${key} reached the distro`);
});
