const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');

function safeResolve(resolver) {
  try {
    const value = resolver();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function resolveDefaultShell(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return (
      env.ComSpec ||
      env.COMSPEC ||
      path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe')
    );
  }
  return env.SHELL || '/bin/sh';
}

const LOGIN_ARG_UNSUPPORTED_SHELLS = new Set(['csh', 'tcsh']);
// Mirrors ITERM2_COMPAT_VERSION in lib/src/lib/terminal-protocol.ts — pinned by
// lib/src/lib/mirrored-constants.test.ts (terminal-escapes.md: one
// compatibility version across env and device responses).
const ITERM2_COMPAT_VERSION = '3.5.0';

// bash flags that merely select an interactive and/or login shell. When the args
// are only these, OSC 633 injection can safely replace them: it spawns an
// interactive shell and the `--init-file` script sources the login profile
// itself, so it subsumes them — including the `--login -i` that Git Bash on
// Windows is launched with. Anything else (e.g. `-c <cmd>` or a script file)
// means the caller wants a specific invocation we must not clobber.
const BASH_INJECTABLE_ARGS = new Set(['-i', '-l', '--login']);

function bashArgsAreInjectable(shellArgs) {
  return (shellArgs || []).every((arg) => BASH_INJECTABLE_ARGS.has(arg));
}

// Build the PowerShell argument list that dot-sources our integration script,
// or return null to leave the launch untouched. Profiles still load (no
// -NoProfile). The path is single-quoted so spaces (e.g. "Program Files")
// survive; it's host-controlled and won't contain a single quote.
//
// We key on interactivity rather than "are there args": a launch that already
// runs a startup command (e.g. the VS "Developer PowerShell", which is
// `-NoExit -Command "& { Import-Module ... }"`) gets our dot-source appended to
// that command, so its environment is set up first and our prompt wrapper
// installs after it. A non-interactive one-off (a -Command/-File/-EncodedCommand
// without -NoExit) is returned as null so we don't alter it.
function powerShellIntegratedArgs(shellArgs, script) {
  const dotSource = `. '${script}'`;
  const args = [...(shellArgs || [])];

  // No args at all → a plain interactive REPL; add our own dot-source.
  if (args.length === 0) return ['-NoExit', '-Command', dotSource];

  const is = (arg, ...names) => names.includes(arg.toLowerCase());
  // Only augment interactive sessions; without -NoExit a command/file runs and
  // exits, so there's no prompt to wrap.
  if (!args.some((a) => is(a, '-noexit', '-noe'))) return null;
  // Command forms we can't safely concatenate onto — leave them alone.
  if (args.some((a) => is(a, '-encodedcommand', '-ec', '-e', '-file', '-f'))) return null;

  const cmdIdx = args.findIndex((a) => is(a, '-command', '-c'));
  if (cmdIdx !== -1 && cmdIdx + 1 < args.length) {
    args[cmdIdx + 1] = `${args[cmdIdx + 1]}; ${dotSource}`;
    return args;
  }
  // Interactive but no inline command (e.g. just `-NoExit`); add ours.
  return [...args, '-Command', dotSource];
}

function resolveLoginArg(shell, platform = process.platform) {
  if (platform === 'win32') {
    return [];
  }

  return LOGIN_ARG_UNSUPPORTED_SHELLS.has(shellStem(shell)) ? [] : ['-l'];
}

function resolveDefaultCwd(platform = process.platform, env = process.env, osModule = os) {
  const homedir = safeResolve(() => osModule.homedir());
  const tmpdir = safeResolve(() => osModule.tmpdir());

  if (platform === 'win32') {
    const homeFromDrive = env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined;
    return env.USERPROFILE || homeFromDrive || env.HOME || homedir || tmpdir || 'C:\\';
  }

  return env.HOME || homedir || tmpdir || '/tmp';
}

function directoryExists(cwd, fsModule = fs) {
  try {
    return fsModule.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

// Win32 only. The cwd we're handed can be in a non-native spelling: Git Bash
// inherits a POSIX path (`/c/Users/...`) that `statSync` can't resolve — so the
// directory check below fails and the shell silently falls back to the home dir —
// and VS Code's `workspaceFolder.fsPath` often carries a lowercase drive
// (`c:\...`). Whatever spelling we pass propagates verbatim into `process.cwd()`
// of the shell and of anything launched in it (e.g. Claude Code, which keys
// per-directory state case-sensitively, so `c:\` vs `C:\` fragments its history).
// Fold to one canonical Windows form: MSYS drive -> `X:\`, slashes unified,
// drive letter upper-cased. Non-drive paths (UNC, already-relative) pass through.
function canonicalizeWindowsCwd(cwd) {
  if (!cwd) return cwd;
  const withDrive = cwd.replace(/^\/([A-Za-z])\//, (_match, drive) => `${drive}:/`);
  if (!/^[A-Za-z]:[\\/]/.test(withDrive)) return cwd;
  const unified = withDrive.replace(/\//g, '\\');
  return unified.charAt(0).toUpperCase() + unified.slice(1);
}

function pathEnvKey(env) {
  return Object.prototype.hasOwnProperty.call(env, 'Path') ? 'Path' : 'PATH';
}

function withPrependedPath(env, dir, platform = process.platform) {
  if (!dir) return env;
  const key = platform === 'win32' ? pathEnvKey(env) : 'PATH';
  const delimiter = platform === 'win32' ? ';' : ':';
  const existing = env[key] || '';
  return {
    ...env,
    [key]: existing ? `${dir}${delimiter}${existing}` : dir,
  };
}

function withoutInternalDormouseEnv(env) {
  const next = { ...env };
  delete next.DORMOUSE_CLI_BIN;
  delete next.DORMOUSE_SHELL_INTEGRATION_DIR;
  return next;
}

// Win32 only. Git Bash / MSYS `/etc/profile` reconstructs PATH from an
// exported `ORIGINAL_PATH` whenever that variable is already set, and only
// captures the live PATH into it when it is unset. `ORIGINAL_PATH` leaks into
// our env whenever the host (VS Code, the standalone app) was itself launched
// from a Git Bash session — and that inherited value predates the
// DORMOUSE_CLI_BIN prepend below, so a login shell would silently rebuild PATH
// without `dor` on it. Dropping it makes the shell recapture the exact PATH we
// hand node-pty (dor-cli/bin included), the same as a first-login Git Bash.
// Harmless for cmd.exe / PowerShell, which never read ORIGINAL_PATH.
function withoutInheritedMsysOriginalPath(env, platform = process.platform) {
  if (platform !== 'win32' || !Object.prototype.hasOwnProperty.call(env, 'ORIGINAL_PATH')) {
    return env;
  }
  const next = { ...env };
  delete next.ORIGINAL_PATH;
  return next;
}

// Directory holding the per-shell OSC 633 integration scripts. Shipped next to
// this file (standalone bundles it via the tauri `../sidecar/**/*` resources
// glob); `DORMOUSE_SHELL_INTEGRATION_DIR` overrides it for hosts that stage the
// sidecar elsewhere (e.g. the VS Code bundle) and for tests.
function resolveShellIntegrationDir(env, runtime = {}) {
  return env.DORMOUSE_SHELL_INTEGRATION_DIR || path.join(runtime.dirname || __dirname, 'shell-integration');
}

// Basename of a shell path, lowercased and with any `.exe` dropped, handling
// both `/` and `\` separators so Windows paths (e.g. the absolute pwsh.exe path)
// resolve correctly — `path.posix.basename` would return a Windows path whole.
function shellStem(shell) {
  const base = String(shell || '').split(/[\\/]/).pop() || '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

// Translate a Windows path to its WSL mount path (`C:\a\b` -> `/mnt/c/a/b`) so a
// script on the Windows filesystem can be referenced from inside a distro. Strips
// the `\\?\` verbatim prefix. Assumes the default automount root (`/mnt`); a
// distro that remaps it via /etc/wsl.conf won't resolve, and injection is skipped.
function winPathToWslMount(winPath) {
  const stripped = String(winPath).replace(/^\\\\\?\\/, '');
  const match = /^([A-Za-z]):[\\/]([\s\S]*)$/.exec(stripped);
  if (!match) return null;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

// Enable OSC 633 shell integration for shells that support reliable injection,
// returning possibly-modified { env, shellArgs }. The keystroke-based command
// heuristic remains the fallback for shells we can't inject (cmd.exe, others)
// or when the scripts aren't present on disk. See docs/specs/terminal-escapes.md.
//
// zsh        — injected purely via env (`ZDOTDIR`), as reliable as a PATH prepend.
//        We point ZDOTDIR at our scripts and pass the user's real ZDOTDIR through
//        `USER_ZDOTDIR`; our dotfiles chain to the user's then install the hooks.
// bash       — injected via `--init-file`, which has no env equivalent. Because that
//        flag and login mode are mutually exclusive, we drop the login flag and
//        the script replicates login-profile sourcing itself. Injected whenever
//        the args are only interactive/login flags (so Git Bash, launched with
//        `--login -i`, is covered too); skipped for specific invocations like
//        `-c <cmd>`, since we'd be replacing them.
// PowerShell — injected by dot-sourcing our script via `-Command` (pwsh and
//        Windows PowerShell). We omit `-NoProfile` so the user's profile loads
//        first; the dot-sourced script then wraps their `prompt`. Augments an
//        interactive launch that already runs a startup command (so the VS
//        "Developer PowerShell" is covered); skips non-interactive one-offs.
// WSL  — `wsl.exe -d <distro>` launches the distro's login shell, where the
//        Windows-side injection can't reach. We append a `sh -c` detector that
//        execs bash with our `--init-file` (the bash script on the Windows FS,
//        referenced via its `/mnt/...` path) when the user's login shell is bash,
//        and otherwise execs their login shell unchanged — so non-bash users keep
//        their shell. bash is the only WSL shell we integrate for now.
function applyShellIntegration(shell, env, shellArgs, integrationDir, runtime = {}) {
  const fsModule = runtime.fsModule || fs;
  const stem = shellStem(shell);

  if (stem === 'zsh') {
    const zshDir = path.join(integrationDir, 'zsh');
    if (fileExists(path.join(zshDir, '.zshrc'), fsModule)) {
      return {
        env: { ...env, ZDOTDIR: zshDir, USER_ZDOTDIR: env.ZDOTDIR || env.HOME || '' },
        shellArgs,
      };
    }
  }

  if (stem === 'bash' && bashArgsAreInjectable(shellArgs)) {
    const script = path.join(integrationDir, 'bash', 'shellIntegration.bash');
    if (fileExists(script, fsModule)) {
      return { env, shellArgs: ['--init-file', script] };
    }
  }

  if (stem === 'pwsh' || stem === 'powershell') {
    const script = path.join(integrationDir, 'pwsh', 'shellIntegration.ps1');
    if (fileExists(script, fsModule)) {
      const integratedArgs = powerShellIntegratedArgs(shellArgs, script);
      if (integratedArgs) return { env, shellArgs: integratedArgs };
    }
  }

  // WSL: only the standard `-d <distro>` launch (the shape the picker emits).
  if (stem === 'wsl' && shellArgs.length === 2 && shellArgs[0] === '-d') {
    const script = path.join(integrationDir, 'bash', 'shellIntegration.bash');
    const mount = winPathToWslMount(script);
    if (mount && fileExists(script, fsModule)) {
      // A `sh -c` detector, passed as one argv element so node-pty hands it to
      // wsl.exe → sh verbatim (no shell-quoting games). It reads the login shell
      // from /etc/passwd (NSS-independent, unlike getent which flaked on cold
      // starts) and: steps aside for an explicit zsh/fish login shell; otherwise
      // execs bash with our init-file when bash exists (covering bash and an empty
      // detection — the safe default, since bash is near-universal on WSL); and
      // falls back to the login shell only when bash is absent (e.g. Alpine). The
      // init-file path is single-quoted for sh so spaces ("Program Files") survive.
      // One sh statement per line for readability; joined into a single -c string.
      const detector = [
        'u=$(whoami 2>/dev/null);',
        'login=$(grep "^$u:" /etc/passwd 2>/dev/null | cut -d: -f7);',
        'if command -v bash >/dev/null 2>&1; then',
        `case "$login" in *zsh|*fish) exec "$login" -l;; *) exec bash --init-file '${mount}' -i;; esac; fi;`,
        'exec "${login:-/bin/sh}" -l',
      ].join(' ');
      return { env, shellArgs: [...shellArgs, '--', 'sh', '-c', detector] };
    }
  }

  return { env, shellArgs };
}

function resolveSpawnConfig(options, runtime = {}) {
  const { cols = 80, rows = 30, cwd: requestedCwd, shell: explicitShell, args: explicitArgs, surfaceId } = options || {};
  const env = {
    ...(runtime.env || process.env),
    ...(options?.env || {}),
  };
  const platform = runtime.platform || process.platform;
  const osModule = runtime.osModule || os;
  const fsModule = runtime.fsModule || fs;
  // Normalize the requested cwd into a native spelling before it reaches the OS,
  // so the directory check resolves and the casing the shell (and its children)
  // perceives is stable. See canonicalizeWindowsCwd.
  const cwd = platform === 'win32' ? canonicalizeWindowsCwd(requestedCwd) : requestedCwd;
  const defaultCwd = resolveDefaultCwd(platform, env, osModule);
  const missingExplicitCwd = Boolean(cwd) && !directoryExists(cwd, fsModule);
  const shell = explicitShell || resolveDefaultShell(platform, env);
  // An empty array means "no override," not "no args" — fall through to the
  // login-flag default so `~/.zprofile` runs and PATH includes Homebrew/asdf.
  const shellArgs = explicitArgs && explicitArgs.length > 0
    ? explicitArgs
    : resolveLoginArg(shell, platform);

  // Resolve the integration dir from the original env before the internal
  // DORMOUSE_* vars are stripped below.
  const integrationDir = resolveShellIntegrationDir(env, runtime);
  const envWithCliPath = withoutInheritedMsysOriginalPath(
    withoutInternalDormouseEnv(withPrependedPath(env, env.DORMOUSE_CLI_BIN, platform)),
    platform,
  );
  const childEnv = {
    ...envWithCliPath,
    TERM_PROGRAM: 'iTerm.app',
    TERM_PROGRAM_VERSION: ITERM2_COMPAT_VERSION,
    LC_TERMINAL: 'iTerm2',
    LC_TERMINAL_VERSION: ITERM2_COMPAT_VERSION,
    // Advertise 24-bit color. xterm.js renders full truecolor, but the PTY is
    // spawned as `xterm-256color` with no other depth signal, so tools that gate
    // truecolor on env (e.g. supports-color) otherwise assume 256/ANSI-16 and
    // quantize RGB output. Windows Terminal is recognized as truecolor via
    // WT_SESSION; we aren't, so we advertise it explicitly. This is a color
    // *depth* signal only — light/dark *background* detection is separate (see
    // the OSC 10/11/12 color-query handling in terminal-protocol.ts).
    COLORTERM: 'truecolor',
    DORMOUSE_SURFACE_ID: surfaceId || options?.id || '',
  };
  const integrated = applyShellIntegration(shell, childEnv, shellArgs, integrationDir, runtime);

  return {
    cols,
    rows,
    cwd: missingExplicitCwd ? defaultCwd : (cwd || defaultCwd),
    cwdWarning: missingExplicitCwd ? `unable to restore because directory ${cwd} was removed` : null,
    env: integrated.env,
    shell,
    shellArgs: integrated.shellArgs,
  };
}

module.exports.resolveSpawnConfig = resolveSpawnConfig;
module.exports.withPrependedPath = withPrependedPath;
module.exports.canonicalizeWindowsCwd = canonicalizeWindowsCwd;

// ── Shell detection ────────────────────────────────────────────────────────

function fileExists(filePath, fsModule = fs) {
  try {
    return fsModule.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function detectWindowsShells(runtime = {}) {
  const env = runtime.env || process.env;
  const fsModule = runtime.fsModule || fs;
  const execFileSyncFn = runtime.execFileSync || execFileSync;
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  const shells = [];

  // Windows PowerShell (built-in)
  const winPowerShell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fileExists(winPowerShell, fsModule)) {
    shells.push({ name: 'Windows PowerShell', path: winPowerShell, args: [] });
  }

  // Command Prompt
  const cmdPath = env.ComSpec || env.COMSPEC || path.win32.join(systemRoot, 'System32', 'cmd.exe');
  if (fileExists(cmdPath, fsModule)) {
    shells.push({ name: 'Command Prompt', path: cmdPath, args: [] });
  }

  // PowerShell Core (pwsh) — scan Program Files
  const pwshDirs = [
    path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell'),
    path.win32.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'PowerShell'),
  ];
  for (const dir of pwshDirs) {
    try {
      const versions = fsModule.readdirSync(dir).sort().reverse();
      for (const ver of versions) {
        const pwshPath = path.win32.join(dir, ver, 'pwsh.exe');
        if (fileExists(pwshPath, fsModule)) {
          shells.push({ name: 'PowerShell', path: pwshPath, args: [] });
          break; // only add the newest version
        }
      }
      if (shells.some((s) => s.name === 'PowerShell')) break;
    } catch { /* dir doesn't exist */ }
  }

  // WSL distributions. Read from the registry rather than `wsl.exe -l -q`: that
  // call hangs on its piped stdio when the sidecar has no console (the normal
  // packaged/GUI launch), so it would hit its timeout and drop every distro. The
  // registry (`HKCU\...\Lxss\<guid>\DistributionName`) is the same source wsl.exe
  // reads, mirroring how Windows Terminal enumerates WSL.
  //
  // windowsHide (CREATE_NO_WINDOW) below is essential, not cosmetic: the sidecar
  // is itself spawned CREATE_NO_WINDOW, and a *synchronous* spawn of a console
  // child without that flag deadlocks on Windows console allocation — that is the
  // actual reason the old wsl.exe call timed out, and reg.exe times out the same
  // way without it.
  const wslExe = path.win32.join(systemRoot, 'System32', 'wsl.exe');
  if (fileExists(wslExe, fsModule)) {
    try {
      const regExe = path.win32.join(systemRoot, 'System32', 'reg.exe');
      const raw = execFileSyncFn(
        regExe,
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s', '/v', 'DistributionName'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, windowsHide: true },
      );
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*DistributionName\s+REG_SZ\s+(.+?)\s*$/);
        if (match) {
          shells.push({ name: match[1], path: wslExe, args: ['-d', match[1]] });
        }
      }
    } catch { /* no Lxss key (no distros installed) or reg.exe unavailable */ }
  }

  // Git Bash
  const gitBashPaths = [
    path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.win32.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
  ];
  for (const gbPath of gitBashPaths) {
    if (fileExists(gbPath, fsModule)) {
      shells.push({ name: 'Git Bash', path: gbPath, args: ['--login', '-i'] });
      break;
    }
  }

  // Visual Studio Developer shells
  const vsBasePaths = [
    env.ProgramFiles || 'C:\\Program Files',
    env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  ];
  for (const base of vsBasePaths) {
    const vsRoot = path.win32.join(base, 'Microsoft Visual Studio');
    let years;
    try { years = fsModule.readdirSync(vsRoot); } catch { continue; }
    for (const year of years.sort().reverse()) {
      let editions;
      try { editions = fsModule.readdirSync(path.win32.join(vsRoot, year)); } catch { continue; }
      for (const edition of editions) {
        const toolsDir = path.win32.join(vsRoot, year, edition, 'Common7', 'Tools');

        // Developer Command Prompt
        const vsDevCmd = path.win32.join(toolsDir, 'VsDevCmd.bat');
        if (fileExists(vsDevCmd, fsModule) && fileExists(cmdPath, fsModule)) {
          shells.push({
            name: `Developer Command Prompt for VS ${year}`,
            path: cmdPath,
            args: ['/k', vsDevCmd],
          });
        }

        // Developer PowerShell
        const launchScript = path.win32.join(toolsDir, 'Launch-VsDevShell.ps1');
        if (fileExists(launchScript, fsModule) && fileExists(winPowerShell, fsModule)) {
          shells.push({
            name: `Developer PowerShell for VS ${year}`,
            path: winPowerShell,
            args: ['-NoExit', '-Command', `& { Import-Module "${launchScript}" }`],
          });
        }
      }
    }
  }

  return shells;
}

// Well-known interactive shells we offer in the picker on macOS/Linux when they
// exist on disk, in addition to the user's $SHELL. Listed by preference; the
// first entry of each basename wins (so $SHELL, added first, keeps its slot).
const COMMON_UNIX_SHELLS = [
  '/bin/zsh',
  '/bin/bash',
  '/opt/homebrew/bin/bash', '/usr/local/bin/bash',
  '/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish',
  '/opt/homebrew/bin/zsh', '/usr/local/bin/zsh',
  '/bin/sh',
];

function detectUnixShells(runtime = {}) {
  const env = runtime.env || process.env;
  const fsModule = runtime.fsModule || fs;
  const seenByName = new Set();
  const shells = [];
  const add = (shellPath, trusted) => {
    if (!shellPath) return;
    const name = path.posix.basename(shellPath);
    // De-dupe by name so the picker shows one entry per shell, $SHELL winning.
    if (seenByName.has(name)) return;
    if (!trusted && !fileExists(shellPath, fsModule)) return;
    seenByName.add(name);
    shells.push({ name, path: shellPath, args: [] });
  };

  add(env.SHELL || '/bin/sh', true); // user's default, always first
  for (const candidate of COMMON_UNIX_SHELLS) add(candidate, false);
  return shells;
}

function detectAvailableShells(runtime = {}) {
  const platform = runtime.platform || process.platform;
  if (platform === 'win32') {
    return detectWindowsShells(runtime);
  }
  return detectUnixShells(runtime);
}

module.exports.detectAvailableShells = detectAvailableShells;

/** Every `pid -> cwd` in `lsof -Fn` field output. Records are `p<pid>` blocks;
 *  within one, the `n` line after `fcwd` is that process's cwd. */
function parseCwdsFromLsof(output) {
  const cwds = new Map();
  let pid = null;
  let sawCwdFd = false;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      const parsed = Number(line.slice(1));
      pid = Number.isInteger(parsed) ? parsed : null;
      sawCwdFd = false;
      continue;
    }

    if (pid === null) continue;

    if (line === 'fcwd') {
      sawCwdFd = true;
      continue;
    }

    if (sawCwdFd && line.startsWith('n')) {
      if (!cwds.has(pid)) cwds.set(pid, line.slice(1) || null);
      sawCwdFd = false;
    }
  }

  return cwds;
}

module.exports.parseCwdsFromLsof = parseCwdsFromLsof;

function parseCwdFromLsof(output, pid) {
  return parseCwdsFromLsof(output).get(Number(pid)) ?? null;
}

module.exports.parseCwdFromLsof = parseCwdFromLsof;

function getCwdForPid(pid, runtime = {}) {
  return getCwdsForPids([pid], runtime).get(pid) ?? null;
}

module.exports.getCwdForPid = getCwdForPid;

/**
 * `pid -> cwd` for every pid that could be resolved, in ONE pass.
 *
 * Batched at this layer because a save probes every terminal pane at once and
 * the macOS branch is a synchronous subprocess on the sidecar's only event loop:
 * one `lsof` for N pids instead of N spawns is the whole point
 * (docs/specs/transport.md -> "Persisted session"). Linux is a readlink per pid
 * with no subprocess to batch, and Windows resolves nothing either way.
 */
function getCwdsForPids(pids, runtime = {}) {
  const fsModule = runtime.fsModule || fs;
  const execFileSyncFn = runtime.execFileSync || execFileSync;
  const found = new Map();
  const unresolved = [];

  // Linux: /proc/<pid>/cwd symlink.
  for (const pid of pids) {
    try {
      found.set(pid, fsModule.readlinkSync(`/proc/${pid}/cwd`));
    } catch { unresolved.push(pid); /* not Linux or proc unavailable */ }
  }
  if (unresolved.length === 0) return found;

  // macOS: lsof. `-a` is required so `-p` and `-d cwd` are combined instead
  // of OR'ed, which otherwise returns unrelated processes and often `/`.
  let out = '';
  try {
    out = execFileSyncFn('lsof', ['-a', '-d', 'cwd', '-p', unresolved.join(','), '-Fn'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true, // see runPowerShell: avoid the console-allocation deadlock
    });
  } catch (err) {
    // `lsof` exits non-zero when ANY requested pid is gone, and still prints the
    // ones it did resolve. Throwing that stdout away is what turned one dead pid
    // into every pane losing its cwd for that save — and a quit teardown, which
    // kills and then flushes, is exactly when a pid goes missing mid-batch.
    out = typeof err?.stdout === 'string' ? err.stdout : (err?.stdout?.toString('utf-8') ?? '');
  }
  for (const [pid, cwd] of parseCwdsFromLsof(out)) {
    if (cwd) found.set(pid, cwd);
  }

  return found;
}

module.exports.getCwdsForPids = getCwdsForPids;

// ── Open-port discovery ──────────────────────────────────────────────────────
//
// `getOpenPortsForPid(rootPid)` answers "which TCP ports are listening, opened
// by this shell or any of its descendant processes?" It works in two steps that
// are each platform-specific but share the same shape:
//
//   1. getDescendantPids(rootPid) — walk the process tree to the full set of
//      PIDs rooted at the shell (the shell itself plus every transitive child).
//   2. getListeningPortsForPids(pids) — enumerate TCP sockets in the LISTEN
//      state owned by any PID in that set.
//
// No third-party dependencies: Linux reads /proc directly, macOS shells out to
// `ps` + `lsof` (already used for cwd), and Windows uses PowerShell cmdlets with
// a `netstat -ano` fallback. Only listening TCP sockets are reported — this is
// the "what server is this terminal running" signal, without the churn of
// ephemeral outbound connections.

// Mirrors `OPEN_PORT_TIMEOUT_MS` in `lib/src/lib/platform/types.ts` and
// `standalone/src-tauri/src/lib.rs` — pinned by
// `lib/src/lib/mirrored-constants.test.ts`. Used as the per-subprocess timeout
// cap inside the open-port pipeline.
const OPEN_PORT_TIMEOUT_MS = 3000;
module.exports.OPEN_PORT_TIMEOUT_MS = OPEN_PORT_TIMEOUT_MS;

// Mirrors `OPEN_PORT_TIMEOUT_PER_ID_MS` in `lib/src/lib/platform/types.ts` and
// `standalone/src-tauri/src/lib.rs` — pinned by
// `lib/src/lib/mirrored-constants.test.ts`. A batched scan's socket
// enumeration is capped at `openPortScanTimeoutMs(terminals)`, not the
// per-terminal cap, because its `lsof` argument grows with the batch.
const OPEN_PORT_TIMEOUT_PER_ID_MS = 100;
module.exports.OPEN_PORT_TIMEOUT_PER_ID_MS = OPEN_PORT_TIMEOUT_PER_ID_MS;

/** Socket-scan budget for one scan covering `count` terminals. The single-
 *  terminal path (`count` = 1) keeps `OPEN_PORT_TIMEOUT_MS` plus one allowance. */
function openPortScanTimeoutMs(count) {
  return OPEN_PORT_TIMEOUT_MS + OPEN_PORT_TIMEOUT_PER_ID_MS * count;
}
module.exports.openPortScanTimeoutMs = openPortScanTimeoutMs;

/**
 * Build the set of descendant PIDs (including rootPid) from a flat list of
 * [pid, ppid] pairs via breadth-first walk. Shared by every platform.
 */
function buildDescendantSet(pairs, rootPid) {
  const children = new Map();
  for (const [pid, ppid] of pairs) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const result = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of children.get(current) || []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

module.exports.buildDescendantSet = buildDescendantSet;

/**
 * Extract the parent PID from the contents of a Linux /proc/<pid>/stat file.
 * The comm field (2nd) is wrapped in parens and may itself contain spaces and
 * parens, so we anchor on the last ')': state follows it, then ppid.
 */
function parseProcStatPpid(content) {
  const rparen = content.lastIndexOf(')');
  if (rparen < 0) return null;
  const rest = content.slice(rparen + 1).trim().split(/\s+/);
  // rest[0] = state, rest[1] = ppid
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

module.exports.parseProcStatPpid = parseProcStatPpid;

/** Parse `ps -axo pid=,ppid=` output into [pid, ppid] pairs (macOS/Linux). */
function parsePsPairs(output) {
  const pairs = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) pairs.push([Number(match[1]), Number(match[2])]);
  }
  return pairs;
}

module.exports.parsePsPairs = parsePsPairs;

function getDescendantPids(rootPid, runtime = {}) {
  const pairs = readProcessTable(runtime);
  if (pairs && (!runtime.strict || pairs.some(([pid]) => pid === rootPid))) return [...buildDescendantSet(pairs, rootPid)];
  // Port discovery tolerates a failed scan; helper work inspection must not
  // mistake one for idle (docs/specs/terminal-context.md).
  if (runtime.strict) throw new Error('Unable to inspect terminal processes');
  return [rootPid];
}

/** Every `[pid, ppid]` pair on this platform, or null when the scan fails or the platform is unknown. */
function readProcessTable(runtime) {
  const platform = runtime.platform || process.platform;
  const fsModule = runtime.fsModule || fs;
  const execFileSyncFn = runtime.execFileSync || execFileSync;

  try {
    if (platform === 'linux') {
      const pairs = [];
      for (const entry of fsModule.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = fsModule.readFileSync(`/proc/${entry}/stat`, 'utf-8');
          const ppid = parseProcStatPpid(stat);
          if (ppid != null) pairs.push([Number(entry), ppid]);
        } catch { /* process vanished mid-scan */ }
      }
      return pairs;
    }

    // macOS (and any other POSIX): ps gives the whole pid/ppid table.
    if (platform === 'darwin') {
      const out = execFileSyncFn('ps', ['-axo', 'pid=,ppid='], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: OPEN_PORT_TIMEOUT_MS,
        windowsHide: true, // see runPowerShell: avoid the console-allocation deadlock
      });
      return parsePsPairs(out);
    }

    if (platform === 'win32') {
      const rows = runPowerShellJson(
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
        execFileSyncFn,
      );
      return rows
        .map((r) => [Number(r.ProcessId), Number(r.ParentProcessId)])
        .filter(([pid, ppid]) => Number.isInteger(pid) && Number.isInteger(ppid));
    }
  } catch {
    return null;
  }
  return null;
}

module.exports.getDescendantPids = getDescendantPids;

/** The global autorun command: one line, at most 4096 characters (docs/specs/terminal-context.md). */
function validCommand(value) {
  return typeof value === 'string' && value.length <= 4096 && !/[\r\n\0]/.test(value);
}

/** Format a Linux /proc/net hex IPv4 address (little-endian per byte). */
function parseHexIpv4(hex) {
  const octets = [];
  for (let i = 0; i < 8; i += 2) {
    octets.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return octets.reverse().join('.');
}

module.exports.parseHexIpv4 = parseHexIpv4;

/**
 * Format a Linux /proc/net hex IPv6 address. The kernel stores it as four
 * 32-bit words in host byte order, so each 4-byte word is byte-reversed before
 * the 16 bytes are grouped and zero-compressed into canonical form.
 */
function parseHexIpv6(hex) {
  const bytes = [];
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8);
    for (let b = 3; b >= 0; b--) bytes.push(word.slice(b * 2, b * 2 + 2));
  }
  const groups = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(parseInt(bytes[i], 16) * 256 + parseInt(bytes[i + 1], 16));
  }
  return compressIpv6(groups);
}

module.exports.parseHexIpv6 = parseHexIpv6;

/** Collapse the longest run of zero groups in an 8-group IPv6 address to "::". */
function compressIpv6(groups) {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === 0) {
      if (runStart < 0) runStart = i;
      runLen++;
      if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

/**
 * Parse a /proc/net/tcp or /proc/net/tcp6 table into listening-socket records,
 * keeping only rows whose socket inode is owned by one of `inodeToPid`.
 * State `0A` is TCP_LISTEN.
 */
function parseProcNetTcp(content, family, inodeToPid) {
  const ports = [];
  const lines = content.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const tokens = lines[i].trim().split(/\s+/);
    if (tokens.length < 10) continue;
    if (tokens[3] !== '0A') continue; // TCP_LISTEN
    const inode = tokens[9];
    const pid = inodeToPid.get(inode);
    if (pid === undefined) continue;
    const [hexIp, hexPort] = tokens[1].split(':');
    if (!hexPort) continue;
    ports.push({
      protocol: 'tcp',
      family,
      address: family === 'IPv6' ? parseHexIpv6(hexIp) : parseHexIpv4(hexIp),
      port: parseInt(hexPort, 16),
      pid,
    });
  }
  return ports;
}

module.exports.parseProcNetTcp = parseProcNetTcp;

function linuxListeningPorts(pids, runtime = {}) {
  const fsModule = runtime.fsModule || fs;
  const pidSet = new Set(pids);

  // Map socket inode -> owning pid by reading each pid's open fds.
  const inodeToPid = new Map();
  for (const pid of pidSet) {
    let fds;
    try { fds = fsModule.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        const link = fsModule.readlinkSync(`/proc/${pid}/fd/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(link);
        if (match) inodeToPid.set(match[1], pid);
      } catch { /* fd closed mid-scan */ }
    }
  }

  const ports = [];
  for (const [file, family] of [['/proc/net/tcp', 'IPv4'], ['/proc/net/tcp6', 'IPv6']]) {
    try {
      ports.push(...parseProcNetTcp(fsModule.readFileSync(file, 'utf-8'), family, inodeToPid));
    } catch { /* file absent (e.g. IPv6 disabled) */ }
  }

  // Attach process names from /proc/<pid>/comm, reading each pid at most once.
  const nameByPid = new Map();
  for (const entry of ports) {
    if (!nameByPid.has(entry.pid)) {
      let name;
      try { name = fsModule.readFileSync(`/proc/${entry.pid}/comm`, 'utf-8').trim(); } catch { /* gone */ }
      nameByPid.set(entry.pid, name);
    }
    entry.processName = nameByPid.get(entry.pid);
  }
  return ports;
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN ... -Fpcnt` field output (macOS). Records
 * are keyed by single-char field types: p=pid, c=command, t=type (IPv4/IPv6),
 * n=name (addr:port). A listening name looks like `*:3000`, `127.0.0.1:3000`,
 * or `[::1]:8080`.
 */
function parseLsofListening(output) {
  const ports = [];
  let pid;
  let command;
  let family = 'IPv4';
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') { pid = Number(value); continue; }
    if (tag === 'c') { command = value; continue; }
    if (tag === 't') { if (value === 'IPv4' || value === 'IPv6') family = value; continue; }
    if (tag === 'n') {
      const parsed = parseHostPort(value, family);
      if (parsed) {
        ports.push({ protocol: 'tcp', family, address: parsed.address, port: parsed.port, pid, processName: command });
      }
    }
  }
  return ports;
}

module.exports.parseLsofListening = parseLsofListening;

/** Split an "address:port" token, handling `*`, IPv4, and bracketed IPv6. */
function parseHostPort(token, wildcardFamily = 'IPv4') {
  let address;
  let portStr;
  if (token.startsWith('[')) {
    const end = token.indexOf(']');
    if (end < 0) return null;
    address = token.slice(1, end);
    portStr = token.slice(end + 2); // skip "]:"
  } else {
    const colon = token.lastIndexOf(':');
    if (colon < 0) return null;
    address = token.slice(0, colon);
    portStr = token.slice(colon + 1);
  }
  if (address === '*') address = wildcardFamily === 'IPv6' ? '::' : '0.0.0.0';
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { address, port };
}

function macListeningPorts(pids, runtime = {}) {
  const execFileSyncFn = runtime.execFileSync || execFileSync;
  if (pids.length === 0) return [];
  let out = '';
  try {
    out = execFileSyncFn(
      'lsof',
      ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(','), '-Fpcnt'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: runtime.scanTimeoutMs ?? OPEN_PORT_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch (err) {
    // lsof exits non-zero when ANY requested pid is gone (or has no matching
    // files) and still prints the ones it did resolve — the same trap
    // `getCwdsForPids` documents. A batched scan covers every descendant of
    // every terminal, so a child exiting between `ps` and `lsof` would
    // otherwise empty the whole Window's listing.
    out = typeof err?.stdout === 'string' ? err.stdout : (err?.stdout?.toString('utf-8') ?? '');
  }
  return parseLsofListening(out);
}

/** ConvertTo-Json emits a bare object (not an array) for a single row. */
function normalizeJsonArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed == null) return [];
  return [parsed];
}

/**
 * Parse `Get-NetTCPConnection -State Listen | Select LocalAddress,LocalPort,
 * OwningProcess` JSON, keeping rows owned by a pid in `pidSet`.
 */
function parseNetTcpConnections(json, pidSet, nameByPid = new Map()) {
  const rows = normalizeJsonArray(JSON.parse(json));
  const ports = [];
  for (const row of rows) {
    const pid = Number(row.OwningProcess);
    if (!pidSet.has(pid)) continue;
    const port = Number(row.LocalPort);
    if (!Number.isInteger(port)) continue;
    const address = String(row.LocalAddress);
    ports.push({
      protocol: 'tcp',
      family: address.includes(':') ? 'IPv6' : 'IPv4',
      address,
      port,
      pid,
      processName: nameByPid.get(pid),
    });
  }
  return ports;
}

module.exports.parseNetTcpConnections = parseNetTcpConnections;

/** Parse `netstat -ano` LISTENING TCP rows (Windows fallback for older hosts). */
function parseNetstatListening(output, pidSet, nameByPid = new Map()) {
  const ports = [];
  for (const line of output.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 5) continue;
    if (!/^TCP$/i.test(tokens[0])) continue;
    if (!/^LISTENING$/i.test(tokens[3])) continue;
    const pid = Number(tokens[4]);
    if (!pidSet.has(pid)) continue;
    const parsed = parseHostPort(tokens[1]);
    if (!parsed) continue;
    ports.push({
      protocol: 'tcp',
      family: parsed.address.includes(':') ? 'IPv6' : 'IPv4',
      address: parsed.address,
      port: parsed.port,
      pid,
      processName: nameByPid.get(pid),
    });
  }
  return ports;
}

module.exports.parseNetstatListening = parseNetstatListening;

function runPowerShell(script, execFileSyncFn) {
  return execFileSyncFn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    // windowsHide: a synchronous spawn of a console child from the CREATE_NO_WINDOW
    // sidecar deadlocks on console allocation without it (see the WSL note above).
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: OPEN_PORT_TIMEOUT_MS, windowsHide: true },
  );
}

/** Run a `... | ConvertTo-Json` script and return its rows as an array. */
function runPowerShellJson(script, execFileSyncFn) {
  return normalizeJsonArray(JSON.parse(runPowerShell(script, execFileSyncFn)));
}

function windowsListeningPorts(pids, runtime = {}) {
  const execFileSyncFn = runtime.execFileSync || execFileSync;
  const pidSet = new Set(pids);

  // Resolve pid -> process name once (best-effort; ports still returned without).
  const nameByPid = new Map();
  try {
    const rows = runPowerShellJson(
      'Get-CimInstance Win32_Process | Select-Object ProcessId,Name | ConvertTo-Json -Compress',
      execFileSyncFn,
    );
    for (const row of rows) {
      nameByPid.set(Number(row.ProcessId), String(row.Name));
    }
  } catch { /* names are optional */ }

  // Preferred: Get-NetTCPConnection (Windows 8+/Server 2012+).
  try {
    const json = runPowerShell(
      'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress',
      execFileSyncFn,
    );
    return parseNetTcpConnections(json, pidSet, nameByPid);
  } catch { /* fall through to netstat */ }

  // Fallback: netstat -ano.
  try {
    const out = execFileSyncFn('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: OPEN_PORT_TIMEOUT_MS,
      windowsHide: true, // see runPowerShell: avoid the console-allocation deadlock
    });
    return parseNetstatListening(out, pidSet, nameByPid);
  } catch {
    return [];
  }
}

function getListeningPortsForPids(pids, runtime = {}) {
  const platform = runtime.platform || process.platform;
  if (platform === 'linux') return linuxListeningPorts(pids, runtime);
  if (platform === 'darwin') return macListeningPorts(pids, runtime);
  if (platform === 'win32') return windowsListeningPorts(pids, runtime);
  return [];
}

module.exports.getListeningPortsForPids = getListeningPortsForPids;

/**
 * Listening TCP ports opened by `rootPid` or any of its descendant processes,
 * de-duplicated by (family, address, port) and sorted by port. Returns [] on
 * any platform-specific failure rather than throwing.
 */
function getOpenPortsForPid(rootPid, runtime = {}) {
  return getOpenPortsForPids([rootPid], runtime).get(rootPid) ?? [];
}

module.exports.getOpenPortsForPid = getOpenPortsForPid;

/** De-duplicated by (family, address, port) and sorted by port — the shape a
 *  caller reads a Surface's ports in. */
function dedupeListeningPorts(ports) {
  const seen = new Map();
  for (const entry of ports) {
    const key = `${entry.family}|${entry.address}|${entry.port}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()].sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
}

/**
 * `rootPid -> listening ports` for a whole set of terminals, in ONE process-table
 * read and ONE socket scan.
 *
 * Batched at this layer for the same reason `getCwdsForPids` is: `dor list --all
 * --ports` asks about every terminal of every Workspace at once, and each step is
 * a synchronous subprocess on the sidecar's only event loop — two spawns for N
 * terminals instead of 2N. Returns [] per pid on any platform failure rather than
 * throwing.
 */
function getOpenPortsForPids(rootPids, runtime = {}) {
  const byRoot = new Map();
  const roots = [...new Set(rootPids.filter((pid) => Number.isInteger(pid)))];
  if (roots.length === 0) return byRoot;

  const pairs = readProcessTable(runtime);
  // A failed scan is tolerated here (unlike helper-work inspection): each root
  // then owns only itself, exactly as `getDescendantPids` falls back.
  const owned = new Map(roots.map((root) => [root, pairs ? buildDescendantSet(pairs, root) : new Set([root])]));
  const union = new Set();
  for (const pids of owned.values()) for (const pid of pids) union.add(pid);

  // The socket scan's budget scales with the batch; the process-table read
  // above does not, its cost being the whole table either way.
  const ports = getListeningPortsForPids([...union], { ...runtime, scanTimeoutMs: openPortScanTimeoutMs(roots.length) });
  for (const [root, pids] of owned) {
    byRoot.set(root, dedupeListeningPorts(ports.filter((entry) => pids.has(entry.pid))));
  }
  return byRoot;
}

module.exports.getOpenPortsForPids = getOpenPortsForPids;

/** Directory validation belongs to context(); this only launches the native UI. */
function openNativeDirectory(nativePath, done, runtime = {}) {
  const platform = runtime.platform || process.platform;
  if (platform === 'win32') {
    // Explorer is a shell UI: acknowledge process launch, not its lifetime or
    // exit status. Keep OS-level launch errors visible to the caller.
    const child = (runtime.spawn || spawn)('explorer.exe', [nativePath], { windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const finish = error => { if (!settled) { settled = true; done(error); } };
    child.once('error', finish);
    child.once('spawn', () => { child.unref(); finish(null); });
  } else {
    (runtime.execFile || execFile)(platform === 'darwin' ? 'open' : 'xdg-open', [nativePath], { windowsHide: true }, done);
  }
}
module.exports.openNativeDirectory = openNativeDirectory;

/**
 * Shared PTY manager — the single place where node-pty processes are managed.
 *
 * Usage: const mgr = require('./pty-core').create(send, nodePty)
 *   where send(event, data) is a transport callback.
 *
 * Events emitted via send():
 *   send('data',  { id, data })
 *   send('exit',  { id, exitCode, signal })
 *   send('error', { id, message })
 *   send('list',  { ptys: [{ id, alive, shell }] })
 *   send('openPorts', { id, ports: [{ protocol, family, address, port, pid, processName }], requestId })
 */

// `sliceSince` is injected rather than imported: its implementation is shared
// with the VS Code extension host and lives in `lib/src/host/replay-buffer.ts`,
// which reaches this process only as the generated `recovery.cjs` bundle. Taking
// it as an option keeps this file — and its `node --test` suite — free of any
// build artifact. `main.js` supplies the real one.
module.exports.create = function create(send, ptyModule, { replay = false, sliceSince = null } = {}) {
  if (!ptyModule || typeof ptyModule.spawn !== 'function') {
    throw new TypeError('create() requires a node-pty compatible module');
  }

  const pty = ptyModule;
  const ptys = new Map(); // id -> pty.IPty
  const helpers = new Map(); // id -> { parentId, command } for helper PTYs
  // Every spawned, unkilled PTY (exited ones included). Only the standalone host
  // asks for `replay`; VS Code's extension host keeps its own buffers.
  // `chars` is what the buffer currently holds (a trim decrements it);
  // `received` is everything ever received and is never decremented, so it is the
  // only stable coordinate for marking a position in a pane's output
  // (docs/specs/transport.md -> "Persisted session").
  const sessions = new Map(); // id -> { chunks: string[], chars: number, received: number }
  const REPLAY_CHARS = 200000;
  const ptyShells = new Map(); // id -> resolved shell executable
  // Repaint restoration belongs to the PTY owner, where every local and remote
  // resize passes. A Viewer-local timer cannot see another display taking size
  // authority (docs/specs/remote-api.md -> Attach is the resize).
  const repaintTimers = new Map();
  const FORCE_REPAINT_BOUNCE_MS = 60;

  function cancelRepaint(id) {
    clearTimeout(repaintTimers.get(id));
    repaintTimers.delete(id);
  }

  function validHelperOwner(id, helper) {
    return typeof helper.parentId === 'string' && validCommand(helper.command)
      && helper.parentId !== id && sessions.has(helper.parentId) && !helpers.has(helper.parentId)
      && ![...helpers].some(([otherId, other]) => otherId !== id && other.parentId === helper.parentId);
  }

  function spawn(id, options) {
    const config = resolveSpawnConfig({ ...options, id, surfaceId: id });
    if (options?.helper && validHelperOwner(id, options.helper)) {
      helpers.set(id, { parentId: options.helper.parentId, command: options.helper.command });
    } else if (options?.helper) {
      send("exit", { id, exitCode: 1 });
      return;
    } else helpers.delete(id);

    let p;
    try {
      p = pty.spawn(config.shell, config.shellArgs, {
        name: 'xterm-256color',
        cols: config.cols,
        rows: config.rows,
        cwd: config.cwd,
        env: config.env,
        // Use node-pty's bundled OpenConsole (conpty.dll) on Windows instead of
        // the in-box CreatePseudoConsole. The in-box conhost *swallows* programs'
        // OSC 10/11/12 color queries (they never reach us, so we can't answer and
        // TUIs assume a dark background); the bundled OpenConsole forwards them to
        // the consumer, letting our protocol parser reply from the active theme —
        // the same passthrough Windows Terminal relies on. Verified end-to-end on
        // Windows. Ignored by node-pty on non-Windows platforms.
        useConptyDll: process.platform === 'win32',
      });
    } catch (err) {
      console.error(`[pty-core] spawn failed for ${id}:`, err.message);
      send('error', { id, message: err.message });
      // A PTY that never spawned is a dead PTY, and `error` is a host-side log
      // line that reaches no webview. Follow it with the `exit` every consumer
      // already knows how to handle: without one the pane keeps whatever command
      // was seeded for it as permanently running — a phantom running header, a
      // `countRunningSessions` that never returns to zero, and a quit
      // confirmation on every attempt to close. Reachable whenever a persisted
      // or selected shell binary is gone.
      send('exit', { id, exitCode: 1, signal: undefined });
      return;
    }

    cancelRepaint(id);
    ptys.set(id, p);
    const session = { chunks: [], chars: 0, received: 0 };
    sessions.set(id, session);
    ptyShells.set(id, config.shell);

    p.onData((data) => {
      // Appended BEFORE the send, and synchronously. Two consumers depend on
      // that order: the replay a reconnecting webview reads, and a Workspace
      // transfer, whose host suppresses this id's output the instant it
      // reassigns ownership and then asks for `list([id])` — so the chunk it
      // suppressed has to already be in the buffer the replay is built from,
      // exactly once (docs/specs/transport.md -> "Transferring a Workspace").
      if (replay && ptys.get(id) === p) {
        session.chunks.push(data);
        session.chars += data.length;
        session.received += data.length;
        // Drop whole chunks off the front, then trim the head: O(chunk) per write.
        while (session.chunks.length > 1 && session.chars - session.chunks[0].length >= REPLAY_CHARS) session.chars -= session.chunks.shift().length;
        if (session.chars > REPLAY_CHARS) { session.chunks[0] = session.chunks[0].slice(session.chars - REPLAY_CHARS); session.chars = REPLAY_CHARS; }
      }
      send('data', { id, data });
    });

    p.onExit(({ exitCode, signal }) => {
      send('exit', { id, exitCode, signal });
      if (ptys.get(id) === p) {
        cancelRepaint(id);
        ptys.delete(id);
        ptyShells.delete(id);
      }
    });

    if (config.cwdWarning) {
      send('data', { id, data: `\r\n${config.cwdWarning}\r\n` });
    }

    console.error(`[pty-core] spawned: ${id} (${config.shell}, ${config.cols}x${config.rows})`);
  }

  function write(id, data) {
    const p = ptys.get(id);
    if (p) p.write(data);
  }

  function resize(id, cols, rows, repaint = false) {
    cancelRepaint(id);
    const p = ptys.get(id);
    if (!p) return;
    if (!repaint) {
      p.resize(cols, rows);
      return;
    }
    p.resize(cols, rows > 1 ? rows - 1 : rows + 1);
    const timer = setTimeout(() => {
      if (repaintTimers.get(id) !== timer) return;
      repaintTimers.delete(id);
      if (ptys.get(id) !== p) return;
      try {
        p.resize(cols, rows);
      } catch (error) {
        // Process death can race its onExit callback; never crash the owner.
        console.error(`[pty-core] repaint failed for ${id}:`, error.message);
      }
    }, FORCE_REPAINT_BOUNCE_MS);
    timer.unref?.();
    repaintTimers.set(id, timer);
  }

  /** Ids that can still take input. An exited PTY leaves `ptys` in its `onExit`,
   *  so this is exactly the live set the recovery capture must interrupt. */
  function liveIds() {
    return [...ptys.keys()];
  }

  /** A mark in the pane's output stream, cheap enough to take on every poll tick:
   *  `received` is maintained exactly by the data handler, so a caller watching a
   *  pane for growth pays nothing instead of a full `join()`. */
  function receivedChars(id) {
    const session = sessions.get(id);
    return session ? session.received : 0;
  }

  /** The output received after a `receivedChars` mark. This is the buffer lookup;
   *  the clamping arithmetic is the injected `sliceSince` (see `create`). Without
   *  one there is no recovery capture in this process either, so nothing to read. */
  function outputSince(id, mark) {
    const session = sessions.get(id);
    if (!session || !sliceSince) return '';
    return sliceSince(session.chunks, session.chars, session.received, mark);
  }

  // Synchronous lifetime observation for the Burrow's atomic
  // subscribe-then-check. Natural exits delete the generation from `ptys`, and
  // a spawn under the same id installs the new generation before it can emit.
  function hasPty(id) {
    return ptys.has(id);
  }

  function kill(id) {
    helpers.delete(id);
    sessions.delete(id);
    cancelRepaint(id);
    const p = ptys.get(id);
    if (p) {
      p.kill();
      ptys.delete(id);
      ptyShells.delete(id);
    }
  }

  function killAll() {
    for (const id of repaintTimers.keys()) cancelRepaint(id);
    for (const [, p] of ptys) {
      p.kill();
    }
    ptys.clear();
    ptyShells.clear();
    helpers.clear();
    sessions.clear();
  }

  /**
   * List (and, where this host buffers, replay) live PTYs.
   *
   * `ids` omitted is every live PTY; an empty array is an empty list — the same
   * "omitted is not empty" rule `interrupt` carries, and for the same reason: a
   * caller forwarding a computed set that came out empty must get a no-op
   * rather than everything. `forWindow` is echoed on the list and on each
   * replay so the host can route both back to the window that asked
   * (docs/specs/standalone.md -> "Windows"), and `requestId` so the asking
   * collector can tell its own answer from a concurrent one's
   * (docs/specs/transport.md -> "Reconnection").
   */
  function list(ids, forWindow, requestId, marks) {
    const targets = Array.isArray(ids) ? ids.filter((id) => ptys.has(id)) : [...ptys.keys()];
    const result = targets.map((id) => ({
      id, alive: true, shell: ptyShells.get(id), ...(helpers.has(id) ? { helper: helpers.get(id) } : {}),
    }));
    const addressed = {
      ...(forWindow ? { forWindow } : {}),
      ...(requestId === undefined || requestId === null ? {} : { requestId }),
    };
    send('list', { ptys: result, ...addressed });
    if (!replay) return;
    for (const { id } of result) {
      // A marked id replays only what came after its mark: the window that
      // asked already holds everything before it, serialized by the window
      // that handed the PTY over (docs/specs/transport.md -> "Transferring a
      // Workspace"). Without a shared `sliceSince` there is no mark arithmetic,
      // and the whole buffer is the safe answer.
      const mark = marks && typeof marks[id] === 'number' ? marks[id] : null;
      const data = mark !== null && sliceSince ? outputSince(id, mark) : sessions.get(id).chunks.join('');
      send('replay', { id, data, ...addressed });
    }
  }

  /** Stamp each PTY's output position, **in the stream**: the `marked` line is
   *  written behind every `data` line already sent for the id and ahead of every
   *  one after it, so a reader that consumes in order holds exactly the bytes
   *  before the mark when it sees it. Unknown ids answer 0, so a caller waiting
   *  on a set never hangs on a PTY that exited meanwhile. */
  function mark(ids, requestId) {
    const addressed = requestId === undefined || requestId === null ? {} : { requestId };
    for (const id of Array.isArray(ids) ? ids : []) {
      send('marked', { id, mark: receivedChars(id), ...addressed });
    }
  }

  // Only explicit settings edits write this installation-global preference. No
  // terminal transcripts or session layout are persisted here.
  const settingsPath = path.join(os.homedir(), '.dormouse', 'helper-terminal.json');
  function savedCommand() {
    try {
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (validCommand(saved.command)) return saved.command;
    } catch { /* Factory default until explicitly saved. */ }
    return 'git status';
  }
  const shellBasename = (value) => path.basename(value).replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase();
  function context(request, requestId) {
    const result = { requestId };
    try {
      const p = ptys.get(request.id);
      if (request.op === 'settings') {
        if (request.command !== undefined) {
          if (!validCommand(request.command)) throw new Error('Use a single command line (up to 4096 characters)');
          fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
          const temporary = settingsPath + '.' + process.pid + '.tmp';
          fs.writeFileSync(temporary, JSON.stringify({ command: request.command }), { mode: 0o600 });
          fs.renameSync(temporary, settingsPath);
        }
        result.home = os.homedir();
        result.command = request.command !== undefined ? request.command : savedCommand();
      } else if (request.op === 'info') {
        // Left null when inspection throws: unknown work is never idle.
        result.busy = null;
        result.busy = !p ? false
          : getDescendantPids(p.pid, { strict: true }).some(pid => pid !== p.pid)
            || (!!p.process && shellBasename(p.process) !== shellBasename(ptyShells.get(request.id)));
      } else if (request.op === 'promote') {
        if (request.restore) {
          if (!sessions.has(request.id) || !validHelperOwner(request.id, request.restore)) throw new Error('Invalid helper owner');
          helpers.set(request.id, { parentId: request.restore.parentId, command: request.restore.command });
        } else helpers.delete(request.id);
      } else if (request.op === 'openDirectory') {
        if (typeof request.path !== 'string' || !path.isAbsolute(request.path) || request.path.includes('\0') || !directoryExists(request.path)) throw new Error('Directory is unavailable');
        const nativePath = fs.realpathSync(request.path);
        // Absolute canonical path is one argument; no shell interprets OSC text.
        openNativeDirectory(nativePath, (error) => {
          send('context', { ...result, ...(error ? { error: error.message } : {}) });
        });
        return;
      } else throw new Error('Unknown terminal context operation');
    } catch (error) { result.error = error.message; }
    send('context', result);
  }

  function getCwd(id, requestId) {
    const p = ptys.get(id);
    if (!p) { send('cwd', { id, cwd: null, requestId }); return; }
    send('cwd', { id, cwd: getCwdForPid(p.pid), requestId });
  }

  /** One answer for every id a save asks about, so N panes cost one process
   *  scan rather than N (docs/specs/transport.md -> "Persisted session"). An id
   *  with no live PTY answers null, exactly as `getCwd` does. */
  function getCwds(ids, requestId) {
    const targets = Array.isArray(ids) ? ids : [];
    const cwds = {};
    const idsByPid = new Map();
    for (const id of targets) {
      cwds[id] = null;
      const p = ptys.get(id);
      if (!p) continue;
      const sharing = idsByPid.get(p.pid);
      if (sharing) sharing.push(id);
      else idsByPid.set(p.pid, [id]);
    }
    const resolved = getCwdsForPids([...idsByPid.keys()]);
    for (const [pid, sharing] of idsByPid) {
      const cwd = resolved.get(pid) ?? null;
      for (const id of sharing) cwds[id] = cwd;
    }
    send('cwds', { cwds, requestId });
  }

  function getOpenPorts(id, requestId) {
    const p = ptys.get(id);
    // getOpenPortsForPid is fail-soft (returns [] on any platform error).
    send('openPorts', { id, ports: p ? getOpenPortsForPid(p.pid) : [], requestId });
  }

  /** One answer for every id a listing asks about, so N terminals cost one
   *  process scan rather than N (`docs/specs/dor-cli.md` -> "Current Implemented
   *  Commands"). An id with no live PTY answers `[]`, exactly as `getOpenPorts`
   *  does. */
  function getOpenPortsMany(ids, requestId) {
    const targets = Array.isArray(ids) ? ids : [];
    const ports = {};
    const idsByPid = new Map();
    for (const id of targets) {
      ports[id] = [];
      const p = ptys.get(id);
      if (!p) continue;
      const sharing = idsByPid.get(p.pid);
      if (sharing) sharing.push(id);
      else idsByPid.set(p.pid, [id]);
    }
    const resolved = getOpenPortsForPids([...idsByPid.keys()]);
    for (const [pid, sharing] of idsByPid) {
      const found = resolved.get(pid) ?? [];
      for (const id of sharing) ports[id] = found;
    }
    send('openPortsMany', { ports, requestId });
  }

  // Send ONE ^C to the given PTYs (all live ones when `ids` is omitted), so an
  // agent prints its resume invocation before the host tears the process down
  // (docs/specs/vscode.md -> "Capturing agent recovery"). Writes ^C into
  // the pty rather than signalling a pid: the tty line discipline delivers SIGINT
  // to the foreground process group itself, so this needs neither tcgetpgrp nor
  // the master fd node-pty does not expose, and it is the one mechanism both
  // agents honour (SIGTERM to the pty leader is ignored by an interactive shell,
  // and codex prints nothing on SIGTERM at all).
  //
  // The caller decides whether a second press is warranted, per PTY, because the
  // two agents want opposite things and a blanket second press breaks one of them:
  // codex exits on the first press and prints its hint ~255ms later, and a second
  // press landing in that window aborts the print entirely ("Shutting down...^C"
  // and nothing else). Claude needs the second press and prints nothing without
  // it. Only the host can tell them apart, because only the host sees what came
  // back (docs/specs/vscode.md -> "Capturing agent recovery").
  //
  // "Omitted" therefore means omitted, never "an empty list": a caller that
  // forwards a computed set that happened to come out empty must get a no-op, not
  // a broadcast. The blanket second press above is exactly what this must never
  // do by accident, and an emptiness test turns one dropped length guard in the
  // caller into a silent hint-destroying press on every pane.
  function interrupt(ids, requestId) {
    const targets = Array.isArray(ids) ? ids : [...ptys.keys()];
    for (const id of targets) {
      // Guarded per id: one already-dead pty must not abort the rest.
      try { write(id, '\x03'); } catch { /* already dead */ }
    }
    // Only an actual request is acked. The recovery capture presses in-process
    // and has nothing to correlate, so a blanket ack would put a stray
    // `interruptDone {requestId: undefined}` on the protocol channel for every
    // press it makes.
    if (requestId !== undefined) send('interruptDone', { requestId });
  }

  /**
   * SIGTERM `ids` and resolve once they have exited.
   *
   * Always an explicit set, never a blanket kill: one window of several tears
   * down alone, and killing a sibling's terminals is unrecoverable. The host
   * names the window's own PTYs (`pty_graceful_kill` in
   * standalone/src-tauri/src/lib.rs).
   */
  function gracefulKill(ids, timeout = 2000, requestId) {
    const done = () => send('gracefulKillDone', { requestId });
    const targets = (Array.isArray(ids) ? ids : []).filter((id) => ptys.has(id));
    // Nothing live to SIGTERM, but a just-exited PTY can still deliver final
    // output shortly after onExit (notably under ConPTY). Keep the same single
    // grace tick used after the live map empties before the quit flush runs.
    if (targets.length === 0) { setTimeout(done, 50); return; }
    for (const id of targets) {
      try { ptys.get(id).kill('SIGTERM'); } catch { /* already dead */ }
    }
    // Resolve early once every target has exited (onExit removes it) instead
    // of always sitting out the full timeout — but one grace tick after the last
    // one goes, since ConPTY can fire onExit before the final data flush and that
    // last output must reach the host first.
    const deadline = Date.now() + timeout;
    const tick = () => {
      if (!targets.some((id) => ptys.has(id))) setTimeout(done, 50);
      else if (Date.now() >= deadline) done();
      else setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  }

  function getShells(requestId) {
    send('shells', { shells: detectAvailableShells(), requestId });
  }

  return { spawn, write, resize, hasPty, kill, killAll, list, context,
    getCwd, getCwds, getOpenPorts, getOpenPortsMany, interrupt, gracefulKill, getShells,
    liveIds, receivedChars, outputSince, mark };
};
