const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  create,
  detectAvailableShells,
  getCwdForPid,
  parseCwdFromLsof,
  resolveSpawnConfig,
  withPrependedPath,
  buildDescendantSet,
  parseProcStatPpid,
  parsePsPairs,
  parseHexIpv4,
  parseHexIpv6,
  parseProcNetTcp,
  parseLsofListening,
  parseNetTcpConnections,
  parseNetstatListening,
  getDescendantPids,
  getListeningPortsForPids,
  getOpenPortsForPid,
} = require('./pty-core');

test('resolveSpawnConfig uses POSIX shell and home defaults', () => {
  const config = resolveSpawnConfig(undefined, {
    platform: 'linux',
    env: {},
    osModule: {
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp/fallback',
    },
  });

  assert.equal(config.shell, '/bin/sh');
  assert.equal(config.cwd, '/home/tester');
  assert.equal(config.cwdWarning, null);
  assert.equal(config.cols, 80);
  assert.equal(config.rows, 30);
  assert.equal(config.env.TERM_PROGRAM, 'iTerm.app');
  assert.equal(config.env.TERM_PROGRAM_VERSION, '3.5.0');
  assert.equal(config.env.LC_TERMINAL, 'iTerm2');
  assert.equal(config.env.LC_TERMINAL_VERSION, '3.5.0');
  assert.deepEqual(config.shellArgs, ['-l']);
});

test('resolveSpawnConfig prepends dor CLI bin and injects surface id', () => {
  const config = resolveSpawnConfig(
    { surfaceId: 'pane-1' },
    {
      platform: 'linux',
      env: {
        PATH: '/usr/bin',
        DORMOUSE_CLI_BIN: '/Applications/Dormouse/dor-cli/bin',
      },
      osModule: {
        homedir: () => '/home/tester',
        tmpdir: () => '/tmp/fallback',
      },
    },
  );

  assert.equal(config.env.PATH, '/Applications/Dormouse/dor-cli/bin:/usr/bin');
  assert.equal(config.env.DORMOUSE_CLI_BIN, undefined);
  assert.equal(config.env.DORMOUSE_SURFACE_ID, 'pane-1');
});

test('resolveSpawnConfig applies per-spawn dor CLI env overrides', () => {
  const config = resolveSpawnConfig(
    {
      surfaceId: 'pane-1',
      env: {
        DORMOUSE_CLI_BIN: '/extension/dor-cli/bin',
        DORMOUSE_CLI_JS: '/extension/dor-cli/dist/dor.js',
        DORMOUSE_CONTROL_SOCKET: '/tmp/dor.sock',
        DORMOUSE_CONTROL_TOKEN: 'token',
        DORMOUSE_NODE: '/usr/bin/node',
      },
    },
    {
      platform: 'linux',
      env: {
        PATH: '/usr/bin',
      },
      osModule: {
        homedir: () => '/home/tester',
        tmpdir: () => '/tmp/fallback',
      },
    },
  );

  assert.equal(config.env.PATH, '/extension/dor-cli/bin:/usr/bin');
  assert.equal(config.env.DORMOUSE_CLI_BIN, undefined);
  assert.equal(config.env.DORMOUSE_CLI_JS, '/extension/dor-cli/dist/dor.js');
  assert.equal(config.env.DORMOUSE_CONTROL_SOCKET, '/tmp/dor.sock');
  assert.equal(config.env.DORMOUSE_CONTROL_TOKEN, 'token');
  assert.equal(config.env.DORMOUSE_NODE, '/usr/bin/node');
  assert.equal(config.env.DORMOUSE_SURFACE_ID, 'pane-1');
});

test('withPrependedPath preserves Windows Path casing', () => {
  const env = withPrependedPath(
    { Path: 'C:\\Windows\\System32' },
    'C:\\Dormouse\\dor-cli\\bin',
    'win32',
  );

  assert.deepEqual(env, {
    Path: 'C:\\Dormouse\\dor-cli\\bin;C:\\Windows\\System32',
  });
});

test('resolveSpawnConfig uses Windows shell and profile defaults', () => {
  const config = resolveSpawnConfig(undefined, {
    platform: 'win32',
    env: {},
    osModule: {
      homedir: () => 'C:\\Users\\tester',
      tmpdir: () => 'C:\\Temp',
    },
  });

  assert.equal(config.shell, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(config.cwd, 'C:\\Users\\tester');
  assert.equal(config.cwdWarning, null);
  assert.equal(config.env.TERM_PROGRAM, 'iTerm.app');
  assert.equal(config.env.TERM_PROGRAM_VERSION, '3.5.0');
  assert.equal(config.env.LC_TERMINAL, 'iTerm2');
  assert.equal(config.env.LC_TERMINAL_VERSION, '3.5.0');
  assert.deepEqual(config.shellArgs, []);
});

test('resolveSpawnConfig preserves explicit cwd', () => {
  const config = resolveSpawnConfig(
    { cwd: '/workspace', cols: 120, rows: 40 },
    {
      platform: 'linux',
      env: { SHELL: '/bin/bash' },
      fsModule: {
        statSync: () => ({ isDirectory: () => true }),
      },
      osModule: {
        homedir: () => '/home/tester',
        tmpdir: () => '/tmp/fallback',
      },
    },
  );

  assert.equal(config.shell, '/bin/bash');
  assert.equal(config.cwd, '/workspace');
  assert.equal(config.cwdWarning, null);
  assert.equal(config.cols, 120);
  assert.equal(config.rows, 40);
  assert.deepEqual(config.shellArgs, ['-l']);
});

test('resolveSpawnConfig skips -l for csh-style shells that reject it', () => {
  const config = resolveSpawnConfig(undefined, {
    platform: 'linux',
    env: { SHELL: '/bin/tcsh' },
    osModule: {
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp/fallback',
    },
  });

  assert.equal(config.shell, '/bin/tcsh');
  assert.deepEqual(config.shellArgs, []);
});

test('resolveSpawnConfig falls back to the default directory when explicit cwd is missing', () => {
  const config = resolveSpawnConfig(
    { cwd: '/gone', cols: 120, rows: 40 },
    {
      platform: 'linux',
      env: { SHELL: '/bin/bash' },
      fsModule: {
        statSync: () => { throw new Error('ENOENT'); },
      },
      osModule: {
        homedir: () => '/home/tester',
        tmpdir: () => '/tmp/fallback',
      },
    },
  );

  assert.equal(config.shell, '/bin/bash');
  assert.equal(config.cwd, '/home/tester');
  assert.equal(config.cwdWarning, 'unable to restore because directory /gone was removed');
  assert.equal(config.cols, 120);
  assert.equal(config.rows, 40);
});

test('resolveSpawnConfig treats empty args array as no-override and applies -l', () => {
  // Regression: detectAvailableShells returns args:[] on Unix, which used to
  // suppress the -l fallback (empty array is truthy). That caused the login
  // shell to skip ~/.zprofile, leaving Homebrew/asdf off PATH and producing
  // "asdf_update_java_home: command not found: asdf" on every prompt.
  const config = resolveSpawnConfig(
    { args: [] },
    {
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      osModule: {
        homedir: () => '/Users/tester',
        tmpdir: () => '/tmp/fallback',
      },
    },
  );

  assert.equal(config.shell, '/bin/zsh');
  assert.deepEqual(config.shellArgs, ['-l']);
});

test('resolveSpawnConfig skips -l for csh', () => {
  const config = resolveSpawnConfig(undefined, {
    platform: 'darwin',
    env: { SHELL: '/bin/csh' },
    osModule: {
      homedir: () => '/Users/tester',
      tmpdir: () => '/tmp/fallback',
    },
  });

  assert.equal(config.shell, '/bin/csh');
  assert.deepEqual(config.shellArgs, []);
});

test('create buffers scrollback for getScrollback requests', () => {
  const events = [];
  const listeners = {};
  const fakePty = {
    pid: 123,
    onData(handler) { listeners.data = handler; },
    onExit(handler) { listeners.exit = handler; },
    resize() {},
    write() {},
    kill() {},
  };

  const mgr = create((event, data) => {
    events.push({ event, data });
  }, {
    spawn() {
      return fakePty;
    },
  });

  mgr.spawn('pane-1');
  listeners.data?.('hello');
  listeners.data?.(' world');
  mgr.getScrollback('pane-1', 'req-1');

  assert.deepEqual(events.at(-1), {
    event: 'scrollback',
    data: { id: 'pane-1', data: 'hello world', requestId: 'req-1' },
  });
});

test('parseCwdFromLsof returns the cwd for the requested pid', () => {
  const output = [
    'p100',
    'fcwd',
    'n/',
    'p4242',
    'fcwd',
    'n/home/tester/project',
    '',
  ].join('\n');

  assert.equal(parseCwdFromLsof(output, 4242), '/home/tester/project');
});

test('getCwdForPid uses lsof with -a and parses the target pid cwd', () => {
  const calls = [];
  const cwd = getCwdForPid(4242, {
    fsModule: {
      readlinkSync: () => { throw new Error('ENOENT'); },
    },
    execFileSync(file, args, options) {
      calls.push({ file, args, options });
      return [
        'p100',
        'fcwd',
        'n/',
        'p4242',
        'fcwd',
        'n/home/tester/project',
        '',
      ].join('\n');
    },
  });

  assert.equal(cwd, '/home/tester/project');
  assert.deepEqual(calls, [{
    file: 'lsof',
    args: ['-a', '-d', 'cwd', '-p', '4242', '-Fn'],
    options: { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  }]);
});

// ── resolveSpawnConfig shell/args override ──────────────────────────────

test('resolveSpawnConfig uses explicit shell and args when provided', () => {
  const config = resolveSpawnConfig(
    { shell: '/usr/bin/fish', args: ['--private'] },
    {
      platform: 'linux',
      env: { SHELL: '/bin/bash' },
      osModule: {
        homedir: () => '/home/tester',
        tmpdir: () => '/tmp/fallback',
      },
    },
  );

  assert.equal(config.shell, '/usr/bin/fish');
  assert.deepEqual(config.shellArgs, ['--private']);
});

test('resolveSpawnConfig uses explicit shell with default args fallback', () => {
  const config = resolveSpawnConfig(
    { shell: '/bin/zsh' },
    {
      platform: 'linux',
      env: { SHELL: '/bin/bash' },
      osModule: {
        homedir: () => '/home/tester',
        tmpdir: () => '/tmp/fallback',
      },
    },
  );

  assert.equal(config.shell, '/bin/zsh');
  assert.deepEqual(config.shellArgs, ['-l']);
});

test('resolveSpawnConfig honors non-empty explicit args (e.g. WSL distro flags)', () => {
  const config = resolveSpawnConfig(
    { args: ['-d', 'Ubuntu'] },
    {
      platform: 'win32',
      env: {},
      osModule: {
        homedir: () => 'C:\\Users\\tester',
        tmpdir: () => 'C:\\Temp',
      },
    },
  );

  assert.deepEqual(config.shellArgs, ['-d', 'Ubuntu']);
});

// ── OSC 633 shell-integration injection ─────────────────────────────────

// Pretend the shipped integration scripts exist on disk.
const integrationFsModule = {
  statSync(filePath) {
    const p = String(filePath);
    if (p.endsWith('.zshrc') || p.endsWith('shellIntegration.bash') || p.endsWith('shellIntegration.ps1')) {
      return { isFile: () => true };
    }
    throw new Error(`ENOENT: ${filePath}`);
  },
};

test('resolveSpawnConfig injects zsh integration via ZDOTDIR and preserves the user ZDOTDIR', () => {
  const config = resolveSpawnConfig(undefined, {
    platform: 'linux',
    env: {
      SHELL: '/bin/zsh',
      HOME: '/home/tester',
      ZDOTDIR: '/home/tester/.config/zsh',
      DORMOUSE_SHELL_INTEGRATION_DIR: '/opt/dormouse/shell-integration',
    },
    osModule: { homedir: () => '/home/tester', tmpdir: () => '/tmp/fallback' },
    fsModule: integrationFsModule,
  });

  assert.equal(config.env.ZDOTDIR, '/opt/dormouse/shell-integration/zsh');
  assert.equal(config.env.USER_ZDOTDIR, '/home/tester/.config/zsh');
  // Login flag is unaffected — integration is env-only for zsh.
  assert.deepEqual(config.shellArgs, ['-l']);
  // The internal pointer is not leaked to the shell.
  assert.equal(config.env.DORMOUSE_SHELL_INTEGRATION_DIR, undefined);
});

test('resolveSpawnConfig zsh integration falls back to HOME when the user has no ZDOTDIR', () => {
  const config = resolveSpawnConfig(undefined, {
    platform: 'linux',
    env: {
      SHELL: '/bin/zsh',
      HOME: '/home/tester',
      DORMOUSE_SHELL_INTEGRATION_DIR: '/opt/dormouse/shell-integration',
    },
    osModule: { homedir: () => '/home/tester', tmpdir: () => '/tmp/fallback' },
    fsModule: integrationFsModule,
  });

  assert.equal(config.env.ZDOTDIR, '/opt/dormouse/shell-integration/zsh');
  assert.equal(config.env.USER_ZDOTDIR, '/home/tester');
});

test('resolveSpawnConfig injects bash integration via --init-file and drops the login flag', () => {
  const config = resolveSpawnConfig(undefined, {
    platform: 'linux',
    env: {
      SHELL: '/bin/bash',
      HOME: '/home/tester',
      DORMOUSE_SHELL_INTEGRATION_DIR: '/opt/dormouse/shell-integration',
    },
    osModule: { homedir: () => '/home/tester', tmpdir: () => '/tmp/fallback' },
    fsModule: integrationFsModule,
  });

  assert.deepEqual(config.shellArgs, [
    '--init-file',
    '/opt/dormouse/shell-integration/bash/shellIntegration.bash',
  ]);
  // bash injection is args-only; no zsh env leaks in.
  assert.equal(config.env.ZDOTDIR, undefined);
});

test('resolveSpawnConfig leaves bash login args alone when the caller passed explicit args', () => {
  const config = resolveSpawnConfig(
    { args: ['-c', 'echo hi'] },
    {
      platform: 'linux',
      env: {
        SHELL: '/bin/bash',
        HOME: '/home/tester',
        DORMOUSE_SHELL_INTEGRATION_DIR: '/opt/dormouse/shell-integration',
      },
      osModule: { homedir: () => '/home/tester', tmpdir: () => '/tmp/fallback' },
      fsModule: integrationFsModule,
    },
  );

  assert.deepEqual(config.shellArgs, ['-c', 'echo hi']);
});

test('resolveSpawnConfig injects bash integration for Git Bash despite its --login -i args', () => {
  const integrationDir = 'C:\\Program Files\\Dormouse\\shell-integration';
  const config = resolveSpawnConfig(
    { shell: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] },
    {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\tester',
        DORMOUSE_SHELL_INTEGRATION_DIR: integrationDir,
      },
      osModule: { homedir: () => 'C:\\Users\\tester', tmpdir: () => 'C:\\Temp' },
      fsModule: integrationFsModule,
    },
  );

  // The --login -i defaults are subsumed by the init-file script, which sources
  // the login profile itself.
  const script = path.join(integrationDir, 'bash', 'shellIntegration.bash');
  assert.deepEqual(config.shellArgs, ['--init-file', script]);
});

test('resolveSpawnConfig keeps Git Bash login args when the script is not present', () => {
  const config = resolveSpawnConfig(
    { shell: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] },
    {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\tester',
        DORMOUSE_SHELL_INTEGRATION_DIR: 'C:\\Program Files\\Dormouse\\shell-integration',
      },
      osModule: { homedir: () => 'C:\\Users\\tester', tmpdir: () => 'C:\\Temp' },
      fsModule: { statSync() { throw new Error('ENOENT'); } },
    },
  );

  // Fail-safe: no script on disk → the original login/interactive args survive.
  assert.deepEqual(config.shellArgs, ['--login', '-i']);
});

test('resolveSpawnConfig falls back to the bash login flag when the script is not present', () => {
  const config = resolveSpawnConfig(undefined, {
    platform: 'linux',
    env: {
      SHELL: '/bin/bash',
      HOME: '/home/tester',
      DORMOUSE_SHELL_INTEGRATION_DIR: '/opt/dormouse/shell-integration',
    },
    osModule: { homedir: () => '/home/tester', tmpdir: () => '/tmp/fallback' },
    fsModule: { statSync() { throw new Error('ENOENT'); } },
  });

  assert.deepEqual(config.shellArgs, ['-l']);
});

test('resolveSpawnConfig injects pwsh integration via -NoExit -Command dot-source', () => {
  const integrationDir = 'C:\\Program Files\\Dormouse\\shell-integration';
  const config = resolveSpawnConfig(
    { shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    {
      platform: 'win32',
      env: {
        HOME: 'C:\\Users\\tester',
        USERPROFILE: 'C:\\Users\\tester',
        DORMOUSE_SHELL_INTEGRATION_DIR: integrationDir,
      },
      osModule: { homedir: () => 'C:\\Users\\tester', tmpdir: () => 'C:\\Temp' },
      fsModule: integrationFsModule,
    },
  );

  const script = path.join(integrationDir, 'pwsh', 'shellIntegration.ps1');
  assert.deepEqual(config.shellArgs, ['-NoExit', '-Command', `. '${script}'`]);
});

test('resolveSpawnConfig injects Windows PowerShell (powershell.exe) too', () => {
  const integrationDir = 'C:\\Program Files\\Dormouse\\shell-integration';
  const config = resolveSpawnConfig(
    {
      shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    },
    {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\tester',
        DORMOUSE_SHELL_INTEGRATION_DIR: integrationDir,
      },
      osModule: { homedir: () => 'C:\\Users\\tester', tmpdir: () => 'C:\\Temp' },
      fsModule: integrationFsModule,
    },
  );

  const script = path.join(integrationDir, 'pwsh', 'shellIntegration.ps1');
  assert.deepEqual(config.shellArgs, ['-NoExit', '-Command', `. '${script}'`]);
});

test('resolveSpawnConfig merges integration into an interactive pwsh -Command (e.g. Developer PowerShell)', () => {
  const integrationDir = 'C:\\Program Files\\Dormouse\\shell-integration';
  const config = resolveSpawnConfig(
    {
      shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoExit', '-Command', '& { Import-Module "C:\\VS\\Launch-VsDevShell.ps1" }'],
    },
    {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\tester',
        DORMOUSE_SHELL_INTEGRATION_DIR: integrationDir,
      },
      osModule: { homedir: () => 'C:\\Users\\tester', tmpdir: () => 'C:\\Temp' },
      fsModule: integrationFsModule,
    },
  );

  // The dev-shell command runs first, then our dot-source installs the prompt wrapper.
  const script = path.join(integrationDir, 'pwsh', 'shellIntegration.ps1');
  assert.deepEqual(config.shellArgs, [
    '-NoExit',
    '-Command',
    `& { Import-Module "C:\\VS\\Launch-VsDevShell.ps1" }; . '${script}'`,
  ]);
});

test('resolveSpawnConfig adds a -Command to an interactive pwsh launch that has none', () => {
  const integrationDir = 'C:\\Program Files\\Dormouse\\shell-integration';
  const config = resolveSpawnConfig(
    { shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoExit', '-NoLogo'] },
    {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\tester',
        DORMOUSE_SHELL_INTEGRATION_DIR: integrationDir,
      },
      osModule: { homedir: () => 'C:\\Users\\tester', tmpdir: () => 'C:\\Temp' },
      fsModule: integrationFsModule,
    },
  );

  const script = path.join(integrationDir, 'pwsh', 'shellIntegration.ps1');
  assert.deepEqual(config.shellArgs, ['-NoExit', '-NoLogo', '-Command', `. '${script}'`]);
});

test('resolveSpawnConfig leaves a non-interactive pwsh one-off alone (-Command without -NoExit)', () => {
  const config = resolveSpawnConfig(
    {
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-Command', 'Get-Process'],
    },
    {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\tester',
        DORMOUSE_SHELL_INTEGRATION_DIR: 'C:\\Program Files\\Dormouse\\shell-integration',
      },
      osModule: { homedir: () => 'C:\\Users\\tester', tmpdir: () => 'C:\\Temp' },
      fsModule: integrationFsModule,
    },
  );

  assert.deepEqual(config.shellArgs, ['-Command', 'Get-Process']);
});

test('resolveSpawnConfig leaves a pwsh -File invocation alone', () => {
  const config = resolveSpawnConfig(
    {
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoExit', '-File', 'C:\\scripts\\do.ps1'],
    },
    {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\tester',
        DORMOUSE_SHELL_INTEGRATION_DIR: 'C:\\Program Files\\Dormouse\\shell-integration',
      },
      osModule: { homedir: () => 'C:\\Users\\tester', tmpdir: () => 'C:\\Temp' },
      fsModule: integrationFsModule,
    },
  );

  assert.deepEqual(config.shellArgs, ['-NoExit', '-File', 'C:\\scripts\\do.ps1']);
});

test('resolveSpawnConfig falls back to no args when the pwsh script is not present', () => {
  const config = resolveSpawnConfig(
    { shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\tester',
        DORMOUSE_SHELL_INTEGRATION_DIR: 'C:\\Program Files\\Dormouse\\shell-integration',
      },
      osModule: { homedir: () => 'C:\\Users\\tester', tmpdir: () => 'C:\\Temp' },
      fsModule: { statSync() { throw new Error('ENOENT'); } },
    },
  );

  // No injection: win32 has no login flag, so shellArgs stays empty.
  assert.deepEqual(config.shellArgs, []);
});

test('resolveSpawnConfig injects WSL bash integration via a sh -c detector', () => {
  const config = resolveSpawnConfig(
    { shell: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] },
    {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\tester',
        DORMOUSE_SHELL_INTEGRATION_DIR: 'C:\\Program Files\\Dormouse\\shell-integration',
      },
      osModule: { homedir: () => 'C:\\Users\\tester', tmpdir: () => 'C:\\Temp' },
      fsModule: integrationFsModule,
    },
  );

  // -d Ubuntu is preserved; the detector execs bash with our init-file (referenced
  // by its /mnt path, single-quoted so the "Program Files" space survives).
  const detector =
    'u=$(whoami 2>/dev/null); '
    + 'login=$(grep "^$u:" /etc/passwd 2>/dev/null | cut -d: -f7); '
    + 'if command -v bash >/dev/null 2>&1; then '
    + 'case "$login" in *zsh|*fish) exec "$login" -l;; '
    + "*) exec bash --init-file "
    + "'/mnt/c/Program Files/Dormouse/shell-integration/bash/shellIntegration.bash' -i;; esac; fi; "
    + 'exec "${login:-/bin/sh}" -l';
  assert.deepEqual(config.shellArgs, ['-d', 'Ubuntu', '--', 'sh', '-c', detector]);
});

test('resolveSpawnConfig leaves a non-standard WSL invocation untouched', () => {
  const config = resolveSpawnConfig(
    { shell: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu', '--', 'htop'] },
    {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\tester',
        DORMOUSE_SHELL_INTEGRATION_DIR: 'C:\\Program Files\\Dormouse\\shell-integration',
      },
      osModule: { homedir: () => 'C:\\Users\\tester', tmpdir: () => 'C:\\Temp' },
      fsModule: integrationFsModule,
    },
  );

  assert.deepEqual(config.shellArgs, ['-d', 'Ubuntu', '--', 'htop']);
});

test('resolveSpawnConfig leaves other shells untouched (keystroke fallback)', () => {
  const config = resolveSpawnConfig(undefined, {
    platform: 'linux',
    env: {
      SHELL: '/bin/fish',
      HOME: '/home/tester',
      DORMOUSE_SHELL_INTEGRATION_DIR: '/opt/dormouse/shell-integration',
    },
    osModule: { homedir: () => '/home/tester', tmpdir: () => '/tmp/fallback' },
    fsModule: integrationFsModule,
  });

  assert.equal(config.env.ZDOTDIR, undefined);
  assert.deepEqual(config.shellArgs, ['-l']);
});

test('resolveSpawnConfig skips zsh integration when the scripts are not present', () => {
  const config = resolveSpawnConfig(undefined, {
    platform: 'linux',
    env: {
      SHELL: '/bin/zsh',
      HOME: '/home/tester',
      ZDOTDIR: '/home/tester/.config/zsh',
      DORMOUSE_SHELL_INTEGRATION_DIR: '/opt/dormouse/shell-integration',
    },
    osModule: { homedir: () => '/home/tester', tmpdir: () => '/tmp/fallback' },
    fsModule: { statSync() { throw new Error('ENOENT'); } },
  });

  // ZDOTDIR is left exactly as the user had it; no injection occurred.
  assert.equal(config.env.ZDOTDIR, '/home/tester/.config/zsh');
  assert.equal(config.env.USER_ZDOTDIR, undefined);
});

// ── detectAvailableShells ───────────────────────────────────────────────

// No other common shells exist on disk → just $SHELL.
const noOtherShellsFsModule = { statSync() { throw new Error('ENOENT'); } };

test('detectAvailableShells returns $SHELL on non-Windows', () => {
  const shells = detectAvailableShells({
    platform: 'linux',
    env: { SHELL: '/bin/zsh' },
    fsModule: noOtherShellsFsModule,
  });

  assert.deepEqual(shells, [{ name: 'zsh', path: '/bin/zsh', args: [] }]);
});

test('detectAvailableShells falls back to /bin/sh when $SHELL is unset', () => {
  const shells = detectAvailableShells({
    platform: 'darwin',
    env: {},
    fsModule: noOtherShellsFsModule,
  });

  assert.deepEqual(shells, [{ name: 'sh', path: '/bin/sh', args: [] }]);
});

test('detectAvailableShells also offers common shells that exist on disk, $SHELL first', () => {
  const present = new Set(['/bin/zsh', '/bin/bash', '/bin/sh']);
  const shells = detectAvailableShells({
    platform: 'darwin',
    env: { SHELL: '/bin/zsh' },
    fsModule: { statSync(p) { if (present.has(String(p))) return { isFile: () => true }; throw new Error('ENOENT'); } },
  });

  // $SHELL (zsh) leads; bash and sh follow; one entry per shell name.
  assert.deepEqual(shells, [
    { name: 'zsh', path: '/bin/zsh', args: [] },
    { name: 'bash', path: '/bin/bash', args: [] },
    { name: 'sh', path: '/bin/sh', args: [] },
  ]);
});

test('detectAvailableShells detects PowerShell and cmd on Windows', () => {
  const existingFiles = new Set([
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\System32\\cmd.exe',
  ]);

  const shells = detectAvailableShells({
    platform: 'win32',
    env: {
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    },
    fsModule: {
      statSync(p) {
        if (existingFiles.has(p)) return { isFile: () => true, isDirectory: () => false };
        throw new Error('ENOENT');
      },
      readdirSync() { throw new Error('ENOENT'); },
    },
  });

  assert.equal(shells.length, 2);
  assert.equal(shells[0].name, 'Windows PowerShell');
  assert.equal(shells[1].name, 'Command Prompt');
});

test('detectAvailableShells detects Git Bash on Windows', () => {
  const existingFiles = new Set([
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ]);

  const shells = detectAvailableShells({
    platform: 'win32',
    env: {
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    },
    fsModule: {
      statSync(p) {
        if (existingFiles.has(p)) return { isFile: () => true, isDirectory: () => false };
        throw new Error('ENOENT');
      },
      readdirSync() { throw new Error('ENOENT'); },
    },
  });

  const gitBash = shells.find((s) => s.name === 'Git Bash');
  assert.ok(gitBash, 'Git Bash should be detected');
  assert.equal(gitBash.path, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.deepEqual(gitBash.args, ['--login', '-i']);
});

test('detectAvailableShells detects WSL distros from the registry on Windows', () => {
  const existingFiles = new Set([
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Windows\\System32\\wsl.exe',
  ]);

  const shells = detectAvailableShells({
    platform: 'win32',
    env: {
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    },
    fsModule: {
      statSync(p) {
        if (existingFiles.has(p)) return { isFile: () => true, isDirectory: () => false };
        throw new Error('ENOENT');
      },
      readdirSync() { throw new Error('ENOENT'); },
    },
    execFileSync(file, args) {
      // `reg query ...\Lxss /s /v DistributionName` output shape.
      if (String(file).endsWith('reg.exe')) {
        return [
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{guid-1}',
          '    DistributionName    REG_SZ    Ubuntu',
          '',
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{guid-2}',
          '    DistributionName    REG_SZ    Debian',
          '',
          'End of search: 2 match(es) found.',
        ].join('\r\n');
      }
      throw new Error(`unexpected execFileSync: ${file} ${args}`);
    },
  });

  const ubuntu = shells.find((s) => s.name === 'Ubuntu');
  assert.ok(ubuntu, 'Ubuntu WSL should be detected');
  assert.equal(ubuntu.path, 'C:\\Windows\\System32\\wsl.exe');
  assert.deepEqual(ubuntu.args, ['-d', 'Ubuntu']);

  const debian = shells.find((s) => s.name === 'Debian');
  assert.ok(debian, 'Debian WSL should be detected');
});

test('detectAvailableShells omits WSL when no distros are registered', () => {
  const shells = detectAvailableShells({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    fsModule: {
      statSync(p) {
        if (p === 'C:\\Windows\\System32\\wsl.exe' || p === 'C:\\Windows\\System32\\cmd.exe') {
          return { isFile: () => true, isDirectory: () => false };
        }
        throw new Error('ENOENT');
      },
      readdirSync() { throw new Error('ENOENT'); },
    },
    // reg.exe exits non-zero when the Lxss key is absent → execFileSync throws.
    execFileSync() { throw new Error('reg: key not found'); },
  });

  assert.equal(shells.find((s) => s.path.endsWith('wsl.exe')), undefined);
});

// ── Open-port discovery ──────────────────────────────────────────────────────

test('buildDescendantSet walks the process tree from the root', () => {
  // 100 → 200 → 400, 100 → 300; 999 is unrelated.
  const pairs = [
    [200, 100],
    [300, 100],
    [400, 200],
    [999, 1],
  ];
  const set = buildDescendantSet(pairs, 100);
  assert.deepEqual([...set].sort((a, b) => a - b), [100, 200, 300, 400]);
  assert.ok(!set.has(999));
});

test('buildDescendantSet tolerates cycles without looping forever', () => {
  const pairs = [[200, 100], [100, 200]];
  const set = buildDescendantSet(pairs, 100);
  assert.deepEqual([...set].sort((a, b) => a - b), [100, 200]);
});

test('parseProcStatPpid handles comm containing spaces and parens', () => {
  // comm = "(weird ) name)" — ppid is the second token after the final ')'.
  const content = '4242 (weird ) name) S 4200 4242 4242 0 -1 4194304 100 0';
  assert.equal(parseProcStatPpid(content), 4200);
});

test('parseProcStatPpid returns null on garbage', () => {
  assert.equal(parseProcStatPpid('no parens here'), null);
});

test('parsePsPairs parses pid/ppid columns', () => {
  const out = '  100   1\n  200 100\n 400  200\nheader junk\n';
  assert.deepEqual(parsePsPairs(out), [[100, 1], [200, 100], [400, 200]]);
});

test('parseHexIpv4 decodes little-endian /proc address', () => {
  assert.equal(parseHexIpv4('0100007F'), '127.0.0.1'); // loopback
  assert.equal(parseHexIpv4('00000000'), '0.0.0.0');   // all interfaces
});

test('parseHexIpv6 decodes and compresses', () => {
  assert.equal(parseHexIpv6('00000000000000000000000000000000'), '::');  // any
  assert.equal(parseHexIpv6('00000000000000000000000001000000'), '::1'); // loopback
});

test('parseProcNetTcp keeps only LISTEN rows owned by tracked inodes', () => {
  const content = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55501 1 ffff 100',
    '   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55502 1 ffff 100',
    '   2: 0100007F:E07A AB07007F:1538 01 00000000:00000000 00:00000000 00000000  1000        0 55503 1 ffff 100',
  ].join('\n');
  const inodeToPid = new Map([['55501', 4242], ['55502', 4242], ['55503', 4242]]);
  const ports = parseProcNetTcp(content, 'IPv4', inodeToPid);
  // Row 2 is ESTABLISHED (st 01) so it is dropped; only the two LISTEN rows remain.
  assert.deepEqual(ports, [
    { protocol: 'tcp', family: 'IPv4', address: '127.0.0.1', port: 5432, pid: 4242 },
    { protocol: 'tcp', family: 'IPv4', address: '0.0.0.0', port: 8080, pid: 4242 },
  ]);
});

test('parseProcNetTcp ignores rows whose inode is not tracked', () => {
  const content = [
    'header',
    '   0: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000  0 77777 1 ffff 100',
  ].join('\n');
  assert.deepEqual(parseProcNetTcp(content, 'IPv4', new Map()), []);
});

test('parseLsofListening parses *, IPv4, and bracketed IPv6 names', () => {
  const output = [
    'p4242',
    'cnode',
    'tIPv4',
    'n*:3000',
    'tIPv4',
    'n127.0.0.1:5432',
    'p4300',
    'cpython3',
    'tIPv6',
    'n[::1]:8080',
    'tIPv6',
    'n*:5173',
  ].join('\n');
  assert.deepEqual(parseLsofListening(output), [
    { protocol: 'tcp', family: 'IPv4', address: '0.0.0.0', port: 3000, pid: 4242, processName: 'node' },
    { protocol: 'tcp', family: 'IPv4', address: '127.0.0.1', port: 5432, pid: 4242, processName: 'node' },
    { protocol: 'tcp', family: 'IPv6', address: '::1', port: 8080, pid: 4300, processName: 'python3' },
    { protocol: 'tcp', family: 'IPv6', address: '::', port: 5173, pid: 4300, processName: 'python3' },
  ]);
});

test('parseNetTcpConnections filters by owning pid and detects family', () => {
  const json = JSON.stringify([
    { LocalAddress: '0.0.0.0', LocalPort: 3000, OwningProcess: 4242 },
    { LocalAddress: '::', LocalPort: 8080, OwningProcess: 4242 },
    { LocalAddress: '0.0.0.0', LocalPort: 9999, OwningProcess: 1 }, // not ours
  ]);
  const ports = parseNetTcpConnections(json, new Set([4242]), new Map([[4242, 'node.exe']]));
  assert.deepEqual(ports, [
    { protocol: 'tcp', family: 'IPv4', address: '0.0.0.0', port: 3000, pid: 4242, processName: 'node.exe' },
    { protocol: 'tcp', family: 'IPv6', address: '::', port: 8080, pid: 4242, processName: 'node.exe' },
  ]);
});

test('parseNetTcpConnections accepts a single (non-array) JSON object', () => {
  const json = JSON.stringify({ LocalAddress: '0.0.0.0', LocalPort: 3000, OwningProcess: 4242 });
  const ports = parseNetTcpConnections(json, new Set([4242]));
  assert.equal(ports.length, 1);
  assert.equal(ports[0].port, 3000);
});

test('parseNetstatListening parses LISTENING TCP rows for tracked pids', () => {
  const output = [
    'Active Connections',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4242',
    '  TCP    [::]:8080              [::]:0                 LISTENING       4242',
    '  TCP    127.0.0.1:54000        127.0.0.1:5432         ESTABLISHED     4242',
    '  TCP    0.0.0.0:9999           0.0.0.0:0              LISTENING       1',
  ].join('\n');
  const ports = parseNetstatListening(output, new Set([4242]));
  assert.deepEqual(ports, [
    { protocol: 'tcp', family: 'IPv4', address: '0.0.0.0', port: 3000, pid: 4242, processName: undefined },
    { protocol: 'tcp', family: 'IPv6', address: '::', port: 8080, pid: 4242, processName: undefined },
  ]);
});

test('getDescendantPids (linux) reads ppid from /proc/<pid>/stat', () => {
  const procStat = {
    '100': '100 (zsh) S 1 100 100 0',
    '200': '200 (node) S 100 200 200 0',
    '400': '400 (esbuild) S 200 400 400 0',
    '999': '999 (other) S 1 999 999 0',
  };
  const fsModule = {
    readdirSync(p) {
      if (p === '/proc') return ['100', '200', '400', '999', 'cpuinfo'];
      throw new Error('ENOENT');
    },
    readFileSync(p) {
      const m = /^\/proc\/(\d+)\/stat$/.exec(p);
      if (m && procStat[m[1]]) return procStat[m[1]];
      throw new Error('ENOENT');
    },
  };
  const pids = getDescendantPids(100, { platform: 'linux', fsModule });
  assert.deepEqual(pids.sort((a, b) => a - b), [100, 200, 400]);
});

test('getListeningPortsForPids (linux) maps fd inodes to /proc/net/tcp ports', () => {
  const fdLinks = {
    '/proc/200/fd/3': 'socket:[55501]',
    '/proc/200/fd/4': '/dev/null',
    '/proc/200/fd/5': 'socket:[55502]',
  };
  const tcp = [
    'header',
    '   0: 0100007F:1538 00000000:0000 0A 0 0 0  1000 0 55501 1 ffff 100',
    '   1: 00000000:1F90 00000000:0000 0A 0 0 0  1000 0 55502 1 ffff 100',
  ].join('\n');
  const fsModule = {
    readdirSync(p) {
      if (p === '/proc/200/fd') return ['3', '4', '5'];
      throw new Error('ENOENT');
    },
    readlinkSync(p) {
      if (fdLinks[p]) return fdLinks[p];
      throw new Error('ENOENT');
    },
    readFileSync(p) {
      if (p === '/proc/net/tcp') return tcp;
      if (p === '/proc/200/comm') return 'node\n';
      throw new Error('ENOENT'); // no tcp6
    },
  };
  const ports = getListeningPortsForPids([200], { platform: 'linux', fsModule });
  assert.deepEqual(ports, [
    { protocol: 'tcp', family: 'IPv4', address: '127.0.0.1', port: 5432, pid: 200, processName: 'node' },
    { protocol: 'tcp', family: 'IPv4', address: '0.0.0.0', port: 8080, pid: 200, processName: 'node' },
  ]);
});

test('getListeningPortsForPids (darwin) runs lsof with the descendant pid list', () => {
  let capturedArgs;
  const execFileSync = (cmd, args) => {
    assert.equal(cmd, 'lsof');
    capturedArgs = args;
    return ['p4242', 'cnode', 'tIPv4', 'n*:3000'].join('\n');
  };
  const ports = getListeningPortsForPids([100, 200], { platform: 'darwin', execFileSync });
  assert.ok(capturedArgs.includes('-sTCP:LISTEN'));
  assert.ok(capturedArgs.includes('100,200'));
  assert.deepEqual(ports, [
    { protocol: 'tcp', family: 'IPv4', address: '0.0.0.0', port: 3000, pid: 4242, processName: 'node' },
  ]);
});

test('getListeningPortsForPids (win32) prefers Get-NetTCPConnection', () => {
  const execFileSync = (cmd, args) => {
    assert.equal(cmd, 'powershell.exe');
    const script = args[args.length - 1];
    if (script.includes('Win32_Process')) {
      return JSON.stringify([{ ProcessId: 4242, Name: 'node.exe' }]);
    }
    if (script.includes('Get-NetTCPConnection')) {
      return JSON.stringify([{ LocalAddress: '0.0.0.0', LocalPort: 3000, OwningProcess: 4242 }]);
    }
    throw new Error(`unexpected script: ${script}`);
  };
  const ports = getListeningPortsForPids([4242], { platform: 'win32', execFileSync });
  assert.deepEqual(ports, [
    { protocol: 'tcp', family: 'IPv4', address: '0.0.0.0', port: 3000, pid: 4242, processName: 'node.exe' },
  ]);
});

test('getListeningPortsForPids (win32) falls back to netstat when the cmdlet fails', () => {
  const execFileSync = (cmd, args) => {
    if (cmd === 'powershell.exe') {
      const script = args[args.length - 1];
      if (script.includes('Win32_Process')) return JSON.stringify([]);
      throw new Error('Get-NetTCPConnection: not recognized');
    }
    if (cmd === 'netstat') {
      return '  TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   4242\n';
    }
    throw new Error('unexpected');
  };
  const ports = getListeningPortsForPids([4242], { platform: 'win32', execFileSync });
  assert.deepEqual(ports, [
    { protocol: 'tcp', family: 'IPv4', address: '0.0.0.0', port: 3000, pid: 4242, processName: undefined },
  ]);
});

test('getOpenPortsForPid de-duplicates and sorts by port', () => {
  // darwin path: lsof returns a duplicate (same family/addr/port) plus an
  // out-of-order pair to exercise sorting.
  const execFileSync = (cmd) => {
    if (cmd === 'ps') return '100 1\n200 100\n';
    if (cmd === 'lsof') {
      return [
        'p200', 'cnode', 'tIPv4', 'n*:8080',
        'tIPv4', 'n*:3000',
        'tIPv4', 'n*:8080', // duplicate
      ].join('\n');
    }
    throw new Error('unexpected');
  };
  const ports = getOpenPortsForPid(100, { platform: 'darwin', execFileSync });
  assert.deepEqual(ports.map((p) => p.port), [3000, 8080]);
});

test('getOpenPortsForPid returns [] for a non-integer pid', () => {
  assert.deepEqual(getOpenPortsForPid(undefined, { platform: 'linux' }), []);
});
