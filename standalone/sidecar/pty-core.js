const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

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
const ITERM2_COMPAT_VERSION = '3.5.0';

function resolveLoginArg(shell, platform = process.platform) {
  if (platform === 'win32') {
    return [];
  }

  const shellName = path.posix.basename(shell || '').toLowerCase();
  return LOGIN_ARG_UNSUPPORTED_SHELLS.has(shellName) ? [] : ['-l'];
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
  return next;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function withPosixEnvWrapper(config, platform) {
  if (platform === 'win32' || !config.forceEnvWrapper) {
    return config;
  }

  const env = config.env || {};
  const exports = [
    'PATH',
    'DORMOUSE_NODE',
    'DORMOUSE_CLI_JS',
    'DORMOUSE_CONTROL_SOCKET',
    'DORMOUSE_CONTROL_TOKEN',
    'DORMOUSE_SURFACE_ID',
  ]
    .filter((key) => env[key])
    .map((key) => `${key}=${shellQuote(env[key])}`)
    .join(' ');

  if (!exports) return config;

  return {
    ...config,
    shell: '/bin/sh',
    shellArgs: ['-c', `export ${exports}; exec "$@"`, 'dormouse-env', config.shell, ...config.shellArgs],
  };
}

function resolveSpawnConfig(options, runtime = {}) {
  const { cols = 80, rows = 30, cwd, shell: explicitShell, args: explicitArgs, surfaceId, forceEnvWrapper = false } = options || {};
  const env = {
    ...(runtime.env || process.env),
    ...(options?.env || {}),
  };
  const platform = runtime.platform || process.platform;
  const osModule = runtime.osModule || os;
  const fsModule = runtime.fsModule || fs;
  const defaultCwd = resolveDefaultCwd(platform, env, osModule);
  const missingExplicitCwd = Boolean(cwd) && !directoryExists(cwd, fsModule);
  const shell = explicitShell || resolveDefaultShell(platform, env);
  // An empty array means "no override," not "no args" — fall through to the
  // login-flag default so `~/.zprofile` runs and PATH includes Homebrew/asdf.
  const shellArgs = explicitArgs && explicitArgs.length > 0
    ? explicitArgs
    : resolveLoginArg(shell, platform);

  const envWithCliPath = withoutInternalDormouseEnv(withPrependedPath(env, env.DORMOUSE_CLI_BIN, platform));

  return withPosixEnvWrapper({
    cols,
    rows,
    cwd: missingExplicitCwd ? defaultCwd : (cwd || defaultCwd),
    cwdWarning: missingExplicitCwd ? `unable to restore because directory ${cwd} was removed` : null,
    env: {
      ...envWithCliPath,
      TERM_PROGRAM: 'iTerm.app',
      TERM_PROGRAM_VERSION: ITERM2_COMPAT_VERSION,
      LC_TERMINAL: 'iTerm2',
      LC_TERMINAL_VERSION: ITERM2_COMPAT_VERSION,
      DORMOUSE_SURFACE_ID: surfaceId || options?.id || '',
    },
    shell,
    shellArgs,
    forceEnvWrapper,
  }, platform);
}

module.exports.resolveSpawnConfig = resolveSpawnConfig;
module.exports.withPrependedPath = withPrependedPath;

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
  const execSyncFn = runtime.execSync || execSync;
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

  // WSL distributions
  try {
    const wslExe = path.win32.join(systemRoot, 'System32', 'wsl.exe');
    if (fileExists(wslExe, fsModule)) {
      const raw = execSyncFn(`"${wslExe}" -l -q`, {
        encoding: 'utf-16le',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      const distros = raw.split(/\r?\n/)
        .map((line) => line.replace(/\0/g, '').trim())
        .filter(Boolean);
      for (const distro of distros) {
        shells.push({ name: distro, path: wslExe, args: ['-d', distro] });
      }
    }
  } catch { /* WSL not installed or no distros */ }

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

function detectAvailableShells(runtime = {}) {
  const platform = runtime.platform || process.platform;
  if (platform === 'win32') {
    return detectWindowsShells(runtime);
  }

  // macOS / Linux: return $SHELL or /bin/sh
  const env = runtime.env || process.env;
  const shellPath = env.SHELL || '/bin/sh';
  const name = path.posix.basename(shellPath);
  return [{ name, path: shellPath, args: [] }];
}

module.exports.detectAvailableShells = detectAvailableShells;

function parseCwdFromLsof(output, pid) {
  const lines = output.split(/\r?\n/);
  let inTargetProcess = false;
  let sawCwdFd = false;

  for (const line of lines) {
    if (line.startsWith('p')) {
      inTargetProcess = line === `p${pid}`;
      sawCwdFd = false;
      continue;
    }

    if (!inTargetProcess) continue;

    if (line === 'fcwd') {
      sawCwdFd = true;
      continue;
    }

    if (sawCwdFd && line.startsWith('n')) {
      return line.slice(1) || null;
    }
  }

  return null;
}

module.exports.parseCwdFromLsof = parseCwdFromLsof;

function getCwdForPid(pid, runtime = {}) {
  const fsModule = runtime.fsModule || fs;
  const execFileSyncFn = runtime.execFileSync || execFileSync;

  // Linux: /proc/<pid>/cwd symlink
  try {
    return fsModule.readlinkSync(`/proc/${pid}/cwd`);
  } catch { /* not Linux or proc unavailable */ }

  // macOS: lsof. `-a` is required so `-p` and `-d cwd` are combined instead
  // of OR'ed, which otherwise returns unrelated processes and often `/`.
  try {
    const out = execFileSyncFn('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseCwdFromLsof(out, pid);
  } catch { /* fallback */ }

  return null;
}

module.exports.getCwdForPid = getCwdForPid;

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
 *   send('list',  { ptys: [{ id, alive }] })
 */

module.exports.create = function create(send, ptyModule) {
  if (!ptyModule || typeof ptyModule.spawn !== 'function') {
    throw new TypeError('create() requires a node-pty compatible module');
  }

  const MAX_SCROLLBACK_CHARS = 1_000_000;
  const pty = ptyModule;
  const ptys = new Map(); // id -> pty.IPty
  const scrollback = new Map(); // id -> { chunks: string[], totalChars: number }

  function bufferScrollback(id, data) {
    let entry = scrollback.get(id);
    if (!entry) {
      entry = { chunks: [], totalChars: 0 };
      scrollback.set(id, entry);
    }

    entry.chunks.push(data);
    entry.totalChars += data.length;
    while (entry.totalChars > MAX_SCROLLBACK_CHARS && entry.chunks.length > 1) {
      const removed = entry.chunks.shift();
      entry.totalChars -= removed ? removed.length : 0;
    }
  }

  function spawn(id, options) {
    const config = resolveSpawnConfig({ ...options, id, surfaceId: id });

    let p;
    try {
      p = pty.spawn(config.shell, config.shellArgs, {
        name: 'xterm-256color',
        cols: config.cols,
        rows: config.rows,
        cwd: config.cwd,
        env: config.env,
      });
    } catch (err) {
      console.error(`[pty-core] spawn failed for ${id}:`, err.message);
      send('error', { id, message: err.message });
      return;
    }

    ptys.set(id, p);
    scrollback.set(id, { chunks: [], totalChars: 0 });

    p.onData((data) => {
      bufferScrollback(id, data);
      send('data', { id, data });
    });

    p.onExit(({ exitCode, signal }) => {
      send('exit', { id, exitCode, signal });
      if (ptys.get(id) === p) {
        ptys.delete(id);
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

  function resize(id, cols, rows) {
    const p = ptys.get(id);
    if (p) p.resize(cols, rows);
  }

  function kill(id) {
    const p = ptys.get(id);
    if (p) {
      p.kill();
      ptys.delete(id);
    }
    scrollback.delete(id);
  }

  function killAll() {
    for (const [, p] of ptys) {
      p.kill();
    }
    ptys.clear();
    scrollback.clear();
  }

  function list() {
    const result = [];
    for (const [id] of ptys) {
      result.push({ id, alive: true });
    }
    send('list', { ptys: result });
  }

  function getCwd(id, requestId) {
    const p = ptys.get(id);
    if (!p) { send('cwd', { id, cwd: null, requestId }); return; }
    send('cwd', { id, cwd: getCwdForPid(p.pid), requestId });
  }

  function getScrollback(id, requestId) {
    const entry = scrollback.get(id);
    send('scrollback', {
      id,
      data: entry && entry.chunks.length > 0 ? entry.chunks.join('') : null,
      requestId,
    });
  }

  function gracefulKillAll(timeout = 2000) {
    for (const [, p] of ptys) {
      try { p.kill('SIGTERM'); } catch { /* already dead */ }
    }
    setTimeout(() => {
      send('gracefulKillDone', {});
    }, timeout);
  }

  function getShells(requestId) {
    send('shells', { shells: detectAvailableShells(), requestId });
  }

  return { spawn, write, resize, kill, killAll, list, getCwd, getScrollback, gracefulKillAll, getShells };
};
