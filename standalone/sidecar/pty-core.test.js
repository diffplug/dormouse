const test = require('node:test');
const assert = require('node:assert/strict');

const { create, getCwdForPid, parseCwdFromLsof, resolveSpawnConfig, detectAvailableShells } = require('./pty-core');

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

// ── detectAvailableShells ───────────────────────────────────────────────

test('detectAvailableShells returns $SHELL on non-Windows', () => {
  const shells = detectAvailableShells({
    platform: 'linux',
    env: { SHELL: '/bin/zsh' },
  });

  assert.deepEqual(shells, [{ name: 'zsh', path: '/bin/zsh', args: [] }]);
});

test('detectAvailableShells falls back to /bin/sh when $SHELL is unset', () => {
  const shells = detectAvailableShells({
    platform: 'darwin',
    env: {},
  });

  assert.deepEqual(shells, [{ name: 'sh', path: '/bin/sh', args: [] }]);
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
    execSync() { throw new Error('not available'); },
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
    execSync() { throw new Error('not available'); },
  });

  const gitBash = shells.find((s) => s.name === 'Git Bash');
  assert.ok(gitBash, 'Git Bash should be detected');
  assert.equal(gitBash.path, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.deepEqual(gitBash.args, ['--login', '-i']);
});

test('detectAvailableShells detects WSL distros on Windows', () => {
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
    execSync() {
      // wsl.exe -l -q returns UTF-16LE with null bytes
      return 'Ubuntu\r\nDebian\r\n';
    },
  });

  const ubuntu = shells.find((s) => s.name === 'Ubuntu');
  assert.ok(ubuntu, 'Ubuntu WSL should be detected');
  assert.equal(ubuntu.path, 'C:\\Windows\\System32\\wsl.exe');
  assert.deepEqual(ubuntu.args, ['-d', 'Ubuntu']);

  const debian = shells.find((s) => s.name === 'Debian');
  assert.ok(debian, 'Debian WSL should be detected');
});
