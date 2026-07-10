import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../dist/cli.js';
import { buildShellCommandForKind, shellCommandKind } from '../dist/commands/shell-quote.js';
import { msysToWindowsCwd } from '../dist/commands/shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const snapshotsDir = join(__dirname, 'snapshots');
const updateSnapshots = process.env.UPDATE_SNAPSHOTS === '1';

const fixtureSurfaces = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    ref: 'surface:1',
    kind: 'terminal',
    renderMode: null,
    title: 'pnpm dev',
    focused: true,
    view: 'paned',
    cwd: '/Users/me/projects/site',
    activity: 'running',
    command: 'pnpm dev',
    url: null,
    ringing: false,
    todo: false,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    ref: 'surface:2',
    kind: 'terminal',
    renderMode: null,
    title: 'repo "watch"',
    focused: false,
    view: 'paned',
    cwd: '/Users/me/repo',
    activity: 'finished',
    exitCode: 1,
    command: null,
    url: null,
    ringing: false,
    todo: true,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    ref: 'surface:3',
    kind: 'browser',
    renderMode: 'ab-screencast',
    title: 'Dormouse',
    focused: false,
    view: 'paned',
    cwd: null,
    activity: null,
    command: null,
    url: 'http://localhost:5173/',
    ringing: false,
    todo: false,
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    ref: 'surface:4',
    kind: 'terminal',
    renderMode: null,
    title: '<idle> server.js',
    focused: false,
    view: 'minimized',
    cwd: '/Users/me/api',
    activity: 'finished',
    command: null,
    url: null,
    ringing: true,
    todo: false,
  },
];

// Listening ports the host would attach to a terminal Surface for `--ports`.
const fixturePortsByRef = {
  'surface:1': [{ family: 'IPv4', address: '0.0.0.0', port: 5173, pid: 4242, processName: 'node' }],
  'surface:4': [{ family: 'IPv6', address: '::1', port: 8080, pid: 5151, processName: 'python' }],
};

function fixtureClient(surfacesFixture = fixtureSurfaces) {
  return {
    requests: [],
    async listSurfaces(request) {
      this.requests.push(request);
      const paneTarget = request.pane;
      const matched = paneTarget
        ? surfacesFixture.filter((surface) => (
          surface.ref === paneTarget ||
          surface.id === paneTarget
        ))
        : surfacesFixture;
      // Mirror the host: attach listening ports to terminal Surfaces on request.
      const surfaces = request.includePorts
        ? matched.map((surface) => (surface.kind === 'terminal'
          ? { ...surface, ports: fixturePortsByRef[surface.ref] ?? [] }
          : surface))
        : matched;
      return {
        surfaces,
        windowRef: 'window:1',
        workspaceRef: 'workspace:1',
      };
    },
    async splitSurface(request) {
      this.requests.push({ method: 'splitSurface', request });
      // Mirror the real host: quote the argv for the target (here, posix) shell.
      const command = request.command ? buildShellCommandForKind('posix', request.command) : undefined;
      return {
        status: 'created',
        surfaceId: '33333333-3333-4333-8333-333333333333',
        surfaceRef: 'surface:3',
        direction: request.direction === 'auto' ? 'right' : request.direction,
        minimized: request.minimized,
        ...(command ? { command } : {}),
      };
    },
    async ensureSurface(request) {
      this.requests.push({ method: 'ensureSurface', request });
      // Mirror the host: quote the argv for the target shell, and key on the
      // command so the fixture can exercise both the created and existing paths.
      const command = buildShellCommandForKind('posix', request.command);
      const isExisting = command === 'pnpm dev:workspace';
      return {
        status: isExisting ? (request.restart ? 'restarted' : 'existing') : 'created',
        surfaceId: '33333333-3333-4333-8333-333333333333',
        surfaceRef: 'surface:3',
        command,
        cwd: request.cwd,
        minimized: request.minimized,
      };
    },
    async sendSurface(request) {
      this.requests.push({ method: 'sendSurface', request });
      return {
        status: 'sent',
        surfaceId: request.surface === 'surface:2'
          ? '22222222-2222-4222-8222-222222222222'
          : '11111111-1111-4111-8111-111111111111',
        surfaceRef: request.surface ?? 'surface:1',
        inputCount: request.inputCount,
      };
    },
    async readSurface(request) {
      this.requests.push({ method: 'readSurface', request });
      const text = request.scrollback
        ? 'first line\nsecond line\nthird line\nfourth line'
        : 'visible one\nvisible two';
      const limited = request.lines ? text.split('\n').slice(-request.lines).join('\n') : text;
      return {
        workspaceRef: 'workspace:1',
        surfaceId: request.surface === 'surface:2'
          ? '22222222-2222-4222-8222-222222222222'
          : '11111111-1111-4111-8111-111111111111',
        surfaceRef: request.surface ?? 'surface:1',
        text: limited,
      };
    },
    async killSurface(request) {
      this.requests.push({ method: 'killSurface', request });
      return {
        status: 'killed',
        surfaceId: request.surface === 'surface:2'
          ? '22222222-2222-4222-8222-222222222222'
          : '11111111-1111-4111-8111-111111111111',
        surfaceRef: request.surface,
      };
    },
    async iframeSurface(request) {
      this.requests.push({ method: 'iframeSurface', request });
      return {
        status: request.surface === 'surface:1' ? 'replaced' : 'created',
        surfaceId: request.surface === 'surface:1'
          ? '11111111-1111-4111-8111-111111111111'
          : '33333333-3333-4333-8333-333333333333',
        surfaceRef: request.surface === 'surface:1' ? 'surface:1' : 'surface:3',
        url: request.url,
        minimized: request.minimized,
      };
    },
    async agentBrowserSurface(request) {
      this.requests.push({ method: 'agentBrowserSurface', request });
      return {
        status: 'created',
        surfaceId: '33333333-3333-4333-8333-333333333333',
        surfaceRef: 'surface:3',
        session: request.session,
        minimized: false,
      };
    },
    async resolveOpenTarget(request) {
      this.requests.push({ method: 'resolveOpenTarget', request });
      // Mirror the host: surface:1 owns port 5173; surface:2 owns nothing.
      if (request.surface === 'surface:2') {
        throw new Error("surface 'surface:2' is not serving any port");
      }
      return {
        surfaceId: '11111111-1111-4111-8111-111111111111',
        surfaceRef: 'surface:1',
        port: 5173,
        url: 'http://localhost:5173/',
      };
    },
  };
}

function fakeAgentBrowser({ exitCode = 0, stdout = '✓ ok\n', stderr = '' } = {}) {
  const calls = [];
  return {
    calls,
    exec: async (binary, args) => {
      calls.push([binary, ...args]);
      if (args.includes('stream')) {
        return { exitCode: 0, stdout: '{"success":true,"data":{"port":61141}}\n', stderr: '' };
      }
      return { exitCode, stdout, stderr };
    },
  };
}

// Snapshots are authored in their Unix form, and CI compares against them exactly.
// On Windows, any path the CLI resolves through node:path comes back drive-prefixed
// with backslash separators (and JSON output escapes each backslash as `\\`), so e.g.
// `--cwd /Users/me/projects/site` renders as `C:\\Users\\me\\projects\\site`. Smudge
// such paths back to their Unix form as the output is captured — like a git smudge
// filter on the way in — so a snapshot regenerated on Windows still writes the Unix
// form, and the comparison below stays byte-exact rather than platform-aware.
// Deliberately narrow: it only fires on win32 and only rewrites a `X:\...` token, so
// it can't touch escapes like `\n` that share the backslash but aren't paths.
function smudgeWindowsPaths(text) {
  if (process.platform !== 'win32') return text;
  return text.replace(/[A-Za-z]:(?:\\{1,2}[^"\\]+)+/g, (path) =>
    path.slice(2).replace(/\\{1,2}/g, '/'));
}

async function snapshot(name, result) {
  const actual = smudgeWindowsPaths([
    `exitCode: ${result.exitCode}`,
    'stdout:',
    result.stdout,
    'stderr:',
    result.stderr,
  ].join('\n'));
  const path = join(snapshotsDir, `${name}.snap`);
  if (updateSnapshots) {
    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(path, actual);
    return;
  }
  const expected = await readFile(path, 'utf8');
  assert.equal(actual, expected);
}

test('split text output', async () => {
  await snapshot(
    'split-text',
    await runCli(['split', '--down', '--minimize', '--', 'pnpm', 'dev'], { client: fixtureClient() }),
  );
});

test('split json output', async () => {
  await snapshot(
    'split-json',
    await runCli(['split', '--json', '--', 'pnpm', 'test', '--', '--watch'], { client: fixtureClient() }),
  );
});

test('shell command quoting supports shell families', () => {
  assert.equal(shellCommandKind('/bin/zsh', 'darwin'), 'posix');
  assert.equal(shellCommandKind('C:\\Windows\\System32\\cmd.exe', 'win32'), 'cmd');
  assert.equal(shellCommandKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'), 'powershell');
  assert.equal(
    buildShellCommandForKind('posix', ['node', '-e', 'console.log(process.argv[1])', 'hello world', "it's"]),
    "node -e 'console.log(process.argv[1])' 'hello world' 'it'\\''s'",
  );
  assert.equal(
    buildShellCommandForKind('powershell', ['C:\\Program Files\\nodejs\\node.exe', '-e', 'Write-Output $args[0]', 'hello world', "it's"]),
    "& 'C:\\Program Files\\nodejs\\node.exe' -e 'Write-Output $args[0]' 'hello world' 'it''s'",
  );
  assert.equal(
    buildShellCommandForKind('cmd', ['C:\\Program Files\\nodejs\\node.exe', '-e', 'console.log(process.argv[1])', 'hello world', 'a&b']),
    '"C:\\Program Files\\nodejs\\node.exe" -e "console.log^(process.argv[1]^)" "hello world" "a^&b"',
  );
});

test('split sends command argv to the host', async () => {
  const client = fixtureClient();
  await runCli(['split', '--', 'pnpm', 'dev'], { client });
  assert.deepEqual(client.requests, [{
    method: 'splitSurface',
    request: {
      command: ['pnpm', 'dev'],
      direction: 'auto',
      minimized: false,
      surface: undefined,
    },
  }]);
});

test('ensure text output', async () => {
  await snapshot(
    'ensure-text',
    await runCli(['ensure', '--', 'pnpm', 'dev:workspace'], {
      client: fixtureClient(),
      env: { PWD: '/Users/me/projects/site' },
    }),
  );
});

test('ensure sends command argv and caller cwd to the host', async () => {
  const client = fixtureClient();
  await runCli(['ensure', '--', 'pnpm', 'dev'], { client, env: { PWD: '/work/site' } });
  // On win32 resolvePath drive-prefixes the POSIX PWD (`C:\work\site`); smudge it
  // back so this expectation is written once in its Unix form, like the snapshots.
  client.requests[0].request.cwd = smudgeWindowsPaths(client.requests[0].request.cwd);
  assert.deepEqual(client.requests, [{
    method: 'ensureSurface',
    request: {
      command: ['pnpm', 'dev'],
      minimized: false,
      restart: false,
      surface: undefined,
      cwd: '/work/site',
    },
  }]);
});

test('ensure --restart restarts a matching surface in place', async () => {
  const client = fixtureClient();
  await snapshot(
    'ensure-restart',
    await runCli(['ensure', '--restart', '--', 'pnpm', 'dev:workspace'], {
      client,
      env: { PWD: '/work/site' },
    }),
  );
  assert.equal(client.requests[0].request.restart, true);
});

test('ensure surfaces a host error (no integration) to stderr with exit 1', async () => {
  const client = {
    requests: [],
    async ensureSurface(request) {
      this.requests.push({ method: 'ensureSurface', request });
      throw new Error('dor ensure requires OSC 633 shell integration, which cmd.exe does not provide. Run it from a shell with Dormouse integration, such as Git Bash or PowerShell.');
    },
  };
  const result = await runCli(['ensure', '--', 'pnpm', 'dev'], { client, env: { PWD: '/work/site' } });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /^Error: dor ensure requires OSC 633 shell integration, which cmd\.exe does not provide/);
  assert.equal(result.stdout, '');
});

test('msysToWindowsCwd folds a Git Bash POSIX PWD to a Windows drive on win32', () => {
  assert.equal(msysToWindowsCwd('/c/Users/me/site', 'win32'), 'C:\\Users\\me\\site');
  assert.equal(msysToWindowsCwd('/d/work', 'win32'), 'D:\\work');
  // Already-native paths (some MSYS builds export `C:/...`) and non-win32
  // platforms are left for resolvePath to handle.
  assert.equal(msysToWindowsCwd('C:/Users/me/site', 'win32'), 'C:/Users/me/site');
  assert.equal(msysToWindowsCwd('/c/Users/me/site', 'linux'), '/c/Users/me/site');
});

test('ensure json output', async () => {
  await snapshot(
    'ensure-json',
    await runCli(['ensure', '--json', '--minimize', '--cwd', '/Users/me/projects/site', '--', 'pnpm', 'dev'], {
      client: fixtureClient(),
    }),
  );
});

test('version output', async () => {
  await snapshot(
    'version',
    await runCli(['version'], {
      versionMetadata: {
        version: '0.12.0',
        commit: '6e86b3ba',
        commitsSinceVersion: 89,
      },
    }),
  );
});

test('version json output', async () => {
  await snapshot(
    'version-json',
    await runCli(['version', '--json'], {
      versionMetadata: {
        version: '0.12.0',
        commit: '6e86b3ba',
        commitsSinceVersion: 89,
      },
    }),
  );
});

test('--version and -v alias the version command', async () => {
  const versionMetadata = { version: '0.12.0', commit: '6e86b3ba', commitsSinceVersion: 89 };
  const expected = await runCli(['version'], { versionMetadata });
  for (const flag of ['--version', '-v']) {
    const actual = await runCli([flag], { versionMetadata });
    assert.equal(actual.stdout, expected.stdout, `${flag} should print the version`);
    assert.equal(actual.exitCode, 0, `${flag} should exit 0`);
    assert.equal(actual.stderr, '', `${flag} should not error`);
  }
});

test('send text output', async () => {
  await snapshot(
    'send-text',
    await runCli(['send', 'surface:2', '--text', 'echo hello\\n'], { client: fixtureClient() }),
  );
});

test('send json output', async () => {
  await snapshot(
    'send-json',
    await runCli(['send', 'surface:2', '--json', '--key', 'ctrl-c'], { client: fixtureClient() }),
  );
});

test('send sends escaped text to the host', async () => {
  const client = fixtureClient();
  await runCli(['send', 'surface:1', '--text', 'echo hello\\n'], { client });
  assert.deepEqual(client.requests, [{
    method: 'sendSurface',
    request: {
      surface: 'surface:1',
      input: 'echo hello\n',
      inputCount: 1,
    },
  }]);
});

test('send sends key input to the host', async () => {
  const client = fixtureClient();
  await runCli(['send', 'surface:2', '--key', 'ctrl-c'], { client });
  assert.deepEqual(client.requests, [{
    method: 'sendSurface',
    request: {
      surface: 'surface:2',
      input: '\x03',
      inputCount: 1,
    },
  }]);
});

test('send combines text then key input', async () => {
  const client = fixtureClient();
  await runCli(['send', 'surface:2', '--text', 'npm test', '--key', 'enter'], { client });
  assert.deepEqual(client.requests, [{
    method: 'sendSurface',
    request: {
      surface: 'surface:2',
      input: 'npm test\r',
      inputCount: 2,
    },
  }]);
});

test('send key before text output', async () => {
  await snapshot(
    'send-key-before-text',
    await runCli(['send', 'surface:1', '--key', 'enter', '--text', 'npm test'], { client: fixtureClient() }),
  );
});

test('send duplicate text output', async () => {
  await snapshot(
    'send-duplicate-text',
    await runCli(['send', 'surface:1', '--text', 'one', '--text', 'two'], { client: fixtureClient() }),
  );
});

test('send duplicate key output', async () => {
  await snapshot(
    'send-duplicate-key',
    await runCli(['send', 'surface:1', '--key', 'enter', '--key', 'tab'], { client: fixtureClient() }),
  );
});

test('send sequence sends ordered input to the host', async () => {
  const client = fixtureClient();
  await runCli(['send', 'surface:1', '--sequence', '[{"text":"npm test"},{"key":"enter"}]'], { client });
  assert.deepEqual(client.requests, [{
    method: 'sendSurface',
    request: {
      surface: 'surface:1',
      input: 'npm test\r',
      inputCount: 2,
    },
  }]);
});

test('send stdin sends standard input to the host', async () => {
  const client = fixtureClient();
  await runCli(['send', 'surface:1', '--stdin'], { client, readStdin: async () => 'cat from stdin\n' });
  assert.deepEqual(client.requests, [{
    method: 'sendSurface',
    request: {
      surface: 'surface:1',
      input: 'cat from stdin\n',
      inputCount: 1,
    },
  }]);
});

test('send missing input output', async () => {
  await snapshot('send-missing-input', await runCli(['send', 'surface:1'], { client: fixtureClient() }));
});

test('send unsupported key output', async () => {
  await snapshot('send-unsupported-key', await runCli(['send', 'surface:1', '--key', 'cmd-k'], { client: fixtureClient() }));
});

test('read text output', async () => {
  await snapshot('read-text', await runCli(['read', 'surface:1'], { client: fixtureClient() }));
});

test('read sends request to the host', async () => {
  const client = fixtureClient();
  await runCli(['read', 'title:repo "watch"', '--scrollback', '--lines', '2'], { client });
  assert.deepEqual(client.requests, [{
    method: 'readSurface',
    request: {
      lines: 2,
      scrollback: true,
      surface: 'title:repo "watch"',
    },
  }]);
});

test('read json output', async () => {
  await snapshot(
    'read-json',
    await runCli(['read', 'surface:2', '--json', '--scrollback', '--lines', '2'], { client: fixtureClient() }),
  );
});

test('read invalid lines output', async () => {
  await snapshot('read-invalid-lines', await runCli(['read', 'surface:1', '--lines', '0'], { client: fixtureClient() }));
});

test('kill text output', async () => {
  await snapshot(
    'kill-text',
    await runCli(['kill', 'surface:2', '--confirm-dangerously'], { client: fixtureClient() }),
  );
});

test('kill json output', async () => {
  await snapshot(
    'kill-json',
    await runCli(['kill', 'surface:2', '--json', '--confirm-dangerously'], { client: fixtureClient() }),
  );
});

test('kill sends confirmation to the host', async () => {
  const client = fixtureClient();
  await runCli(['kill', 'title:repo "watch"', '--confirm-if-read', 'done'], { client });
  assert.deepEqual(client.requests, [{
    method: 'killSurface',
    request: {
      confirmation: { mode: 'if-read', text: 'done' },
      surface: 'title:repo "watch"',
    },
  }]);
});

test('kill missing confirmation output', async () => {
  await snapshot('kill-missing-confirmation', await runCli(['kill', 'surface:2'], { client: fixtureClient() }));
});

test('kill short confirm-if-read output', async () => {
  await snapshot(
    'kill-short-confirm-if-read',
    await runCli(['kill', 'surface:2', '--confirm-if-read', 'abc'], { client: fixtureClient() }),
  );
});

test('iframe text output', async () => {
  await snapshot(
    'iframe-text',
    await runCli(['iframe', '--surface', 'surface:1', 'https://localhost:5173'], { client: fixtureClient() }),
  );
});

test('iframe sends request to the host', async () => {
  const client = fixtureClient();
  await runCli(['iframe', '--minimize', 'https://example.com/docs?x=1'], { client });
  assert.deepEqual(client.requests, [{
    method: 'iframeSurface',
    request: {
      minimized: true,
      surface: undefined,
      url: 'https://example.com/docs?x=1',
    },
  }]);
});

test('iframe json output', async () => {
  await snapshot(
    'iframe-json',
    await runCli(['iframe', '--json', 'http://localhost:5173/'], { client: fixtureClient() }),
  );
});

test('iframe invalid url output', async () => {
  await snapshot('iframe-invalid-url', await runCli(['iframe', 'ftp://localhost:5173'], { client: fixtureClient() }));
});

test('iframe resolves a surface handle to its dev-server URL', async () => {
  const client = fixtureClient();
  const result = await runCli(['iframe', 'surface:1'], { client });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  // The handle is resolved to a URL, then the iframe surface is created with it.
  assert.deepEqual(client.requests, [
    { method: 'resolveOpenTarget', request: { surface: 'surface:1' } },
    { method: 'iframeSurface', request: { minimized: false, surface: undefined, url: 'http://localhost:5173/' } },
  ]);
});

test('iframe sugars a bare :port to a localhost URL without a host round trip', async () => {
  const client = fixtureClient();
  await runCli(['iframe', ':5173'], { client });
  assert.deepEqual(client.requests, [
    { method: 'iframeSurface', request: { minimized: false, surface: undefined, url: 'http://localhost:5173/' } },
  ]);
});

test('iframe defaults a schemeless host:port to http (localhost, LAN, Tailnet)', async () => {
  for (const [target, url] of [
    ['localhost:5173', 'http://localhost:5173/'],
    ['192.168.1.5:8080', 'http://192.168.1.5:8080/'],
    ['box.tailnet.ts.net:3000', 'http://box.tailnet.ts.net:3000/'],
  ]) {
    const client = fixtureClient();
    await runCli(['iframe', target], { client });
    assert.deepEqual(client.requests, [
      { method: 'iframeSurface', request: { minimized: false, surface: undefined, url } },
    ]);
  }
});

test('iframe honors an explicit https scheme (no downgrade to http)', async () => {
  const client = fixtureClient();
  await runCli(['iframe', 'https://example.com:8080'], { client });
  assert.equal(client.requests[0].request.url, 'https://example.com:8080/');
});

test('iframe surfaces a zero-port resolution error to stderr with exit 1', async () => {
  const result = await runCli(['iframe', 'surface:2'], { client: fixtureClient() });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /surface 'surface:2' is not serving any port/);
});

test('agent-browser passthrough output', async () => {
  const ab = fakeAgentBrowser({ stdout: '✓ \n  http://localhost:5173\n' });
  await snapshot(
    'agent-browser-passthrough',
    await runCli(['ab', 'open', 'http://localhost:5173'], { client: fixtureClient(), execAgentBrowser: ab.exec }),
  );
});

test('agent-browser resolves --key to a namespaced session and opens a surface', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['ab', '--key', 'storybook', 'open', 'http://localhost:6006'], { client, execAgentBrowser: ab.exec });
  assert.deepEqual(ab.calls, [
    ['agent-browser', '--session', 'dormouse.1.storybook', 'open', 'http://localhost:6006'],
    ['agent-browser', '--session', 'dormouse.1.storybook', 'stream', 'status', '--json'],
  ]);
  assert.deepEqual(client.requests, [{
    method: 'agentBrowserSurface',
    request: { key: 'storybook', session: 'dormouse.1.storybook', wsPort: 61141 },
  }]);
});

test('agent-browser defaults to --key default', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', 'open', 'http://localhost:5173'], { client, execAgentBrowser: ab.exec });
  assert.equal(ab.calls[0][2], 'dormouse.1.default');
  assert.deepEqual(client.requests[0].request, { key: 'default', session: 'dormouse.1.default', wsPort: 61141 });
});

test('agent-browser raw --session skips key namespacing', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['ab', '--session', 'mine', 'snapshot'], { client, execAgentBrowser: ab.exec });
  assert.equal(ab.calls[0][2], 'mine');
  assert.deepEqual(client.requests[0].request, { key: undefined, session: 'mine', wsPort: 61141 });
});

test('agent-browser open resolves a surface handle to a URL before forwarding', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['ab', 'open', 'surface:1'], { client, execAgentBrowser: ab.exec });
  // The surface handle is resolved via the host, then the URL is forwarded.
  assert.deepEqual(ab.calls, [
    ['agent-browser', '--session', 'dormouse.1.default', 'open', 'http://localhost:5173/'],
    ['agent-browser', '--session', 'dormouse.1.default', 'stream', 'status', '--json'],
  ]);
  assert.deepEqual(client.requests[0], { method: 'resolveOpenTarget', request: { surface: 'surface:1' } });
});

test('agent-browser open sugars a bare :port without a host round trip', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['ab', 'open', ':5173'], { client, execAgentBrowser: ab.exec });
  assert.equal(ab.calls[0][4], 'http://localhost:5173/');
  assert.equal(client.requests.some((entry) => entry.method === 'resolveOpenTarget'), false);
});

test('agent-browser open defaults a schemeless host:port to http, overriding agent-browser https', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['ab', 'open', 'localhost:5173'], { client, execAgentBrowser: ab.exec });
  // agent-browser would prepend https:// itself; dor forces http for the dev server.
  assert.equal(ab.calls[0][4], 'http://localhost:5173/');
  assert.equal(client.requests.some((entry) => entry.method === 'resolveOpenTarget'), false);
});

test('agent-browser open resolves a surface target behind a flag', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['ab', 'open', '--headed', 'surface:1'], { client, execAgentBrowser: ab.exec });
  assert.deepEqual(ab.calls[0], ['agent-browser', '--session', 'dormouse.1.default', 'open', '--headed', 'http://localhost:5173/']);
});

test('agent-browser leaves a plain open URL untouched', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['ab', 'open', 'http://localhost:5173'], { client, execAgentBrowser: ab.exec });
  assert.equal(ab.calls[0][4], 'http://localhost:5173');
  assert.equal(client.requests.some((entry) => entry.method === 'resolveOpenTarget'), false);
});

test('agent-browser open of a surface handle needs a control endpoint', async () => {
  const ab = fakeAgentBrowser();
  const result = await runCli(['ab', 'open', 'surface:1'], { execAgentBrowser: ab.exec });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /control endpoint is not available/);
  // Never forwards an unresolved handle to agent-browser.
  assert.deepEqual(ab.calls, []);
});

test('agent-browser close skips surface management', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['ab', 'close'], { client, execAgentBrowser: ab.exec });
  assert.deepEqual(ab.calls, [['agent-browser', '--session', 'dormouse.1.default', 'close']]);
  assert.deepEqual(client.requests, []);
});

test('agent-browser without a control endpoint stays a pure passthrough', async () => {
  const ab = fakeAgentBrowser();
  const result = await runCli(['ab', 'open', 'http://localhost:5173'], { execAgentBrowser: ab.exec });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(ab.calls, [['agent-browser', '--session', 'dormouse.1.default', 'open', 'http://localhost:5173']]);
});

test('agent-browser forwards child exit code and skips surface on failure', async () => {
  const ab = fakeAgentBrowser({ exitCode: 1, stderr: '✗ boom\n' });
  const client = fixtureClient();
  const result = await runCli(['ab', 'open', 'nope'], { client, execAgentBrowser: ab.exec });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, '✗ boom\n');
  assert.deepEqual(client.requests, []);
});

test('agent-browser key/session conflict output', async () => {
  const ab = fakeAgentBrowser();
  await snapshot(
    'agent-browser-key-session-conflict',
    await runCli(['ab', '--key', 'a', '--session', 'b', 'open', 'x'], { client: fixtureClient(), execAgentBrowser: ab.exec }),
  );
});

test('agent-browser missing binary output', async () => {
  const enoent = Object.assign(new Error("spawn agent-browser ENOENT"), { code: 'ENOENT' });
  await snapshot(
    'agent-browser-missing-binary',
    await runCli(['ab', 'open', 'http://localhost:5173'], {
      client: fixtureClient(),
      execAgentBrowser: async () => { throw enoent; },
    }),
  );
});

test('agent-browser respects DORMOUSE_AGENT_BROWSER_BIN and forwards it as binaryPath', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['ab', 'snapshot'], {
    client,
    execAgentBrowser: ab.exec,
    env: { DORMOUSE_AGENT_BROWSER_BIN: '/opt/custom/agent-browser' },
  });
  assert.equal(ab.calls[0][0], '/opt/custom/agent-browser');
  assert.equal(client.requests[0].request.binaryPath, '/opt/custom/agent-browser');
});

test('agent-browser resolves the binary on PATH to an absolute binaryPath', async () => {
  const { mkdtemp, writeFile: write, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'dor-ab-'));
  try {
    // On Windows a bare name isn't executable and resolveBinaryPath walks
    // PATHEXT (.cmd/.exe/.bat), so the on-disk shim must carry one of those
    // extensions — mirroring how agent-browser actually installs there.
    const ext = process.platform === 'win32' ? '.cmd' : '';
    const binPath = join(dir, `agent-browser${ext}`);
    await write(binPath, '#!/bin/sh\n', { mode: 0o755 });
    const ab = fakeAgentBrowser();
    const client = fixtureClient();
    await runCli(['ab', 'snapshot'], {
      client,
      execAgentBrowser: ab.exec,
      // Join with the platform PATH delimiter (`;` on Windows, `:` elsewhere) —
      // resolveBinaryPath splits on the same, so a POSIX-only `:` would hide dir.
      env: { PATH: ['/nonexistent', dir].join(delimiter) },
    });
    assert.equal(client.requests[0].request.binaryPath, binPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The caller terminal (surface:2) plus the host identity `dor list --json` folds
// in. The control socket is private host plumbing (the CLI is the public API), so
// the host block must not echo it — the snapshot proves the field is absent.
const listEnv = {
  DORMOUSE_SURFACE_ID: '22222222-2222-4222-8222-222222222222',
  DORMOUSE_CLI_JS: '/opt/dormouse/dor-cli/dist/dor.js',
  DORMOUSE_NODE: '/opt/dormouse/node',
  DORMOUSE_HOST: 'vscode',
  DORMOUSE_HOST_WORKSPACE: '/Users/me/projects/site',
  DORMOUSE_CONTROL_SOCKET: '/tmp/dormouse-control.sock',
};

test('list text output', async () => {
  const client = fixtureClient();
  const result = await runCli(['list'], { client, env: listEnv });
  assert.deepEqual(client.requests, [{ includePorts: false }]);
  await snapshot('list-text', result);
});

test('list json output', async () => {
  await snapshot(
    'list-json',
    await runCli(['list', '--json'], { client: fixtureClient(), env: listEnv }),
  );
});

test('list id-format both output', async () => {
  await snapshot(
    'list-id-format-both',
    await runCli(['list', '--id-format', 'both'], { client: fixtureClient(), env: listEnv }),
  );
});

test('list id-format ids output', async () => {
  await snapshot(
    'list-id-format-ids',
    await runCli(['list', '--id-format', 'ids'], { client: fixtureClient(), env: listEnv }),
  );
});

test('list accepts uuids as an id-format compatibility alias', async () => {
  const ids = await runCli(['list', '--id-format', 'ids'], { client: fixtureClient(), env: listEnv });
  const uuids = await runCli(['list', '--id-format', 'uuids'], { client: fixtureClient(), env: listEnv });
  assert.equal(uuids.stdout, ids.stdout);
  assert.equal(uuids.stderr, '');
  assert.equal(uuids.exitCode, 0);
});

test('list json schema includes ids and refs regardless of id-format', async () => {
  const result = await runCli(['list', '--json', '--id-format', 'ids'], { client: fixtureClient(), env: listEnv });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.surfaces[0].id, fixtureSurfaces[0].id);
  assert.equal(payload.surfaces[0].ref, 'surface:1');
  assert.equal(payload.caller_surface_id, listEnv.DORMOUSE_SURFACE_ID);
  assert.equal(payload.caller_surface_ref, 'surface:2');
  assert.equal(payload.focused_surface_id, fixtureSurfaces[0].id);
  assert.equal(payload.focused_surface_ref, 'surface:1');
  assert.equal(payload.workspace_ref, 'workspace:1');
  assert.equal(payload.window_ref, 'window:1');
});

test('list filters by kind, view, command, and cwd without port scanning', async () => {
  const client = fixtureClient();
  const result = await runCli(
    ['list', '--json', '--kind', 'terminal', '--view', 'paned', '--command', 'pnpm dev', '--cwd', '.'],
    { client, env: { ...listEnv, PWD: '/Users/me/projects/site' } },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(client.requests, [{ includePorts: false }]);

  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.surfaces.map((surface) => surface.ref), ['surface:1']);
  assert.equal(payload.caller_surface_ref, null);
  assert.equal(payload.focused_surface_ref, 'surface:1');
  assert.equal(payload.surfaces[0].ports, undefined);
});

test('list ports text output', async () => {
  const client = fixtureClient();
  const result = await runCli(['list', '--ports'], { client, env: listEnv });
  assert.deepEqual(client.requests, [{ includePorts: true }]);
  await snapshot('list-ports-text', result);
});

test('list ports json output', async () => {
  await snapshot(
    'list-ports-json',
    await runCli(['list', '--ports', '--json'], { client: fixtureClient(), env: listEnv }),
  );
});

test('list --port filters by listening port and includes port data', async () => {
  const client = fixtureClient();
  const result = await runCli(['list', '--port', '5173', '--json'], { client, env: listEnv });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(client.requests, [{ includePorts: true }]);

  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.surfaces.map((surface) => surface.ref), ['surface:1']);
  assert.deepEqual(payload.surfaces[0].ports.map((port) => port.port), [5173]);
});

test('list reports a null caller when the calling surface is not in the list', async () => {
  const result = await runCli(['list', '--json'], {
    client: fixtureClient(),
    env: { ...listEnv, DORMOUSE_SURFACE_ID: '99999999-9999-4999-8999-999999999999' },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).caller_surface_ref, null);
});

test('list without env reports null caller and host paths', async () => {
  await snapshot('list-no-env', await runCli(['list', '--json'], { client: fixtureClient() }));
});

test('unknown command output', async () => {
  await snapshot('unknown-command', await runCli(['wat']));
});

test('missing control endpoint output', async () => {
  await snapshot('missing-control-endpoint', await runCli(['list']));
});

test('ensure missing command output', async () => {
  await snapshot('ensure-missing-command', await runCli(['ensure'], { client: fixtureClient() }));
});

test('split conflicting direction output', async () => {
  await snapshot('split-conflicting-direction', await runCli(['split', '--left', '--right'], { client: fixtureClient() }));
});
