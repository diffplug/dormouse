import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../dist/cli.js';
import { buildShellCommandForKind, shellCommandKind } from '../dist/commands/shell-quote.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const snapshotsDir = join(__dirname, 'snapshots');
const updateSnapshots = process.env.UPDATE_SNAPSHOTS === '1';

const fixtureSurfaces = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    ref: 'surface:1',
    paneRef: 'pane:1',
    type: 'terminal',
    title: 'dor list-pane-surfaces',
    focused: true,
    index: 0,
    indexInPane: 0,
    selectedInPane: true,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    ref: 'surface:2',
    paneRef: 'pane:2',
    type: 'terminal',
    title: 'repo "watch"',
    focused: false,
    index: 1,
    indexInPane: 0,
    selectedInPane: true,
  },
];

function fixtureClient(surfacesFixture = fixtureSurfaces) {
  return {
    requests: [],
    async listSurfaces(request) {
      this.requests.push(request);
      const focusedPaneRef = surfacesFixture.find((surface) => surface.focused)?.paneRef;
      const paneTarget = request.pane === 'focused' ? focusedPaneRef : request.pane;
      const surfaces = paneTarget
        ? surfacesFixture.filter((surface) => (
          surface.paneRef === paneTarget ||
          surface.ref === paneTarget ||
          surface.id === paneTarget
        ))
        : surfacesFixture;
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
      const command = buildShellCommandForKind('posix', request.command);
      const title = request.title ?? command;
      return {
        status: title === 'dev server' ? 'existing' : 'created',
        surfaceId: '33333333-3333-4333-8333-333333333333',
        surfaceRef: 'surface:3',
        title,
        command,
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
  };
}

async function snapshot(name, result) {
  const actual = [
    `exitCode: ${result.exitCode}`,
    'stdout:',
    result.stdout,
    'stderr:',
    result.stderr,
  ].join('\n');
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
    await runCli(['ensure', '--title', 'dev server', '--', 'pnpm', 'dev:workspace'], { client: fixtureClient() }),
  );
});

test('ensure sends command argv to the host', async () => {
  const client = fixtureClient();
  await runCli(['ensure', '--title', 'worker', '--', 'pnpm', 'dev'], { client });
  assert.deepEqual(client.requests, [{
    method: 'ensureSurface',
    request: {
      command: ['pnpm', 'dev'],
      minimized: false,
      surface: undefined,
      title: 'worker',
    },
  }]);
});

test('ensure json output', async () => {
  await snapshot(
    'ensure-json',
    await runCli(['ensure', '--json', '--minimize', '--', 'pnpm', 'dev:workspace'], { client: fixtureClient() }),
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

test('send text output', async () => {
  await snapshot(
    'send-text',
    await runCli(['send', '--surface', 'surface:2', 'echo hello\\n'], { client: fixtureClient() }),
  );
});

test('send sends escaped text to the host', async () => {
  const client = fixtureClient();
  await runCli(['send', '--text', 'echo hello\\n'], { client });
  assert.deepEqual(client.requests, [{
    method: 'sendSurface',
    request: {
      surface: undefined,
      input: 'echo hello\n',
      inputCount: 1,
    },
  }]);
});

test('send sends key input to the host', async () => {
  const client = fixtureClient();
  await runCli(['send', '--surface', 'surface:2', '--key', 'ctrl-c'], { client });
  assert.deepEqual(client.requests, [{
    method: 'sendSurface',
    request: {
      surface: 'surface:2',
      input: '\x03',
      inputCount: 1,
    },
  }]);
});

test('send sequence sends ordered input to the host', async () => {
  const client = fixtureClient();
  await runCli(['send', '--sequence', '[{"text":"npm test"},{"key":"enter"}]'], { client });
  assert.deepEqual(client.requests, [{
    method: 'sendSurface',
    request: {
      surface: undefined,
      input: 'npm test\r',
      inputCount: 2,
    },
  }]);
});

test('send stdin sends standard input to the host', async () => {
  const client = fixtureClient();
  await runCli(['send', '--stdin'], { client, readStdin: async () => 'cat from stdin\n' });
  assert.deepEqual(client.requests, [{
    method: 'sendSurface',
    request: {
      surface: undefined,
      input: 'cat from stdin\n',
      inputCount: 1,
    },
  }]);
});

test('send missing input output', async () => {
  await snapshot('send-missing-input', await runCli(['send'], { client: fixtureClient() }));
});

test('send unsupported key output', async () => {
  await snapshot('send-unsupported-key', await runCli(['send', '--key', 'cmd-k'], { client: fixtureClient() }));
});

test('read text output', async () => {
  await snapshot('read-text', await runCli(['read'], { client: fixtureClient() }));
});

test('read sends request to the host', async () => {
  const client = fixtureClient();
  await runCli(['read', '--surface', 'title:repo "watch"', '--scrollback', '--lines', '2'], { client });
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
    await runCli(['read', '--json', '--surface', 'surface:2', '--scrollback', '--lines', '2'], { client: fixtureClient() }),
  );
});

test('read invalid lines output', async () => {
  await snapshot('read-invalid-lines', await runCli(['read', '--lines', '0'], { client: fixtureClient() }));
});

test('kill text output', async () => {
  await snapshot(
    'kill-text',
    await runCli(['kill', '--surface', 'surface:2', '--confirm-dangerously'], { client: fixtureClient() }),
  );
});

test('kill sends confirmation to the host', async () => {
  const client = fixtureClient();
  await runCli(['kill', '--surface', 'title:repo "watch"', '--confirm-if-read', 'done'], { client });
  assert.deepEqual(client.requests, [{
    method: 'killSurface',
    request: {
      confirmation: { mode: 'if-read', text: 'done' },
      surface: 'title:repo "watch"',
    },
  }]);
});

test('kill missing confirmation output', async () => {
  await snapshot('kill-missing-confirmation', await runCli(['kill', '--surface', 'surface:2'], { client: fixtureClient() }));
});

test('kill short confirm-if-read output', async () => {
  await snapshot(
    'kill-short-confirm-if-read',
    await runCli(['kill', '--surface', 'surface:2', '--confirm-if-read', 'abc'], { client: fixtureClient() }),
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
  await snapshot('iframe-invalid-url', await runCli(['iframe', 'localhost:5173'], { client: fixtureClient() }));
});

test('list-panes text output', async () => {
  await snapshot('list-panes-text', await runCli(['list-panes'], { client: fixtureClient() }));
});

test('list-panes id-format both output', async () => {
  await snapshot(
    'list-panes-id-format-both',
    await runCli(['list-panes', '--id-format', 'both'], { client: fixtureClient() }),
  );
});

test('list-panes json output', async () => {
  await snapshot(
    'list-panes-json',
    await runCli(['list-panes', '--json'], { client: fixtureClient() }),
  );
});

test('list-pane-surfaces pane-scoped output', async () => {
  const client = fixtureClient();
  const result = await runCli(['list-pane-surfaces'], { client });
  assert.deepEqual(client.requests, [{ pane: 'focused' }]);
  await snapshot('list-pane-surfaces-text', result);
});

test('list-pane-surfaces id-format both output', async () => {
  await snapshot(
    'list-pane-surfaces-id-format-both',
    await runCli(['list-pane-surfaces', '--id-format', 'both'], { client: fixtureClient() }),
  );
});

test('list-pane-surfaces json output', async () => {
  await snapshot(
    'list-pane-surfaces-json',
    await runCli(['list-pane-surfaces', '--json'], { client: fixtureClient() }),
  );
});

test('unknown command output', async () => {
  await snapshot('unknown-command', await runCli(['wat']));
});

test('missing control endpoint output', async () => {
  await snapshot('missing-control-endpoint', await runCli(['list-panes']));
});

test('ensure missing command output', async () => {
  await snapshot('ensure-missing-command', await runCli(['ensure'], { client: fixtureClient() }));
});

test('split conflicting direction output', async () => {
  await snapshot('split-conflicting-direction', await runCli(['split', '--left', '--right'], { client: fixtureClient() }));
});
