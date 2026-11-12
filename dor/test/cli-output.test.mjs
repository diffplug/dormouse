import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../dist/cli.js';
import { NODE_HOST } from '../dist/node-host.js';
import { buildShellCommandForKind, shellCommandKind } from '../dist/commands/shell-quote.js';
import { browserBinaryIsMissing as agentBrowserIsMissing, binaryCandidateNames, isExecutableFile } from 'dor-lib-common';
import { extractSessionFlags } from '../dist/commands/browser-cli.js';
import { msysToWindowsCwd } from '../dist/commands/shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const snapshotsDir = join(__dirname, 'snapshots');
const updateSnapshots = process.env.UPDATE_SNAPSHOTS === '1';

// The markdown the prebuild codegen inlines into the CLI; `dor skill` must print it verbatim.
const skillMarkdown = await readFile(join(__dirname, '..', 'skill.md'), 'utf8');

// Run against a throwaway directory, cleaned up after. The skill --install
// tests pass it to the CLI as its PWD; the agent-browser PATH-resolution test
// drops a fake binary in it.
async function withTempDir(prefix, run) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fixtureSurfaces = [
  {
    id: 'surface:1',
    kind: 'terminal',
    renderMode: null,
    title: 'pnpm dev',
    focused: true,
    view: 'paned',
    cwd: '/Users/me/projects/site',
    activity: 'running',
    command: 'pnpm dev',
    commandLine: 'pnpm dev',
    url: null,
    ringing: false,
    todo: false,
    awaited: false,
  },
  {
    id: 'surface:2',
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
    awaited: true,
  },
  {
    id: 'surface:3',
    kind: 'browser',
    renderMode: 'agent-browser-screencast',
    title: 'Dormouse',
    focused: false,
    view: 'paned',
    cwd: null,
    activity: null,
    command: null,
    url: 'http://localhost:5173/',
    ringing: false,
    todo: false,
    awaited: false,
  },
  {
    id: 'surface:4',
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
    awaited: false,
  },
];

// The Window's Workspaces, as the host projects them for `--workspaces` and for
// the `--all` group headers.
const fixtureWorkspaces = [
  { id: 'workspace:1', name: 'Workspace 1', auto: true, pinned: false, active: true, ringing: false, todo: false, count: 0 },
  { id: 'workspace:2', name: 'build', auto: false, pinned: true, active: false, ringing: true, todo: true, count: 2 },
];

// Listening ports the host would attach to a terminal Surface for `--ports`.
const fixturePortsById = {
  'surface:1': [{ family: 'IPv4', address: '0.0.0.0', port: 5173, pid: 4242, processName: 'node' }],
  'surface:4': [{ family: 'IPv6', address: '::1', port: 8080, pid: 5151, processName: 'python' }],
};

/** The Workspace an explicit id or name reference targets in the fixture, the way the
 *  host resolves one — its id, bare number, or exact name. */
function fixtureWorkspace(target) {
  const text = String(target);
  return fixtureWorkspaces.find(row => text.startsWith('workspace-name:') ? row.name === text.slice(15) : row.id === text) ?? fixtureWorkspaces[0];
}

/** The `surface.browser` request a `dor agent-browser` run made, if it opened one at
 *  all: every run now asks the host to name its session first, so the surface
 *  call is never the first entry. */
function surfaceRequest(client) {
  return client.requests.find((entry) => entry.method === 'browserSurface')?.request;
}

/** What a `dor agent-browser` run in this process offers for a key's first binding. */
const proposedHere = { cwd: process.cwd() };

function fixtureClient(surfacesFixture = fixtureSurfaces) {
  return {
    requests: [],
    async listSurfaces(request) {
      this.requests.push(request);
      // Mirror the host's cross-Workspace listing: every Workspace's rows in
      // one list, each tagged with the Workspace it came from, plus the
      // directory the CLI renders headers from.
      if (request.scope === 'all') {
        return {
          surfaces: [
            { ...fixtureSurfaces[0], workspaceId: 'workspace:1' },
            { ...fixtureSurfaces[2], workspaceId: 'workspace:2' },
            { ...fixtureSurfaces[3], workspaceId: 'workspace:2' },
          ],
          workspaces: fixtureWorkspaces,
          windowRef: 'window:1',
          workspaceId: 'workspace:1',
        };
      }
      // Mirror the host: attach listening ports to terminal Surfaces on request.
      const surfaces = request.includePorts
        ? surfacesFixture.map((surface) => (surface.kind === 'terminal'
          ? { ...surface, ports: fixturePortsById[surface.id] ?? [] }
          : surface))
        : surfacesFixture;
      return {
        surfaces,
        windowRef: 'window:1',
        workspaceId: 'workspace:1',
      };
    },
    async splitSurface(request) {
      this.requests.push({ method: 'splitSurface', request });
      // Mirror the real host: quote the argv for the target (here, posix) shell.
      const command = request.command ? buildShellCommandForKind('posix', request.command) : undefined;
      return {
        status: 'created', commandState: 'unconfirmed',
        surfaceId: 'surface:3',
        direction: request.direction === 'auto' ? 'right' : request.direction,
        minimized: request.minimized,
        ...(command ? { command } : {}),
      };
    },
    // An approved project and a user file; the user `storybook` is hidden by
    // the project's, `pridm` is imported, and `prs` an import that is broken.
    // `--global` answers the user file alone, as the host does.
    async toolList(request) {
      this.requests.push({ method: 'toolList', request });
      const user = [
        { name: 'storybook', scope: 'user', run: 'npx storybook', render: 'iframe', port: 'auto', keyed: false, description: null, shadowed: !request.global },
        { name: 'md', scope: 'user', run: ['glow', '$TARGET'], render: 'iframe', port: 'announced', keyed: true, description: 'Render Markdown.', shadowed: false },
        { name: 'pridm', scope: 'user', run: ['node', '$HERE/main.js'], render: 'iframe', port: 'auto', keyed: false, description: 'PR dashboard.', shadowed: false, from: '/home/me/.config/dormouse/pridm/dormouse.yml' },
        { name: 'prs', scope: 'user', description: null, shadowed: false, from: '/home/me/.config/dormouse/supertools/dormouse.yml', broken: '/home/me/.config/dormouse/supertools/dormouse.yml: not found' },
      ];
      return {
        project: request.global ? null : { path: '/work/site/dormouse.yml', approved: true },
        user: { path: '/home/me/.config/dormouse/dormouse.yml', found: true },
        tools: [
          ...(request.global ? [] : [
            { name: 'storybook', scope: 'project', run: 'pnpm storybook', render: 'iframe', port: 'auto', keyed: true, description: 'The component catalog.\n\nView only.', shadowed: false },
            { name: 'harness', scope: 'project', run: 'pnpm harness', render: 'agent-browser-screencast', port: 'announced', keyed: true, description: null, shadowed: false },
          ]),
          ...user,
        ],
        warnings: request.global ? [] : ['/work/site/dormouse.yml: tools.harness: ignoring unknown field \'colour\''],
      };
    },
    async toolSurface(request) {
      this.requests.push({ method: 'toolSurface', request });
      // Mirror the host: a named tool renders from the (fixture) registry, a
      // `--` tail is quoted argv. `storybook` is the keyed entry, so it is the
      // one that can come back as an existing match.
      const named = typeof request.name === 'string';
      const command = named
        ? `pnpm ${request.name}`
        : request.file ? `viewer ${request.file}` : buildShellCommandForKind('posix', request.command);
      const keyed = named && request.name === 'storybook' && !request.fresh;
      return {
        status: keyed ? 'existing' : 'created',
        commandState: keyed ? 'running' : 'unconfirmed',
        surfaceId: 'surface:4',
        command,
        cwd: request.cwd,
        minimized: request.minimized,
        key: keyed ? ['storybook', '/work/site'] : null,
        ...(named && request.name === 'noisy' ? { warnings: ['dormouse.yml: tools.noisy: ignoring unknown field \'colour\''] } : {}),
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
        commandState: isExisting ? 'running' : 'unconfirmed',
        surfaceId: 'surface:3',
        command,
        cwd: request.cwd,
        minimized: request.minimized,
      };
    },
    async sendSurface(request) {
      this.requests.push({ method: 'sendSurface', request });
      return {
        status: 'sent',
        surfaceId: request.surface === 'surface:2' ? 'surface:2' : 'surface:1',
        inputCount: request.events.length,
      };
    },
    async readSurface(request) {
      this.requests.push({ method: 'readSurface', request });
      const text = request.scrollback
        ? 'first line\nsecond line\nthird line\nfourth line'
        : 'visible one\nvisible two';
      const limited = request.lines ? text.split('\n').slice(-request.lines).join('\n') : text;
      return {
        workspaceId: 'workspace:1',
        surfaceId: request.surface === 'surface:2' ? 'surface:2' : 'surface:1',
        text: limited,
      };
    },
    async killSurface(request) {
      this.requests.push({ method: 'killSurface', request });
      return {
        status: 'killed',
        surfaceId: request.surface === 'surface:2' ? 'surface:2' : 'surface:1',
      };
    },
    async iframeSurface(request) {
      this.requests.push({ method: 'iframeSurface', request });
      return {
        status: request.surface === 'surface:1' ? 'replaced' : 'created',
        surfaceId: request.surface === 'surface:1' ? 'surface:1' : 'surface:3',
        url: request.url,
        minimized: request.minimized,
      };
    },
    async browserSurface(request) {
      this.requests.push({ method: 'browserSurface', request });
      return {
        status: 'created',
        surfaceId: 'surface:3',
        session: request.session,
        minimized: false,
      };
    },
    // Mirrors the host's session↔surface registry: surface:3 is bound to a
    // GUI-minted session, surface:1 is a terminal and fails the host's gate.
    // Which gate rejected is the host's business (asserted in Wall.test.tsx);
    // the CLI has one catch and prints whatever comes back.
    async resolveBrowser(request) {
      this.requests.push({ method: 'resolveBrowser', request });
      // A managed key no Surface holds is the answering Workspace's session,
      // so the same key in `build` is another browser entirely.
      if (request.key !== undefined) {
        const workspace = fixtureWorkspaces.find((row) => (
          request.workspace === `workspace-name:${row.name}` || request.workspace === row.id
        ));
        // `sessionForKey` scrubs the id's colon: a session name is a socket path.
        return { binding: { session: `dormouse.${workspace ? workspace.id.replace(':', '-') : '1'}.${request.key}`, ...request.proposed } };
      }
      if (request.surface === 'surface:1') {
        throw new Error("surface 'surface:1' has no browser (kind: terminal)");
      }
      return { binding: { session: 'dormouse.1.gui-a1b2c3' } };
    },
    async listWorkspaces(request) {
      this.requests.push({ method: 'listWorkspaces', request });
      return { workspaces: fixtureWorkspaces, windowRef: 'window:1' };
    },
    async newWorkspace(request) {
      this.requests.push({ method: 'newWorkspace', request });
      return {
        status: 'created',
        workspaceId: 'workspace:3',
        name: request.name ?? 'Workspace 3',
      };
    },
    async renameWorkspace(request) {
      this.requests.push({ method: 'renameWorkspace', request });
      // Mirror the host: the answer names the Workspace the target resolved to,
      // so a test can tell a forwarded target from an ignored one.
      const target = fixtureWorkspace(request.workspace);
      return { status: 'renamed', workspaceId: target.id, name: request.name };
    },
    async closeWorkspace(request) {
      this.requests.push({ method: 'closeWorkspace', request });
      // Mirror the host: a Workspace holding work refuses without --force.
      if (!request.force) {
        throw new Error("workspace 'workspace:2' holds Surfaces Reopen cannot restore; pass --force to close it");
      }
      return { status: 'closed', workspaceId: 'workspace:2', name: 'build' };
    },
    async switchWorkspace(request) {
      this.requests.push({ method: 'switchWorkspace', request });
      const target = fixtureWorkspace(request.workspace);
      return { status: 'active', workspaceId: target.id, name: target.name };
    },
    async pinWorkspace(request) {
      this.requests.push({ method: 'pinWorkspace', request });
      const target = fixtureWorkspace(request.workspace);
      return { status: request.pinned ? 'pinned' : 'unpinned', workspaceId: target.id, name: target.name };
    },
    async moveWorkspace(request) {
      this.requests.push({ method: 'moveWorkspace', request });
      const target = fixtureWorkspace(request.workspace);
      return { status: 'moved', workspaceId: target.id, name: target.name };
    },
    async restartApp() {
      this.requests.push({ method: 'restartApp' });
      return { relaunch: true };
    },
    async reopenClosed() {
      this.requests.push({ method: 'reopenClosed' });
      return { status: 'reopened', kind: 'surface', surfaceId: 'surface:4' };
    },
    async resolveOpenTarget(request) {
      this.requests.push({ method: 'resolveOpenTarget', request });
      // Mirror the host: surface:1 owns port 5173; surface:2 owns nothing.
      if (request.surface === 'surface:2') {
        throw new Error("surface 'surface:2' is not serving any port");
      }
      return {
        surfaceId: 'surface:1',
        port: 5173,
        url: 'http://localhost:5173/',
      };
    },
  };
}

// `dor await` only ever calls awaitSurface, so a canned outcome is the whole fake.
// The host owns waitedMs, so the CLI's duration rendering is entirely a function
// of what the fake hands back.
function awaitClient(outcome) {
  return {
    requests: [],
    async awaitSurface(request) {
      this.requests.push({ method: 'awaitSurface', request });
      return {
        workspaceId: 'workspace:1',
        surfaceId: 'surface:3',
        waitedMs: 0,
        ...outcome,
      };
    },
  };
}

// Windows resolves a path case-insensitively and `which` returns the extension
// as PATHEXT spells it, not as the file on disk does — so a `.cmd` install is
// legitimately reported as `...\\agent-browser.CMD`. Compare accordingly there.
function assertSamePath(actual, expected, message) {
  if (process.platform === 'win32') {
    assert.equal(String(actual).toLowerCase(), expected.toLowerCase(), message);
  } else {
    assert.equal(actual, expected, message);
  }
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
  assert.equal(shellCommandKind(undefined, 'Windows'), 'cmd');
  assert.equal(shellCommandKind(undefined, 'Win32'), 'cmd');
  assert.equal(shellCommandKind('/bin/zsh', 'darwin'), 'posix');
  assert.equal(shellCommandKind(undefined, 'darwin'), 'posix');
  assert.equal(shellCommandKind('C:\\Program Files\\Git\\bin\\bash.exe', 'win32'), 'posix');
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
    buildShellCommandForKind('powershell', ['Write-Output', '@args']),
    "Write-Output '@args'",
  );
  assert.equal(
    buildShellCommandForKind('cmd', ['C:\\Program Files\\nodejs\\node.exe', '-e', 'console.log(process.argv[1])', 'hello world', 'a&b']),
    '"C:\\Program Files\\nodejs\\node.exe" -e "console.log(process.argv[1])" "hello world" "a&b"',
  );
  // `,` and `@` were dropped from the shared WINDOWS_SAFE_ARG for PowerShell's
  // array operator and splatting; cmd.exe reads `,` as an argument separator and
  // a leading `@` as echo suppression, so quoting them here is wanted too.
  assert.equal(
    buildShellCommandForKind('cmd', ['type', 'a,b.txt', '@echo.txt']),
    'type "a,b.txt" "@echo.txt"',
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
      cwd: process.cwd(),
      minimized: false,
      focus: false,
      surface: undefined,
    },
  }]);
});

test('Surface-producing commands always send focus, true only with --focus', async () => {
  for (const args of [['split'], ['split', '--'], ['split', '--', 'echo', 'hi'], ['ensure', '--', 'echo', 'hi'], ['iframe', ':5173'], ['tool', '--', 'echo'], ['open', 'a.md']]) {
    // Absent, it is sent false: only the webview's own requests omit it.
    const unstated = fixtureClient();
    const result = await runCli(args, { client: unstated });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(unstated.requests.at(-1).request.focus, false, args.join(' '));
    for (const [flag, focus] of [['--focus', true], ['--focus=true', true], ['--focus=false', false]]) {
      const stated = fixtureClient();
      const statedResult = await runCli([args[0], flag, ...args.slice(1)], { client: stated });
      assert.equal(statedResult.exitCode, 0, JSON.stringify(statedResult));
      assert.equal(stated.requests.at(-1).request.focus, focus, `${flag} ${args.join(' ')}`);
    }
    // Only an explicit --focus contradicts --minimize; --focus=false agrees with it.
    const conflict = fixtureClient();
    const refused = await runCli([args[0], '--focus', '--minimize', ...args.slice(1)], { client: conflict });
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, /--focus and --minimize are mutually exclusive/);
    assert.equal(conflict.requests.length, 0);
    const agreed = fixtureClient();
    assert.equal((await runCli([args[0], '--focus=false', '--minimize', ...args.slice(1)], { client: agreed })).exitCode, 0);
    assert.equal(agreed.requests.at(-1).request.focus, false);
  }
});

test('split takes its initial command only after --, before any request', async () => {
  for (const argv of [['split', 'echo', 'hello'], ['split', '--right', 'echo', '--', 'hello']]) {
    const client = fixtureClient();
    const result = await runCli(argv, { client });
    assert.equal(result.exitCode, 1, argv.join(' '));
    assert.equal(result.stderr, "Error: unexpected argument 'echo' before --\n");
    assert.deepEqual(client.requests, []);
  }
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
      focus: false,
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
  // At a drive root Git Bash exports `/c`, with no trailing slash.
  assert.equal(msysToWindowsCwd('/c', 'win32'), 'C:\\');
  assert.equal(msysToWindowsCwd('/c/', 'win32'), 'C:\\');
  // Already-native paths (some MSYS builds export `C:/...`) and non-win32
  // platforms are left for resolvePath to handle.
  assert.equal(msysToWindowsCwd('C:/Users/me/site', 'win32'), 'C:/Users/me/site');
  assert.equal(msysToWindowsCwd('/c/Users/me/site', 'linux'), '/c/Users/me/site');
});

/** A host on which every `--cwd` these fixtures name exists. */
const anyDirectoryHost = { ...NODE_HOST, isDirectory: () => true };

test('ensure and tool refuse a --cwd that names no directory, launching nothing', async () => {
  const missing = join(tmpdir(), 'dor-no-such-directory');
  for (const argv of [['ensure', '--cwd', missing, '--', 'npm', 'install'], ['tool', '--cwd', missing, '--', 'npm', 'install']]) {
    const client = fixtureClient();
    const result = await runCli(argv, { client });
    assert.equal(result.exitCode, 1, argv[0]);
    assert.match(result.stderr, /dor-no-such-directory' does not exist/, argv[0]);
    assert.deepEqual(client.requests, [], argv[0]);
  }
});

test('ensure and tool accept --flag=value before --, as stricli does', async () => {
  const ensure = fixtureClient();
  const ensured = await runCli(['ensure', '--cwd=/work/other', '--from=surface:3', '--', 'pnpm', 'dev'], { client: ensure, env: { PWD: '/work/site' }, host: anyDirectoryHost });
  assert.equal(ensured.exitCode, 0, ensured.stderr);
  assert.equal(smudgeWindowsPaths(ensure.requests[0].request.cwd), '/work/other');
  assert.equal(ensure.requests[0].request.surface, 'surface:3');

  for (const tail of [['storybook'], ['--', 'pnpm', 'dev']]) {
    const client = fixtureClient();
    const result = await runCli(['tool', '--workspace=workspace:2', ...tail], { client, env: { PWD: '/work/site' } });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(client.requests[0].request.workspace, 'workspace:2');
  }

  // A boolean's value too, which `--focus=false` needs; stricli parses it.
  for (const head of [['ensure', '--json=true'], ['tool', '--json=true', 'storybook']]) {
    const boolean = await runCli([...head, ...(head[0] === 'ensure' ? ['--', 'pnpm', 'dev'] : [])], { client: fixtureClient(), env: { PWD: '/work/site' } });
    assert.equal(boolean.exitCode, 0, boolean.stderr);
    assert.match(boolean.stdout, /^\{/, head.join(' '));
  }
  const unknown = await runCli(['ensure', '--jsn=true', '--', 'pnpm', 'dev'], { client: fixtureClient(), env: { PWD: '/work/site' } });
  assert.equal(unknown.stderr, "Error: unknown option '--jsn=true'\n");
});

test('an empty --cwd is a missing value, never the caller\'s directory', async () => {
  // `dor ensure --cwd "$BUILD_DIR" -- make clean` with BUILD_DIR unset must not run in PWD.
  const commands = [['ensure', '--', 'pnpm', 'dev'], ['tool', 'storybook'], ['tool', '--list'], ['open', 'notes.md'], ['list']];
  for (const [name, ...rest] of commands) {
    for (const cwd of [['--cwd='], ['--cwd', '']]) {
      const argv = [name, ...cwd, ...rest];
      const client = fixtureClient();
      const result = await runCli(argv, { client, env: { PWD: '/work/site' }, host: anyDirectoryHost });
      assert.equal(result.stderr, 'Error: --cwd requires a value\n', JSON.stringify(argv));
      assert.equal(result.exitCode, 1, JSON.stringify(argv));
      assert.deepEqual(client.requests, [], JSON.stringify(argv));
    }
  }
});

test('ensure json output', async () => {
  await snapshot(
    'ensure-json',
    await runCli(['ensure', '--json', '--minimize', '--cwd', '/Users/me/projects/site', '--', 'pnpm', 'dev'], {
      client: fixtureClient(),
      host: anyDirectoryHost,
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

test('version names an unknown count past the tag rather than reading it as zero', async () => {
  const versionMetadata = { version: '0.12.0', commit: '6e86b3ba', commitsSinceVersion: null };
  assert.equal((await runCli(['version'], { versionMetadata })).stdout, 'dor 0.12.0 [6e86b3ba] (0.12.0+?)\n');
  assert.equal(JSON.parse((await runCli(['version', '--json'], { versionMetadata })).stdout).build, '0.12.0+?');
});

test('skill prints the bundled markdown verbatim', async () => {
  const result = await runCli(['skill']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, skillMarkdown);
});

test('skill --json wraps the markdown', async () => {
  const result = await runCli(['skill', '--json']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).markdown, skillMarkdown);
});

test('skill --install creates AGENTS.md when neither file exists', async () => {
  await withTempDir('dor-skill-', async (dir) => {
    const result = await runCli(['skill', '--install'], { env: { PWD: dir } });
    await snapshot('skill-install-created', result);
    const content = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(content.startsWith('<!-- dor-skill:begin'));
    assert.ok(content.endsWith('<!-- dor-skill:end -->\n'));
    assert.match(content, /DORMOUSE_SURFACE_ID/);
  });
});

test('skill --install appends to an existing AGENTS.md and stays idempotent', async () => {
  await withTempDir('dor-skill-', async (dir) => {
    const agentsPath = join(dir, 'AGENTS.md');
    await writeFile(agentsPath, '# My project\n\nSome existing guidance.\n');
    const first = await runCli(['skill', '--install'], { env: { PWD: dir } });
    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, '');
    assert.equal(first.stdout, 'updated AGENTS.md\n');
    const afterFirst = await readFile(agentsPath, 'utf8');
    assert.ok(afterFirst.startsWith('# My project\n\nSome existing guidance.\n\n<!-- dor-skill:begin'));
    assert.ok(afterFirst.endsWith('<!-- dor-skill:end -->\n'));

    // Re-running rewrites the block in place, leaving the file byte-identical.
    const second = await runCli(['skill', '--install'], { env: { PWD: dir } });
    assert.equal(second.stdout, 'updated AGENTS.md\n');
    assert.equal(await readFile(agentsPath, 'utf8'), afterFirst);
  });
});

test('skill --install writes to CLAUDE.md when it is the only instructions file', async () => {
  await withTempDir('dor-skill-', async (dir) => {
    const claudePath = join(dir, 'CLAUDE.md');
    await writeFile(claudePath, '# Claude guidance\n');
    const result = await runCli(['skill', '--install'], { env: { PWD: dir } });
    assert.equal(result.stdout, 'updated CLAUDE.md\n');
    assert.match(await readFile(claudePath, 'utf8'), /<!-- dor-skill:begin/);
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
  });
});

test('skill --install creates AGENTS.md when CLAUDE.md imports it', async () => {
  await withTempDir('dor-skill-', async (dir) => {
    const claudePath = join(dir, 'CLAUDE.md');
    const claudeBody = '# Claude guidance\n\n@AGENTS.md\n';
    await writeFile(claudePath, claudeBody);
    const result = await runCli(['skill', '--install'], { env: { PWD: dir } });
    assert.equal(result.stdout, 'created AGENTS.md\n');
    assert.match(await readFile(join(dir, 'AGENTS.md'), 'utf8'), /<!-- dor-skill:begin/);
    assert.equal(await readFile(claudePath, 'utf8'), claudeBody);
  });
});

test('skill --install rewrites the block in place, preserving surrounding text', async () => {
  await withTempDir('dor-skill-', async (dir) => {
    const agentsPath = join(dir, 'AGENTS.md');
    const before = '# Top matter\n\n';
    const staleBlock = '<!-- dor-skill:begin — stale -->\nold body\n<!-- dor-skill:end -->';
    const after = '\n\n## Footer\n';
    await writeFile(agentsPath, before + staleBlock + after);
    const result = await runCli(['skill', '--install'], { env: { PWD: dir } });
    assert.equal(result.stdout, 'updated AGENTS.md\n');
    const content = await readFile(agentsPath, 'utf8');
    assert.ok(content.startsWith(before));
    assert.ok(content.endsWith(after));
    assert.doesNotMatch(content, /old body/);
    assert.match(content, /DORMOUSE_SURFACE_ID/);
    assert.equal(content.match(/<!-- dor-skill:begin/g).length, 1);
    assert.equal(content.match(/dor-skill:end -->/g).length, 1);
  });
});

test('skill --install --json reports status and file', async () => {
  await withTempDir('dor-skill-', async (dir) => {
    const result = await runCli(['skill', '--install', '--json'], { env: { PWD: dir } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { status: 'created', file: 'AGENTS.md' });
  });
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

test('send sends literal text to the host', async () => {
  const client = fixtureClient();
  await runCli(['send', 'surface:1', '--text', 'echo hello\\n'], { client });
  assert.deepEqual(client.requests, [{
    method: 'sendSurface',
    request: {
      surface: 'surface:1',
      events: [{ text: 'echo hello\\n' }],
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
      events: [{ key: 'ctrl-c' }],
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
      events: [{ text: 'npm test' }, { key: 'enter' }],
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
      events: [{ text: 'npm test' }, { key: 'enter' }],
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
      events: [{ text: 'cat from stdin\n' }],
    },
  }]);
});

test('send stdin keeps backslash sequences literal', async () => {
  const client = fixtureClient();
  const script = 'printf "a\\tb\\n" C:\\\\tmp\n';
  await runCli(['send', 'surface:1', '--stdin'], { client, readStdin: async () => script });
  assert.deepEqual(client.requests[0].request.events, [{ text: script }]);
});

test('send sequence text is not escape-decoded a second time', async () => {
  const client = fixtureClient();
  await runCli(['send', 'surface:1', '--sequence', '[{"text":"a\\\\tb"},{"text":"c\\td"}]'], { client });
  assert.deepEqual(client.requests[0].request.events, [{ text: 'a\\tb' }, { text: 'c\td' }]);
});

test('send refuses the retired raw flag', async () => {
  const client = fixtureClient();
  const result = await runCli(['send', 'surface:1', '--raw', '--text', 'a\\tb'], { client });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--raw was removed/);
  assert.deepEqual(client.requests, []);
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

test('await prints the bare cause on stdout and the narrative on stderr', async () => {
  const result = await runCli(['await', 'surface:1', '--until', 'quiet'], {
    client: awaitClient({ outcome: 'resolved', cause: 'quiet', waitedMs: 615_000 }),
  });
  // The whole point of the split: `CAUSE=$(dor await ...)` captures `quiet`, and
  // nothing else, however chatty stderr gets.
  assert.equal(result.stdout, 'quiet\n');
  assert.equal(result.stderr, 'quiet: output stopped after 10m 15s\n');
  assert.equal(result.exitCode, 0);
  await snapshot('await-text', result);
});

test('await json output', async () => {
  await snapshot('await-json', await runCli(['await', 'surface:3', '--until', 'quiet', '--json'], {
    client: awaitClient({ outcome: 'resolved', cause: 'quiet', waitedMs: 615_000 }),
  }));
});

test('await narrates every cause', async () => {
  const cases = [
    ['exit', { outcome: 'resolved', cause: 'exit', waitedMs: 182_000 }, 'exit: command exited after 3m 02s\n'],
    ['quiet', { outcome: 'resolved', cause: 'bell', waitedMs: 45_000 }, 'bell: surface rang after 45s\n'],
    ['quiet', { outcome: 'resolved', cause: 'idle', waitedMs: 2_000 }, 'idle: no output within 2s, nothing was running\n'],
    ['exit', { outcome: 'resolved', cause: 'idle', waitedMs: 2_000 }, 'idle: no command started within 2s\n'],
  ];
  for (const [until, outcome, stderr] of cases) {
    const result = await runCli(['await', 'surface:1', '--until', until], { client: awaitClient(outcome) });
    assert.equal(result.stdout, `${outcome.cause}\n`);
    assert.equal(result.stderr, stderr);
    assert.equal(result.exitCode, 0);
  }
});

test('await formats durations', async () => {
  const cases = [[0, '0s'], [59_999, '59s'], [60_000, '1m 00s'], [615_000, '10m 15s']];
  for (const [waitedMs, rendered] of cases) {
    const result = await runCli(['await', 'surface:1', '--until', 'quiet'], {
      client: awaitClient({ outcome: 'resolved', cause: 'quiet', waitedMs }),
    });
    assert.equal(result.stderr, `quiet: output stopped after ${rendered}\n`);
  }
});

test('await times out with exit 2 and an empty stdout', async () => {
  const timedOut = await runCli(['await', 'surface:5', '--until', 'quiet'], {
    client: awaitClient({ outcome: 'timeout', waitedMs: 600_000 }),
  });
  assert.equal(timedOut.exitCode, 2);
  assert.equal(timedOut.stdout, '');
  await snapshot('await-timeout', timedOut);

  // --until exit names the condition it gave up on, and the reported seconds are
  // the --timeout value as given rather than the measured wait.
  await snapshot('await-timeout-exit', await runCli(['await', 'surface:5', '--until', 'exit', '--timeout', '30'], {
    client: awaitClient({ outcome: 'timeout', waitedMs: 30_000 }),
  }));

  // JSON failures carry a machine-readable verdict as well as exit status.
  await snapshot('await-timeout-json', await runCli(['await', 'surface:5', '--until', 'quiet', '--json'], {
    client: awaitClient({ outcome: 'timeout', waitedMs: 600_000 }),
  }));
});

test('await reports a dead surface with exit 3', async () => {
  const died = await runCli(['await', 'surface:5', '--until', 'exit'], {
    client: awaitClient({ outcome: 'died', waitedMs: 200_000 }),
  });
  assert.equal(died.exitCode, 3);
  assert.equal(died.stdout, '');
  await snapshot('await-died', died);
});

test('await sends the request to the host', async () => {
  const client = awaitClient({ outcome: 'resolved', cause: 'quiet', waitedMs: 0 });
  await runCli(['await', 'surface:2', '--until', 'exit'], { client });
  assert.deepEqual(client.requests, [{
    method: 'awaitSurface',
    request: { surface: 'surface:2', until: 'exit', timeoutMs: 600_000 },
  }]);

  const custom = awaitClient({ outcome: 'resolved', cause: 'quiet', waitedMs: 0 });
  await runCli(['await', 'surface:2', '--until', 'quiet', '--timeout', '30'], { client: custom });
  assert.equal(custom.requests[0].request.timeoutMs, 30_000);
});

test('await requires a valid --until', async () => {
  await snapshot('await-missing-until', await runCli(['await', 'surface:1'], { client: awaitClient({}) }));
  await snapshot('await-invalid-until', await runCli(['await', 'surface:1', '--until', 'soon'], { client: awaitClient({}) }));
});

test('await rejects a non-positive --timeout', async () => {
  await snapshot('await-invalid-timeout', await runCli(['await', 'surface:1', '--until', 'quiet', '--timeout', '0'], {
    client: awaitClient({}),
  }));
});

test('await accepts at most a 24-hour --timeout', async () => {
  const acceptedClient = awaitClient({ outcome: 'resolved', cause: 'quiet', waitedMs: 0 });
  const accepted = await runCli(['await', 'surface:1', '--until', 'quiet', '--timeout', '86400'], {
    client: acceptedClient,
  });
  assert.equal(accepted.exitCode, 0);
  assert.equal(acceptedClient.requests[0].request.timeoutMs, 86_400_000);

  const rejectedClient = awaitClient({});
  const rejected = await runCli(['await', 'surface:1', '--until', 'quiet', '--timeout', '86401'], {
    client: rejectedClient,
  });
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /invalid --timeout '86401'/);
  assert.deepEqual(rejectedClient.requests, []);
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

test('kill conflicting confirmation output', async () => {
  await snapshot(
    'kill-conflicting-confirmation',
    await runCli(
      ['kill', 'surface:2', '--confirm-dangerously', '--confirm-if-read', 'done'],
      { client: fixtureClient() },
    ),
  );
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
    await runCli(['iframe', '--from', 'surface:1', 'https://localhost:5173'], { client: fixtureClient() }),
  );
});

test('iframe sends request to the host', async () => {
  const client = fixtureClient();
  await runCli(['iframe', '--minimize', 'https://example.com/docs?x=1'], { client });
  assert.deepEqual(client.requests, [{
    method: 'iframeSurface',
    request: {
      minimized: true,
      focus: false,
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
    { method: 'iframeSurface', request: { focus: false, minimized: false, surface: undefined, url: 'http://localhost:5173/' } },
  ]);
});

test('iframe sugars a bare :port to a localhost URL without a host round trip', async () => {
  const client = fixtureClient();
  await runCli(['iframe', ':5173'], { client });
  assert.deepEqual(client.requests, [
    { method: 'iframeSurface', request: { focus: false, minimized: false, surface: undefined, url: 'http://localhost:5173/' } },
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
      { method: 'iframeSurface', request: { focus: false, minimized: false, surface: undefined, url } },
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
    await runCli(['agent-browser', 'open', 'http://localhost:5173'], { client: fixtureClient(), execAgentBrowser: ab.exec }),
  );
});

test('browser --focus belongs to dor anywhere before --, and is not forwarded to the provider', async () => {
  for (const [argv, focus] of [
    [['open', ':5173'], false],
    [['--focus', 'open', ':5173'], true],
    [['open', ':5173', '--focus'], true],
    [['open', ':5173', '--focus=true'], true],
    [['open', '--focus=false', ':5173'], false],
  ]) {
    const ab = fakeAgentBrowser();
    const client = fixtureClient();
    const result = await runCli(['agent-browser', ...argv], { client, execAgentBrowser: ab.exec });
    assert.equal(result.exitCode, 0, argv.join(' '));
    assert.equal(client.requests.find(r => r.method === 'browserSurface').request.focus, focus, argv.join(' '));
    assert.equal(ab.calls.some(args => args.some(arg => arg.startsWith('--focus'))), false, argv.join(' '));
  }
  // After a bare --, it is the provider's.
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', 'fill', '#q', '--', '--focus'], { client, execAgentBrowser: ab.exec });
  assert.equal(ab.calls.some(args => args.includes('--focus')), true);
  for (const argv of [['--focus=yes', 'open', ':5173'], ['--focus', 'open', ':5173', '--focus=false']]) {
    const refused = await runCli(['agent-browser', ...argv], { client: fixtureClient(), execAgentBrowser: fakeAgentBrowser().exec });
    assert.equal(refused.exitCode, 1, argv.join(' '));
  }
});

test('agent-browser resolves --key to a namespaced session and opens a surface', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', '--key', 'storybook', 'open', 'http://localhost:6006'], { client, execAgentBrowser: ab.exec });
  // The command made the daemon, so `dor agent-browser` asks it for its stream port — under
  // its own socket directory and CLI — and hands that over.
  assert.deepEqual(ab.calls, [
    ['agent-browser', '--session', 'dormouse.1.storybook', 'open', 'http://localhost:6006'],
    ['agent-browser', '--session', 'dormouse.1.storybook', 'stream', 'status', '--json'],
  ]);
  assert.deepEqual(client.requests, [
    // The host names the session, because only the Workspace that will hold the
    // browser can namespace a key.
    { method: 'resolveBrowser', request: { provider: 'agent-browser', key: 'storybook', proposed: proposedHere } },
    { method: 'browserSurface', request: { focus: false, provider: 'agent-browser', key: 'storybook', session: 'dormouse.1.storybook', cwd: process.cwd(), wsPort: 61141 } },
  ]);
});

test('agent-browser --key in another Workspace drives that Workspace own session', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', '--workspace', 'workspace-name:build', '--key', 'default', 'open', 'http://localhost:6006'], { client, execAgentBrowser: ab.exec });
  // The same key in another Workspace is another browser: the session name is
  // namespaced by the Workspace's stable id, so nothing here can reach the
  // first Workspace's `dormouse.1.default`.
  assert.deepEqual(ab.calls, [
    ['agent-browser', '--session', 'dormouse.workspace-2.default', 'open', 'http://localhost:6006'],
    ['agent-browser', '--session', 'dormouse.workspace-2.default', 'stream', 'status', '--json'],
  ]);
  assert.deepEqual(client.requests, [
    { method: 'resolveBrowser', request: { provider: 'agent-browser', key: 'default', proposed: proposedHere, workspace: 'workspace-name:build' } },
    {
      method: 'browserSurface',
      request: { focus: false, provider: 'agent-browser', key: 'default', session: 'dormouse.workspace-2.default', cwd: process.cwd(), wsPort: 61141, workspace: 'workspace-name:build' },
    },
  ]);
});

test('agent-browser defaults to --key default', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', 'open', 'http://localhost:5173'], { client, execAgentBrowser: ab.exec });
  assert.equal(ab.calls[0][2], 'dormouse.1.default');
  assert.deepEqual(client.requests[1].request, { focus: false, provider: 'agent-browser', key: 'default', session: 'dormouse.1.default', cwd: process.cwd(), wsPort: 61141 });
});

test('agent-browser raw --session skips key namespacing', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', '--session', 'mine', 'snapshot'], { client, execAgentBrowser: ab.exec });
  assert.equal(ab.calls[0][2], 'mine');
  // A raw session is already the session: nothing is asked of the host but the
  // surface it binds to.
  assert.deepEqual(client.requests, [
    { method: 'browserSurface', request: { focus: false, provider: 'agent-browser', key: undefined, session: 'mine', cwd: process.cwd(), wsPort: 61141 } },
  ]);
});

test('agent-browser --workspace names the Workspace and never reaches the binary', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', '--workspace', 'workspace-name:build', 'open', 'surface:1'], { client, execAgentBrowser: ab.exec });
  // Intercepted like the identity flags: the browser opens in `build`, the
  // handle resolves there, and agent-browser sees neither the flag nor its value.
  assert.deepEqual(ab.calls, [
    ['agent-browser', '--session', 'dormouse.workspace-2.default', 'open', 'http://localhost:5173/'],
    ['agent-browser', '--session', 'dormouse.workspace-2.default', 'stream', 'status', '--json'],
  ]);
  // Every host round trip the run makes names it: the session namespace, the
  // handle resolution, and the surface the browser lands in.
  assert.deepEqual(client.requests.map((entry) => [entry.method, entry.request.workspace]), [
    ['resolveBrowser', 'workspace-name:build'],
    ['resolveOpenTarget', 'workspace-name:build'],
    ['browserSurface', 'workspace-name:build'],
  ]);
});

test('agent-browser open resolves a surface handle to a URL before forwarding', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', 'open', 'surface:1'], { client, execAgentBrowser: ab.exec });
  // The surface handle is resolved via the host, then the URL is forwarded.
  assert.deepEqual(ab.calls, [
    ['agent-browser', '--session', 'dormouse.1.default', 'open', 'http://localhost:5173/'],
    ['agent-browser', '--session', 'dormouse.1.default', 'stream', 'status', '--json'],
  ]);
  assert.deepEqual(client.requests[1], { method: 'resolveOpenTarget', request: { surface: 'surface:1' } });
});

test('agent-browser open sugars a bare :port without a host round trip', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', 'open', ':5173'], { client, execAgentBrowser: ab.exec });
  assert.equal(ab.calls[0][4], 'http://localhost:5173/');
  assert.equal(client.requests.some((entry) => entry.method === 'resolveOpenTarget'), false);
});

test('agent-browser open defaults a schemeless host:port to http, overriding agent-browser https', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', 'open', 'localhost:5173'], { client, execAgentBrowser: ab.exec });
  // agent-browser would prepend https:// itself; dor forces http for the dev server.
  assert.equal(ab.calls[0][4], 'http://localhost:5173/');
  assert.equal(client.requests.some((entry) => entry.method === 'resolveOpenTarget'), false);
});

test('agent-browser open does not treat a bare-integer n:n as a host:port target', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  // `800:600` would otherwise be packed by new URL into http://0.0.3.32:600/; a
  // bare-integer host is not a real target, so it is forwarded verbatim.
  await runCli(['agent-browser', 'open', '800:600'], { client, execAgentBrowser: ab.exec });
  assert.equal(ab.calls[0][4], '800:600');
  assert.equal(client.requests.some((entry) => entry.method === 'resolveOpenTarget'), false);
});

test('iframe rejects a bare-integer n:n rather than packing it into an IPv4', async () => {
  const result = await runCli(['iframe', '800:600'], { client: fixtureClient() });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /http:\/\/ or https:\/\//);
});

test('agent-browser open resolves a surface target behind a flag', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', 'open', '--headed', 'surface:1'], { client, execAgentBrowser: ab.exec });
  assert.deepEqual(ab.calls[0], ['agent-browser', '--session', 'dormouse.1.default', 'open', '--headed', 'http://localhost:5173/']);
});

test('agent-browser leaves a plain open URL untouched', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', 'open', 'http://localhost:5173'], { client, execAgentBrowser: ab.exec });
  assert.equal(ab.calls[0][4], 'http://localhost:5173');
  assert.equal(client.requests.some((entry) => entry.method === 'resolveOpenTarget'), false);
});

test('agent-browser open of a surface handle needs a control endpoint', async () => {
  const ab = fakeAgentBrowser();
  const result = await runCli(['agent-browser', 'open', 'surface:1'], { execAgentBrowser: ab.exec });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /control endpoint is not available/);
  // Never forwards an unresolved handle to agent-browser.
  assert.deepEqual(ab.calls, []);
});

test('agent-browser close skips surface management', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', 'close'], { client, execAgentBrowser: ab.exec });
  assert.deepEqual(ab.calls, [['agent-browser', '--session', 'dormouse.1.default', 'close']]);
  assert.equal(surfaceRequest(client), undefined);
});

test('agent-browser skills runs alone, without a stream probe or a surface', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', 'skills', 'get', 'core'], { client, execAgentBrowser: ab.exec });
  assert.deepEqual(ab.calls, [['agent-browser', '--session', 'dormouse.1.default', 'skills', 'get', 'core']]);
  assert.equal(surfaceRequest(client), undefined);
});

test('agent-browser without a control endpoint stays a pure passthrough', async () => {
  const ab = fakeAgentBrowser();
  const result = await runCli(['agent-browser', 'open', 'http://localhost:5173'], { execAgentBrowser: ab.exec });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(ab.calls, [['agent-browser', '--session', 'dormouse.1.default', 'open', 'http://localhost:5173']]);
});

test('agent-browser forwards child exit code and skips surface on failure', async () => {
  const ab = fakeAgentBrowser({ exitCode: 1, stderr: '✗ boom\n' });
  const client = fixtureClient();
  const result = await runCli(['agent-browser', 'open', 'nope'], { client, execAgentBrowser: ab.exec });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, '✗ boom\n');
  assert.equal(surfaceRequest(client), undefined);
});

test('agent-browser --surface drives the session the host says the surface is bound to', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', '--surface', 'surface:3', 'click', '@e3'], { client, execAgentBrowser: ab.exec });
  // The handle is resolved first, then everything else is forwarded verbatim
  // against the resolved session — a GUI-minted name no `--key` can produce.
  assert.deepEqual(client.requests[0], {
    method: 'resolveBrowser',
    request: { provider: 'agent-browser', surface: 'surface:3' },
  });
  assert.deepEqual(ab.calls, [
    ['agent-browser', '--session', 'dormouse.1.gui-a1b2c3', 'click', '@e3'],
    ['agent-browser', '--session', 'dormouse.1.gui-a1b2c3', 'stream', 'status', '--json'],
  ]);
  // No `key`: a surface-addressed session is not necessarily a managed one.
  assert.deepEqual(client.requests[1], {
    method: 'browserSurface',
    request: { focus: false, provider: 'agent-browser', key: undefined, surface: 'surface:3', session: 'dormouse.1.gui-a1b2c3', cwd: process.cwd(), wsPort: 61141 },
  });
});

test('agent-browser --surface accepts --surface=handle and resolves an open target too', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', '--surface=surface:3', 'open', ':5173'], { client, execAgentBrowser: ab.exec });
  assert.deepEqual(ab.calls[0], [
    'agent-browser', '--session', 'dormouse.1.gui-a1b2c3', 'open', 'http://localhost:5173/',
  ]);
});

test('agent-browser --surface prints the host gate error and never forwards', async () => {
  const ab = fakeAgentBrowser();
  const result = await runCli(['agent-browser', '--surface', 'surface:1', 'reload'], {
    client: fixtureClient(),
    execAgentBrowser: ab.exec,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, "Error: surface 'surface:1' has no browser (kind: terminal)\n");
  // An unresolved handle must never reach agent-browser as a session.
  assert.deepEqual(ab.calls, []);
});

test('agent-browser fails fast when the host refuses to name a managed key, never running the binary', async () => {
  // A Wall still mounting, a webview mid-reload, the VS Code guard: the host
  // answers with a refusal rather than the session, and there is no CLI-side
  // fallback that could name the right Workspace's browser
  // (`docs/specs/dor-browser.md` → "Managed identity").
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  client.resolveBrowser = async () => {
    throw new Error("workspace 'workspace:1' is still mounting");
  };
  const result = await runCli(['agent-browser', 'tab', 'list'], { client, execAgentBrowser: ab.exec });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, "Error: workspace 'workspace:1' is still mounting\n");
  assert.deepEqual(ab.calls, []);
});

test('agent-browser --surface needs a control endpoint', async () => {
  const ab = fakeAgentBrowser();
  const result = await runCli(['agent-browser', '--surface', 'surface:3', 'reload'], { execAgentBrowser: ab.exec });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /control endpoint is not available/);
  assert.deepEqual(ab.calls, []);
});

test('a -h in a command tail is the command\'s, so the tail check still runs', async () => {
  const client = fixtureClient();
  const result = await runCli(['ensure', 'extra', '--', 'du', '-h'], { client, env: { PWD: '/work/site' } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "Error: unexpected argument 'extra' before --\n");
  assert.deepEqual(client.requests, []);
});

test('agent-browser rejects an intercepted flag given twice', async () => {
  for (const [args, flag] of [[['--key', 'a', '--key', 'b'], '--key'], [['--workspace', '1', '--workspace=2'], '--workspace']]) {
    const ab = fakeAgentBrowser();
    const result = await runCli(['agent-browser', ...args, 'snapshot'], { client: fixtureClient(), execAgentBrowser: ab.exec });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, `Error: ${flag} may be given only once\n`);
    assert.deepEqual(ab.calls, []);
  }
});

test('agent-browser rejects a valueless identity flag, whichever one it is', async () => {
  // Only an absent argument is a missing value; a leading dash is literal.
  for (const args of [['agent-browser', 'reload', '--key'], ['agent-browser', 'reload', '--session'], ['agent-browser', 'reload', '--surface']]) {
    const ab = fakeAgentBrowser();
    const result = await runCli(args, { client: fixtureClient(), execAgentBrowser: ab.exec });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, `Error: ${args[2]} requires a value\n`);
    assert.deepEqual(ab.calls, []);
  }

});

test('agent-browser key/session conflict output', async () => {
  const ab = fakeAgentBrowser();
  await snapshot(
    'agent-browser-key-session-conflict',
    await runCli(['agent-browser', '--key', 'a', '--session', 'b', 'open', 'x'], { client: fixtureClient(), execAgentBrowser: ab.exec }),
  );
});

test('agent-browser key/surface conflict reports in flag order, not argv order', async () => {
  const ab = fakeAgentBrowser();
  await snapshot(
    'agent-browser-key-surface-conflict',
    await runCli(['agent-browser', '--surface', 'surface:3', '--key', 'a', 'reload'], { client: fixtureClient(), execAgentBrowser: ab.exec }),
  );
});

test('agent-browser three-way identity conflict output', async () => {
  const ab = fakeAgentBrowser();
  await snapshot(
    'agent-browser-identity-conflict',
    await runCli(['agent-browser', '--key', 'a', '--session', 'b', '--surface', 'surface:3', 'reload'], { client: fixtureClient(), execAgentBrowser: ab.exec }),
  );
});

test('agent-browser missing binary output', async () => {
  const enoent = Object.assign(new Error("spawn agent-browser ENOENT"), { code: 'ENOENT' });
  await snapshot(
    'agent-browser-missing-binary',
    await runCli(['agent-browser', 'open', 'http://localhost:5173'], {
      client: fixtureClient(),
      execAgentBrowser: async () => { throw enoent; },
    }),
  );
});

test('agent-browser respects DORMOUSE_AGENT_BROWSER_BIN and forwards it as binaryPath', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  await runCli(['agent-browser', 'snapshot'], {
    client,
    execAgentBrowser: ab.exec,
    env: { DORMOUSE_AGENT_BROWSER_BIN: '/opt/custom/agent-browser' },
  });
  assert.equal(ab.calls[0][0], '/opt/custom/agent-browser');
  assert.equal(surfaceRequest(client).binaryPath, '/opt/custom/agent-browser');
});

test('agent-browser spawns the PATH-resolved absolute path, never the bare name', async () => {
  await withTempDir('dor-ab-', async (dir) => {
    // On Windows a bare name isn't executable and resolveBinaryPath walks
    // PATHEXT (.cmd/.exe/.bat), so the on-disk shim must carry one of those
    // extensions — mirroring how agent-browser actually installs there.
    const ext = process.platform === 'win32' ? '.cmd' : '';
    const binPath = join(dir, `agent-browser${ext}`);
    await writeFile(binPath, '#!/bin/sh\n', { mode: 0o755 });
    const ab = fakeAgentBrowser();
    const client = fixtureClient();
    await runCli(['agent-browser', 'snapshot'], {
      client,
      execAgentBrowser: ab.exec,
      // Join with the platform PATH delimiter (`;` on Windows, `:` elsewhere) —
      // resolveBinaryPath splits on the same, so a POSIX-only `:` would hide dir.
      env: { PATH: ['/nonexistent', dir].join(delimiter) },
    });
    // The spawn takes the resolved path. Spawning the bare name instead would
    // hand the inherited cwd a code-execution primitive on Windows, where
    // cross-spawn's `which` searches it before PATH — docs/specs/dor-cli.md ->
    // "Spawning External Binaries".
    assert.equal(ab.calls.length, 2);
    for (const [target] of ab.calls) assertSamePath(target, binPath);
    assertSamePath(surfaceRequest(client).binaryPath, binPath);
  });
});

test('agent-browser skips a PATH entry that is not an executable file', async () => {
  await withTempDir('dor-ab-skip-', async (shadowRoot) => {
    await withTempDir('dor-ab-real-', async (realRoot) => {
      // `which` (and so cross-spawn, which the bare-name spawn used to reach)
      // walks past a directory or a non-executable file. resolveBinaryPath now
      // picks what gets spawned, so a laxer test would turn a PATH entry `which`
      // ignored into an EACCES/EISDIR failure instead of finding the real
      // install further along.
      const ext = process.platform === 'win32' ? '.cmd' : '';
      await mkdir(join(shadowRoot, `agent-browser${ext}`));
      // Off Windows a second shadow, a regular file without the executable bit:
      // the directory above is rejected by the isFile() test alone, so this is
      // what makes the X_OK probe load-bearing in the walk itself.
      if (process.platform !== 'win32') {
        await mkdir(join(shadowRoot, 'second'));
        await writeFile(join(shadowRoot, 'second', 'agent-browser'), '', { mode: 0o644 });
      }
      const realPath = join(realRoot, `agent-browser${ext}`);
      await writeFile(realPath, '#!/bin/sh\n', { mode: 0o755 });
      const ab = fakeAgentBrowser();
      const client = fixtureClient();
      await runCli(['agent-browser', 'snapshot'], {
        client,
        execAgentBrowser: ab.exec,
        env: {
          PATH: [shadowRoot, join(shadowRoot, 'second'), realRoot].join(delimiter),
        },
      });
      assertSamePath(ab.calls[0][0], realPath);
      assertSamePath(surfaceRequest(client).binaryPath, realPath);
    });
  });
});

// Windows-only: off Windows the walk uses a single empty extension, so the name
// is already tried as itself and there is nothing to regress.
test('agent-browser tries a name that already carries an extension as itself', {
  skip: process.platform !== 'win32' ? 'Windows-only PATHEXT behaviour' : false,
}, async () => {
  await withTempDir('dor-ab-ext-', async (dir) => {
    const binPath = join(dir, 'agent-browser.exe');
    await writeFile(binPath, '', { mode: 0o755 });
    const ab = fakeAgentBrowser();
    const client = fixtureClient();
    // `which` unshifts an empty extension when the command contains a `.`;
    // without it the walk only ever looks for `agent-browser.exe.EXE` and
    // reports a present install as missing.
    await runCli(['agent-browser', 'snapshot'], {
      client,
      execAgentBrowser: ab.exec,
      env: { PATH: dir, DORMOUSE_AGENT_BROWSER_BIN: 'agent-browser.exe' },
    });
    assertSamePath(ab.calls[0][0], binPath);
  });
});

test('isExecutableFile rejects a directory on both platforms, and a non-executable file off Windows', async () => {
  await withTempDir('dor-exec-', async (dir) => {
    const asDirectory = join(dir, 'shadow');
    await mkdir(asDirectory);
    const notExecutable = join(dir, 'not-executable');
    await writeFile(notExecutable, '', { mode: 0o644 });
    const executable = join(dir, 'executable');
    await writeFile(executable, '', { mode: 0o755 });

    // `isWindows` is a parameter rather than a `process.platform` read so both
    // branches are reachable from this Linux-only suite. `statSync().isFile()`
    // alone covers the directory, so the X_OK probe is what the middle pair pins.
    assert.equal(isExecutableFile(asDirectory, false), false);
    assert.equal(isExecutableFile(asDirectory, true), false);
    assert.equal(isExecutableFile(executable, false), true);
    assert.equal(isExecutableFile(join(dir, 'absent'), false), false);
    // On Windows the extension decides executability, so a mode-0644 regular
    // file is runnable there and `accessSync(X_OK)` reports every readable file
    // as executable — which is why the POSIX half cannot be asserted there.
    assert.equal(isExecutableFile(notExecutable, true), true);
    if (process.platform !== 'win32') {
      assert.equal(isExecutableFile(notExecutable, false), false);
    }
  });
});

test('the Windows candidate list mirrors which(1) on every edge', () => {
  // Exercised off Windows by passing isWindows, because all three rules are
  // Windows-only and this suite runs on Linux in CI — a platform-gated
  // assertion here would be an unenforced claim. `which`'s own logic:
  // `opt.pathExt || process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM'`, plus an
  // empty extension unshifted when the command contains a `.`.
  const npmOrder = ['.EXE', '.CMD', '.BAT', '.COM'];
  assert.deepEqual(
    binaryCandidateNames('agent-browser', {}, true),
    npmOrder.map((ext) => `agent-browser${ext}`),
    'unset PATHEXT takes npm\u2019s list, not cmd.exe\u2019s .COM-first order',
  );
  assert.deepEqual(
    binaryCandidateNames('agent-browser', { PATHEXT: '' }, true),
    npmOrder.map((ext) => `agent-browser${ext}`),
    'an empty PATHEXT falls back rather than yielding no candidates',
  );
  assert.deepEqual(
    binaryCandidateNames('agent-browser', { PATHEXT: '.EXE;.PS1' }, true),
    ['agent-browser.EXE', 'agent-browser.PS1'],
    'a customised PATHEXT is honoured verbatim, in its own order',
  );
  assert.deepEqual(
    binaryCandidateNames('agent-browser', { PATHEXT: '.EXE;' }, true),
    ['agent-browser.EXE', 'agent-browser'],
    'a trailing separator keeps the empty extension, as splitting without a filter does',
  );
  assert.deepEqual(
    binaryCandidateNames('agent-browser.exe', {}, true)[0],
    'agent-browser.exe',
    'a name carrying an extension is tried as itself first',
  );
  assert.deepEqual(
    binaryCandidateNames('agent-browser', { PATHEXT: '.EXE' }, false),
    ['agent-browser'],
    'PATHEXT is Windows-only; off Windows the name is the only candidate',
  );
});

test('an unresolvable bare name is a missing install, including with no PATH', () => {
  // The bare-name fallback at the spawn is for "the walk found nothing on a PATH
  // we searched". With no PATH there is nothing to search, and reporting
  // "ambiguous" would fall through to cross-spawn with the bare name — cwd-first
  // on Windows, which is what spawning the resolved path exists to prevent.
  // Pinned on the helper because the CLI's two paths produce the same message.
  assert.equal(agentBrowserIsMissing('agent-browser', {}, undefined), true);
  assert.equal(agentBrowserIsMissing('agent-browser', { PATH: '/nonexistent' }, undefined), true);
});

// The caller terminal (surface:2) plus the host identity `dor list --json` folds
// in. The control socket is private host plumbing (the CLI is the public API), so
// the host block must not echo it — the snapshot proves the field is absent.
const listEnv = {
  DORMOUSE_SURFACE_ID: 'surface:2',
  DORMOUSE_CLI_JS: '/opt/dormouse/dor-cli/dist/dor.js',
  DORMOUSE_NODE: '/opt/dormouse/node',
  DORMOUSE_HOST: 'vscode',
  DORMOUSE_HOST_WORKSPACE: '/Users/me/projects/site',
  DORMOUSE_CONTROL_SOCKET: '/tmp/dormouse-control.sock',
};

const standaloneEnv = { ...listEnv, DORMOUSE_HOST: 'standalone', DORMOUSE_HOST_WORKSPACE: undefined };

test('list text output', async () => {
  const client = fixtureClient();
  const result = await runCli(['list'], { client, env: listEnv });
  assert.deepEqual(client.requests, [{ includePorts: false }]);
  await snapshot('list-text', result);
});

test('list tags an awaited surface after its todo', async () => {
  const text = await runCli(['list'], { client: fixtureClient(), env: listEnv });
  const row = text.stdout.split('\n').find((line) => line.includes('surface:2'));
  assert.match(row, /\[todo\]\s+\[awaited\]$/);

  const json = await runCli(['list', '--json'], { client: fixtureClient(), env: listEnv });
  const surfaces = JSON.parse(json.stdout).surfaces;
  assert.deepEqual(
    surfaces.map((surface) => [surface.id, surface.awaited]),
    [['surface:1', false], ['surface:2', true], ['surface:3', false], ['surface:4', false]],
  );
});

test('list tags the preview slot in text and JSON only', async () => {
  const surfaces = [fixtureSurfaces[0], { ...fixtureSurfaces[1], kind: 'tool', todo: false, awaited: false, preview: true }];
  const text = await runCli(['list'], { client: fixtureClient(surfaces), env: listEnv });
  const rows = text.stdout.split('\n');
  assert.match(rows.find((line) => line.includes('surface:2')), /\[preview\]$/);
  assert.doesNotMatch(rows.find((line) => line.includes('surface:1')), /\[preview\]/);
  const json = await runCli(['list', '--json'], { client: fixtureClient(surfaces), env: listEnv });
  assert.deepEqual(JSON.parse(json.stdout).surfaces.map((surface) => [surface.id, surface.preview]), [['surface:1', undefined], ['surface:2', true]]);
});

test('list reports a Tool\'s declared identity in JSON only, and nothing for a terminal', async () => {
  const tool = { ...fixtureSurfaces[1], kind: 'tool', toolName: 'docs', toolScope: 'user', toolOrigin: { file: '/home/me/.config/dormouse/dormouse.yml' } };
  const surfaces = [fixtureSurfaces[0], tool];
  const text = await runCli(['list'], { client: fixtureClient(surfaces), env: listEnv });
  assert.equal(text.stdout, (await runCli(['list'], { client: fixtureClient([fixtureSurfaces[0], { ...fixtureSurfaces[1], kind: 'tool' }]), env: listEnv })).stdout);
  const rows = JSON.parse((await runCli(['list', '--json'], { client: fixtureClient(surfaces), env: listEnv })).stdout).surfaces;
  assert.deepEqual(rows.map((row) => [row.tool_name, row.tool_scope, row.tool_origin]), [
    [undefined, undefined, undefined],
    ['docs', 'user', { file: '/home/me/.config/dormouse/dormouse.yml' }],
  ]);
  assert.equal(Object.keys(rows[0]).some((field) => field.startsWith('tool_')), false);
});

test('list --all groups every Workspace under a header', async () => {
  const client = fixtureClient();
  const result = await runCli(['list', '--all'], { client, env: listEnv });
  assert.deepEqual(client.requests, [{ includePorts: false, scope: 'all' }]);
  await snapshot('list-all-text', result);
});

test('list --all json tags each row with its Workspace and carries the directory', async () => {
  const result = await runCli(['list', '--all', '--json'], { client: fixtureClient(), env: listEnv });
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(
    payload.surfaces.map((surface) => [surface.workspace_id, surface.id]),
    [['workspace:1', 'surface:1'], ['workspace:2', 'surface:3'], ['workspace:2', 'surface:4']],
  );
  assert.deepEqual(payload.workspaces.map((row) => row.id), ['workspace:1', 'workspace:2']);
  await snapshot('list-all-json', result);
});

test('list --all keeps the header of a Workspace its filters emptied', async () => {
  const result = await runCli(['list', '--all', '--kind', 'browser'], { client: fixtureClient(), env: listEnv });
  // The text listing says which Workspaces there are, exactly as the JSON
  // payload's `workspaces` array does — a filtered-out group is a header with
  // no rows under it, not a Workspace that vanished.
  assert.match(result.stdout, /^workspace:1 {2}Workspace 1 {2}\[active\]\n\nworkspace:2 {2}build {2}\[pinned\]\n {4}/);
});

test('list --workspace asks the host for another Workspace', async () => {
  const client = fixtureClient();
  await runCli(['list', '--workspace', 'workspace-name:build'], { client, env: listEnv });
  assert.deepEqual(client.requests, [{ includePorts: false, workspace: 'workspace-name:build' }]);
});

test('list --workspaces prints the overview', async () => {
  const client = fixtureClient();
  const result = await runCli(['list', '--workspaces'], { client, env: listEnv });
  assert.deepEqual(client.requests, [{ method: 'listWorkspaces', request: {} }]);
  await snapshot('list-workspaces-text', result);
  await snapshot(
    'list-workspaces-json',
    await runCli(['list', '--workspaces', '--json'], { client: fixtureClient(), env: listEnv }),
  );
});

test('list container flags that name two scopes are refused', async () => {
  await snapshot(
    'list-all-and-workspace',
    await runCli(['list', '--all', '--workspace', '2'], { client: fixtureClient(), env: listEnv }),
  );
  await snapshot(
    'list-workspaces-with-filter',
    await runCli(['list', '--workspaces', '--kind', 'terminal'], { client: fixtureClient(), env: listEnv }),
  );
});

test('workspace mutation verbs', async () => {
  // One client across all four runs, so the assertion below is the whole
  // conversation in order: each verb calls exactly its own control method, with
  // the target the user typed.
  const client = fixtureClient();
  await snapshot('workspace-new', await runCli(['workspace', 'new', 'build'], { client, env: listEnv }));
  await snapshot('workspace-new-json', await runCli(['workspace', 'new', '--json'], { client, env: listEnv }));
  await snapshot('workspace-rename', await runCli(['workspace', 'rename', 'workspace:2', 'agents'], { client, env: listEnv }));
  await snapshot('workspace-switch', await runCli(['workspace', 'switch', 'workspace-name:build'], { client, env: listEnv }));
  assert.deepEqual(client.requests, [
    { method: 'newWorkspace', request: { name: 'build' } },
    { method: 'newWorkspace', request: {} },
    { method: 'renameWorkspace', request: { workspace: 'workspace:2', name: 'agents' } },
    { method: 'switchWorkspace', request: { workspace: 'workspace-name:build' } },
  ]);
});

test('workspace pin and unpin send one request each, and take one workspace', async () => {
  const client = fixtureClient();
  await snapshot('workspace-pin', await runCli(['workspace', 'pin', 'workspace-name:build'], { client, env: listEnv }));
  await snapshot('workspace-unpin-json', await runCli(['workspace', 'unpin', 'workspace:2', '--json'], { client, env: listEnv }));
  assert.deepEqual(client.requests, [
    { method: 'pinWorkspace', request: { workspace: 'workspace-name:build', pinned: true } },
    { method: 'pinWorkspace', request: { workspace: 'workspace:2', pinned: false } },
  ]);
  await snapshot('workspace-pin-arity', await runCli(['workspace', 'pin'], { client: fixtureClient(), env: listEnv }));
  await snapshot('workspace-unpin-force-misuse', await runCli(['workspace', 'unpin', 'workspace:2', '--force'], { client: fixtureClient(), env: listEnv }));
});

test('workspace close refuses running work until forced', async () => {
  await snapshot(
    'workspace-close-refused',
    await runCli(['workspace', 'close', 'workspace:2'], { client: fixtureClient(), env: listEnv }),
  );
  const client = fixtureClient();
  await snapshot('workspace-close-force', await runCli(['workspace', 'close', 'workspace:2', '--force'], { client, env: listEnv }));
  assert.deepEqual(client.requests, [{ method: 'closeWorkspace', request: { workspace: 'workspace:2', force: true } }]);
});

test('workspace move sends the window and the index in one request', async () => {
  // `--window` becomes `toWindow` and `--index` rides beside it: the slot is
  // the target's, and the host carries it across rather than dropping it.
  const client = fixtureClient();
  await snapshot(
    'workspace-move',
    await runCli(['workspace', 'move', 'workspace-name:build', '--window', 'window:ws-2', '--index', '0'], { client, env: listEnv }),
  );
  assert.deepEqual(client.requests, [{
    method: 'moveWorkspace',
    request: { workspace: 'workspace-name:build', toWindow: 'window:ws-2', index: 0, dangerouslyDestroyIframePageState: false },
  }]);
});

test('workspace move flags are refused off the action, and move needs one of them', async () => {
  await snapshot('workspace-window-misuse', await runCli(['workspace', 'switch', 'workspace:2', '--window', 'window:ws-2'], { client: fixtureClient(), env: listEnv }));
  await snapshot('workspace-index-misuse', await runCli(['workspace', 'switch', 'workspace:2', '--index', '0'], { client: fixtureClient(), env: listEnv }));
  await snapshot('workspace-destroy-iframe-misuse', await runCli(['workspace', 'switch', 'workspace:2', '--dangerously-destroy-iframe-page-state'], { client: fixtureClient(), env: listEnv }));
  await snapshot('workspace-move-needs-flag', await runCli(['workspace', 'move', 'workspace:2'], { client: fixtureClient(), env: listEnv }));
  await snapshot('workspace-invalid-index', await runCli(['workspace', 'move', 'workspace:2', '--index', 'x'], { client: fixtureClient(), env: listEnv }));
});

test('list --window asks the host for another window', async () => {
  const client = fixtureClient();
  await runCli(['list', '--window', 'window:ws-2'], { client, env: listEnv });
  await runCli(['list', '--workspaces', '--window', 'window:ws-2'], { client, env: listEnv });
  assert.deepEqual(client.requests, [
    { includePorts: false, window: 'window:ws-2' },
    { method: 'listWorkspaces', request: { window: 'window:ws-2' } },
  ]);
});

test('workspace usage errors name the action', async () => {
  await snapshot('workspace-missing-action', await runCli(['workspace'], { client: fixtureClient(), env: listEnv }));
  await snapshot('workspace-unknown-action', await runCli(['workspace', 'destroy', 'x'], { client: fixtureClient(), env: listEnv }));
  await snapshot('workspace-list-action', await runCli(['workspace', 'list'], { client: fixtureClient(), env: listEnv }));
  await snapshot('workspace-rename-arity', await runCli(['workspace', 'rename', 'workspace:2'], { client: fixtureClient(), env: listEnv }));
  await snapshot('workspace-force-misuse', await runCli(['workspace', 'switch', 'workspace:2', '--force'], { client: fixtureClient(), env: listEnv }));
});

test('app restart asks the host once', async () => {
  const client = fixtureClient();
  await snapshot('app-restart', await runCli(['app', 'restart'], { client, env: standaloneEnv }));
  await snapshot('app-restart-json', await runCli(['app', 'restart', '--json'], { client, env: standaloneEnv }));
  assert.deepEqual(client.requests, [{ method: 'restartApp' }, { method: 'restartApp' }]);
});

test('app restart that joins a quit in progress fails, since nothing will relaunch', async () => {
  const client = { async restartApp() { return { relaunch: false }; } };
  await snapshot('app-restart-joined-quit', await runCli(['app', 'restart'], { client, env: standaloneEnv }));
});

// A host from before `app.*` answers with its Wall's catch-all refusal. Only a
// standalone terminal gets the quit-and-reopen hint; VS Code refuses the same
// way, and the hint would be wrong there.
test('app restart against a Dormouse that predates it', async () => {
  const client = {
    async restartApp() { throw new Error("unsupported Dormouse control method 'app.restart'"); },
  };
  await snapshot('app-restart-predates', await runCli(['app', 'restart'], { client, env: standaloneEnv }));
  await snapshot('app-restart-predates-vscode', await runCli(['app', 'restart'], { client, env: listEnv }));
});

test('app restart passes a host refusal through', async () => {
  const client = { async restartApp() { throw new Error('Restart needs a packaged build'); } };
  await snapshot('app-restart-refused', await runCli(['app', 'restart'], { client, env: standaloneEnv }));
});

test('reopen asks the host once and names what came back', async () => {
  const client = fixtureClient();
  await snapshot('reopen', await runCli(['reopen'], { client, env: standaloneEnv }));
  await snapshot('reopen-json', await runCli(['reopen', '--json'], { client, env: standaloneEnv }));
  assert.deepEqual(client.requests, [{ method: 'reopenClosed' }, { method: 'reopenClosed' }]);
  const workspace = { async reopenClosed() { return { status: 'reopened', kind: 'workspace', workspaceId: 'workspace:7' }; } };
  await snapshot('reopen-workspace', await runCli(['reopen'], { client: workspace, env: standaloneEnv }));
  const window = { async reopenClosed() { return { status: 'reopened', kind: 'window' }; } };
  await snapshot('reopen-window', await runCli(['reopen'], { client: window, env: standaloneEnv }));
});

test('reopen passes a host refusal through, and names a host that predates it', async () => {
  const empty = { async reopenClosed() { throw new Error('Nothing to reopen'); } };
  await snapshot('reopen-nothing', await runCli(['reopen'], { client: empty, env: standaloneEnv }));
  const old = { async reopenClosed() { throw new Error("unsupported Dormouse control method 'window.reopen'"); } };
  await snapshot('reopen-predates', await runCli(['reopen'], { client: old, env: standaloneEnv }));
});

test('app usage errors name the action', async () => {
  await snapshot('app-missing-action', await runCli(['app'], { client: fixtureClient(), env: standaloneEnv }));
  await snapshot('app-unknown-action', await runCli(['app', 'quit'], { client: fixtureClient(), env: standaloneEnv }));
  await snapshot('app-restart-arity', await runCli(['app', 'restart', 'now'], { client: fixtureClient(), env: standaloneEnv }));
});

test('every action command forwards --workspace to the host', async () => {
  const calls = [
    [['split', '--workspace', 'workspace-name:build', '--', 'pnpm', 'dev'], 'splitSurface'],
    [['ensure', '--workspace', 'workspace-name:build', '--', 'pnpm', 'dev'], 'ensureSurface'],
    [['send', 'surface:1', '--text', 'hi', '--workspace', 'workspace-name:build'], 'sendSurface'],
    [['read', 'surface:1', '--workspace', 'workspace-name:build'], 'readSurface'],
    [['kill', 'surface:1', '--confirm-dangerously', '--workspace', 'workspace-name:build'], 'killSurface'],
    [['iframe', 'http://localhost:5173', '--workspace', 'workspace-name:build'], 'iframeSurface'],
  ];
  for (const [argv, method] of calls) {
    const client = fixtureClient();
    const result = await runCli(argv, { client, env: listEnv });
    assert.equal(result.exitCode, 0, `${argv[0]} should succeed: ${result.stderr}`);
    const call = client.requests.find((entry) => entry.method === method);
    assert.equal(call.request.workspace, 'workspace-name:build', `${argv[0]} should forward --workspace`);
  }
});

test('list json output', async () => {
  await snapshot(
    'list-json',
    await runCli(['list', '--json'], { client: fixtureClient(), env: listEnv }),
  );
});

test('list json carries one spelling of each id', async () => {
  const result = await runCli(['list', '--json'], { client: fixtureClient(), env: listEnv });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.surfaces[0].id, 'surface:1');
  assert.equal('ref' in payload.surfaces[0], false);
  assert.equal(payload.caller_surface_id, listEnv.DORMOUSE_SURFACE_ID);
  assert.equal(payload.focused_surface_id, 'surface:1');
  assert.equal(payload.workspace_id, 'workspace:1');
  assert.equal(payload.window_ref, 'window:1');
  for (const key of ['caller_surface_ref', 'focused_surface_ref', 'workspace_ref']) assert.equal(key in payload, false, key);
});

test('list refuses the retired --id-format', async () => {
  const result = await runCli(['list', '--id-format', 'ids'], { client: fixtureClient(), env: listEnv });
  assert.notEqual(result.exitCode, 0);
});

test('list --cwd matches Git Bash and native Windows spellings', async () => {
  const host = { ...NODE_HOST, platform: 'win32', resolvePath: win32.resolve };
  for (const [pwd, reported] of [
    ['/c', '/c'],
    ['/c/', '/c/'],
    ['C:\\', '/c'],
    ['/c', 'c:/'],
    ['/c/Users/me/site', '/c/Users/me/site'],
    ['C:\\Users\\me\\site', 'c:/Users/me/site'],
  ]) {
    const client = fixtureClient([
      { ...fixtureSurfaces[0], cwd: reported },
      { ...fixtureSurfaces[1], cwd: '/d' },
      { ...fixtureSurfaces[2], cwd: null },
    ]);
    const result = await runCli(['list', '--json', '--cwd', '.'], { client, host, env: { PWD: pwd } });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout).surfaces.map(surface => surface.id), ['surface:1'], `${pwd} matches ${reported}`);
  }
});

test('list --cwd preserves directory-name case and POSIX path distinctions', async () => {
  for (const [platform, path, pwd, different] of [
    ['win32', win32, 'C:\\Users\\me\\site', '/c/Users/me/Site'],
    ['linux', posix, '/c', '/d'],
    ['darwin', posix, '/Users/me/site', '/Users/me/Site'],
  ]) {
    const client = fixtureClient([
      { ...fixtureSurfaces[0], cwd: pwd },
      { ...fixtureSurfaces[1], cwd: different },
    ]);
    const host = { ...NODE_HOST, platform, resolvePath: path.resolve };
    const result = await runCli(['list', '--json', '--cwd', '.'], { client, host, env: { PWD: pwd } });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout).surfaces.map(surface => surface.id), ['surface:1']);
  }
});

test('list filters by kind, view, command, and cwd without port scanning', async () => {
  const cwd = join(tmpdir(), 'dor-list-site');
  const client = fixtureClient(fixtureSurfaces.map(surface => ({
    ...surface, cwd: surface.cwd === '/Users/me/projects/site' ? cwd : surface.cwd,
  })));
  const result = await runCli(
    ['list', '--json', '--kind', 'terminal', '--view', 'paned', '--command', 'pnpm dev', '--cwd', '.'],
    { client, env: { ...listEnv, PWD: cwd } },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(client.requests, [{ includePorts: false }]);

  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.surfaces.map((surface) => surface.id), ['surface:1']);
  assert.equal(payload.caller_surface_id, null);
  assert.equal(payload.focused_surface_id, 'surface:1');
  assert.equal(payload.surfaces[0].ports, undefined);
});

test('list --command matches the reported command line, not its summarized label', async () => {
  const client = fixtureClient([
    { ...fixtureSurfaces[0], command: 'npm run dev', commandLine: 'npm run dev --host' },
    { ...fixtureSurfaces[1], command: 'npm run dev', commandLine: 'npm run dev' },
  ]);
  const ids = async command => JSON.parse((await runCli(['list', '--json', '--command', command], { client, env: listEnv })).stdout)
    .surfaces.map(surface => surface.id);
  assert.deepEqual(await ids('npm run dev --host'), ['surface:1']);
  assert.deepEqual(await ids('npm run dev'), ['surface:2']);
  // What a listing prints is what the filter takes back.
  const listed = JSON.parse((await runCli(['list', '--json'], { client, env: listEnv })).stdout).surfaces;
  assert.equal(listed[0].command_line, 'npm run dev --host');
  assert.deepEqual(await ids(listed[0].command_line), ['surface:1']);
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
  assert.deepEqual(payload.surfaces.map((surface) => surface.id), ['surface:1']);
  assert.deepEqual(payload.surfaces[0].ports.map((port) => port.port), [5173]);
});

test('list reports a null caller when the calling surface is not in the list', async () => {
  const result = await runCli(['list', '--json'], {
    client: fixtureClient(),
    env: { ...listEnv, DORMOUSE_SURFACE_ID: '99999999-9999-4999-8999-999999999999' },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).caller_surface_id, null);
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

test('tool named form text output', async () => {
  await snapshot(
    'tool-named',
    await runCli(['tool', 'storybook'], { client: fixtureClient(), env: { PWD: '/work/site' } }),
  );
});

test('tool command form text output', async () => {
  await snapshot(
    'tool-command',
    await runCli(['tool', '--', 'pnpm', 'dev'], { client: fixtureClient(), env: { PWD: '/work/site' } }),
  );
});

test('tool json output carries the resolved key', async () => {
  await snapshot(
    'tool-json',
    await runCli(['tool', '--json', 'storybook'], { client: fixtureClient(), env: { PWD: '/work/site' } }),
  );
});

test('tool sends the name, never a command', async () => {
  const client = fixtureClient();
  await runCli(['tool', 'storybook'], { client, env: { PWD: '/work/site' } });
  client.requests[0].request.cwd = smudgeWindowsPaths(client.requests[0].request.cwd);
  assert.deepEqual(client.requests, [{
    method: 'toolSurface',
    request: {
      name: 'storybook',
      args: [],
      global: false,
      fresh: false,
      minimized: false,
      focus: false,
      surface: undefined,
      cwd: '/work/site',
    },
  }]);
});

test('tool forwards named arguments as separate argv values', async () => {
  const client = fixtureClient();
  const result = await runCli(['tool', '--global', 'viewer', 'a b; $(bad).md'], { client });
  assert.equal(result.exitCode, 0);
  assert.equal(client.requests[0].request.name, 'viewer');
  assert.equal(client.requests[0].request.global, true);
  assert.deepEqual(client.requests[0].request.args, ['a b; $(bad).md']);
});

test('tool -- sends argv as a command, never a name', async () => {
  const client = fixtureClient();
  await runCli(['tool', '--', 'pnpm', 'dev'], { client, env: { PWD: '/work/site' } });
  client.requests[0].request.cwd = smudgeWindowsPaths(client.requests[0].request.cwd);
  assert.deepEqual(client.requests, [{
    method: 'toolSurface',
    request: {
      command: ['pnpm', 'dev'],
      fresh: false,
      minimized: false,
      focus: false,
      surface: undefined,
      cwd: '/work/site',
    },
  }]);
});

test('tool --fresh forwards the opt-out', async () => {
  const client = fixtureClient();
  await runCli(['tool', '--fresh', 'storybook'], { client, env: { PWD: '/work/site' } });
  assert.equal(client.requests[0].request.fresh, true);
});

test('tool prints dormouse.yml warnings to stderr, keeping --json parseable', async () => {
  const result = await runCli(['tool', '--json', 'noisy'], {
    client: fixtureClient(),
    env: { PWD: '/work/site' },
  });
  assert.match(result.stderr, /ignoring unknown field 'colour'/);
  assert.deepEqual(JSON.parse(result.stdout).status, 'created');
});

test('tool with neither a name nor a command tail, but a placement flag', async () => {
  await snapshot('tool-missing-target', await runCli(['tool', '--minimize'], { client: fixtureClient() }));
});

test('bare tool without a terminal prints the listing --list prints', async () => {
  for (const flags of [[], ['--json'], ['--global'], ['--global', '--json', '--cwd', 'sub']]) {
    const bare = fixtureClient();
    const listed = fixtureClient();
    const env = { PWD: '/work/site' };
    const result = await runCli(['tool', ...flags], { client: bare, env });
    assert.equal(result.exitCode, 0, flags.join(' '));
    assert.deepEqual(result, await runCli(['tool', '--list', ...flags], { client: listed, env }), flags.join(' '));
    assert.deepEqual(bare.requests, listed.requests, flags.join(' '));
  }
});

test('bare tool without a terminal refuses a placement flag', async () => {
  for (const flag of [['--minimize'], ['--fresh'], ['--from', 'surface:2'], ['--workspace', 'workspace:2']]) {
    const client = fixtureClient();
    const result = await runCli(['tool', ...flag], { client });
    assert.equal(result.exitCode, 1, flag.join(' '));
    assert.equal(result.stderr, 'Error: dor tool requires a tool name or -- <command...>\n', flag.join(' '));
    assert.deepEqual(client.requests, [], flag.join(' '));
  }
});

test('tool keeps escaped named arguments separate from anonymous commands', async () => {
  const client = fixtureClient();
  const result = await runCli(['tool', 'viewer', '--', '--flag', 'a b'], { client });
  assert.equal(result.exitCode, 0);
  assert.equal(client.requests[0].request.name, 'viewer');
  assert.deepEqual(client.requests[0].request.args, ['--flag', 'a b']);
  assert.equal(client.requests[0].request.command, undefined);
});

test('tool rejects an empty command tail', async () => {
  await snapshot('tool-empty-tail', await runCli(['tool', '--'], { client: fixtureClient() }));
});

test('tool --list text output groups Tools under their file with descriptions', async () => {
  await snapshot('tool-list', await runCli(['tool', '--list'], { client: fixtureClient(), env: { PWD: '/work/site' } }));
});

test('tool --list --json keeps warnings on stderr', async () => {
  await snapshot('tool-list-json', await runCli(['tool', '--list', '--json'], { client: fixtureClient(), env: { PWD: '/work/site' } }));
});

test('tool --list --global reports no project', async () => {
  await snapshot('tool-list-global', await runCli(['tool', '--list', '--global'], { client: fixtureClient(), env: { PWD: '/work/site' } }));
});

test('tool --list asks for the caller directory, or --cwd', async () => {
  const client = fixtureClient();
  await runCli(['tool', '--list', '--cwd', 'sub'], { client, env: { PWD: '/work/site' } });
  client.requests[0].request.cwd = smudgeWindowsPaths(client.requests[0].request.cwd);
  assert.deepEqual(client.requests, [{ method: 'toolList', request: { cwd: '/work/site/sub', global: false } }]);
});

test('tool --list takes no name, command, or placement flag', async () => {
  for (const argv of [['--list', 'storybook'], ['--list', '--', 'pnpm', 'dev'], ['--list', '--minimize'], ['--list', '--workspace', 'workspace:2']]) {
    const client = fixtureClient();
    const result = await runCli(['tool', ...argv], { client });
    assert.equal(result.exitCode, 1, argv.join(' '));
    assert.match(result.stderr, /--list takes (no tool name or command|only --global, --cwd, and --json)/);
    assert.deepEqual(client.requests, []);
  }
});

// Controls, and the format characters that reorder or hide text: what a person
// reads before approving a Tool must be what is there. Spelled out rather than
// built from `FORMAT_CHARACTERS`, so narrowing that set reddens this.
const HIDDEN = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u00a0\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3000\u3164\ufe00-\ufe0f\ufeff\u{e0001}\u{e0041}\u{e0100}]/u;

test('tool --list escapes control and format characters in repo text, in every output', async () => {
  const listing = {
    project: { path: '/work/s\u2067ite/dormouse.yml', approved: false },
    user: { path: '/home/me/.config/dormouse/dormouse.yml', found: false },
    tools: [
      { name: 'evil\u001b]52;c;x\u0007', scope: 'project', run: 'echo \u009b31m', render: 'iframe', port: 'auto', keyed: false, description: 'fine\u001b[2Jtext \u202eexe.txt \u00adsoft\u00a0nb\u3164fill\ufe0fsel\u{e0041}tag', shadowed: false },
      { name: 'imported', scope: 'user', run: ['x'], render: 'iframe', port: 'auto', keyed: false, description: null, shadowed: false, from: '/c/fr\u009dom/dormouse.yml' },
      { name: 'broken', scope: 'user', description: null, shadowed: false, from: '/c/b\u202eroken/dormouse.yml', broken: '/c/b/dormouse.yml: tools.x\u001b[2J: bad' },
    ],
    warnings: ['/work/site/dormouse.yml: tools.evil\u001b[2J\u200b: ignoring unknown field \'x\''],
  };
  const client = fixtureClient();
  client.toolList = async () => listing;
  const text = await runCli(['tool', '--list'], { client });
  assert.doesNotMatch(text.stdout, HIDDEN);
  assert.doesNotMatch(text.stderr, HIDDEN);
  assert.match(text.stdout, /evil\\u001b\]52;c;x\\u0007/);
  assert.match(text.stdout, /\\u009b31m/);
  assert.match(text.stdout, /fine\\u001b\[2Jtext \\u202eexe\.txt/);
  assert.match(text.stdout, /s\\u2067ite/);
  assert.match(text.stdout, /\\u00adsoft\\u00a0nb\\u3164fill\\ufe0fsel\\udb40\\udc41tag/);
  assert.match(text.stdout, /\[from \/c\/fr\\u009dom\/dormouse\.yml\]/);
  assert.match(text.stdout, /\[from \/c\/b\\u202eroken\/dormouse\.yml\]/);
  assert.match(text.stdout, /\[broken: \/c\/b\/dormouse\.yml: tools\.x\\u001b\[2J: bad\]/);
  const json = await runCli(['tool', '--list', '--json'], { client });
  assert.doesNotMatch(json.stdout, HIDDEN);
  assert.deepEqual(JSON.parse(json.stdout).tools, listing.tools);
});

test('tool and open escape control and format characters in the host answer, in every output', async () => {
  const answer = { status: 'created', commandState: 'unconfirmed', surfaceId: 'surface:9', command: 'run \u009b31m \u007f \u001b[2J \u202e', cwd: '/work/\u0085site\ufeff', minimized: false, key: 'k\u009d' };
  const client = fixtureClient();
  client.toolSurface = async () => answer;
  for (const argv of [['tool', 'evil'], ['tool', '--json', 'evil'], ['open', 'a.md'], ['open', '--json', 'a.md']]) {
    const result = await runCli(argv, { client, env: { PWD: '/work' } });
    assert.equal(result.exitCode, 0, argv.join(' '));
    assert.doesNotMatch(result.stdout, HIDDEN, argv.join(' '));
    assert.match(result.stdout, /\\u009b31m/, argv.join(' '));
    if (argv.includes('--json')) assert.equal(JSON.parse(result.stdout).command, answer.command);
  }
});

test('list escapes control characters in Tool commands, titles, locations, and Workspace names', async () => {
  const evil = { ...fixtureSurfaces[0], kind: 'tool', title: 'site\u009b31m', cwd: '/work/\u007fsite', command: 'run \u001b]52;c;x\u0007 \u0085',
    toolName: 'docs\u001b[2J', toolScope: 'project', toolOrigin: { file: '/work/\u009dsite/dormouse.yml' } };
  const client = fixtureClient([evil]);
  client.listWorkspaces = async () => ({ workspaces: [{ ...fixtureWorkspaces[0], name: 'ws\u009d' }], windowRef: 'window:1' });
  const controls = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
  for (const argv of [['list'], ['list', '--json'], ['list', '--workspaces'], ['list', '--workspaces', '--json']]) {
    const result = await runCli(argv, { client });
    assert.equal(result.exitCode, 0, argv.join(' '));
    assert.doesNotMatch(result.stdout, controls, argv.join(' '));
  }
  const row = JSON.parse((await runCli(['list', '--json'], { client })).stdout).surfaces[0];
  assert.equal(row.command, evil.command);
  assert.equal(row.tool_name, evil.toolName);
  assert.deepEqual(row.tool_origin, evil.toolOrigin);
});

test('workspace verbs escape control characters in the Workspace name', async () => {
  const client = fixtureClient();
  client.switchWorkspace = async () => ({ status: 'active', workspaceId: 'workspace:2', name: 'ws\u009d\u007f' });
  for (const argv of [['workspace', 'switch', 'workspace:2'], ['workspace', 'switch', '--json', 'workspace:2']]) {
    const result = await runCli(argv, { client });
    assert.equal(result.exitCode, 0, argv.join(' '));
    assert.doesNotMatch(result.stdout, /[\x7f-\x9f]/, argv.join(' '));
  }
  assert.equal(JSON.parse((await runCli(['workspace', 'switch', '--json', 'workspace:2'], { client })).stdout).name, 'ws\u009d\u007f');
});

test('tool rejects an unknown option', async () => {
  await snapshot('tool-unknown-option', await runCli(['tool', '--nope', 'storybook'], { client: fixtureClient() }));
});

test('tool routes named and anonymous launches to an explicit Workspace', async () => {
  for (const tail of [['storybook'], ['--', 'pnpm', 'dev']]) {
    const client = fixtureClient();
    const result = await runCli(['tool', '--workspace', 'workspace:2', ...tail], { client, env: { PWD: '/work/site' } });
    assert.equal(result.exitCode, 0);
    assert.equal(client.requests[0].method, 'toolSurface');
    assert.equal(client.requests[0].request.workspace, 'workspace:2');
  }
});

test('open forwards one file, explicit handler, placement, and Workspace to Tool dispatch', async () => {
  const client = fixtureClient();
  const result = await runCli(['open', '--json', '--tool', 'markdown', '--workspace', 'workspace:2', '--fresh', '--minimize', '--from', 'surface:4', 'a b.md'], { client, env: { PWD: '/repo' } });
  assert.equal(result.exitCode, 0);
  client.requests[0].request.cwd = smudgeWindowsPaths(client.requests[0].request.cwd);
  assert.deepEqual(client.requests[0], { method: 'toolSurface', request: {
    file: 'a b.md', tool: 'markdown', cwd: '/repo',
    workspace: 'workspace:2', fresh: true, minimized: true, focus: false, surface: 'surface:4',
  } });
  assert.equal(JSON.parse(result.stdout).surface_id, 'surface:4');
});

test('open --preview asks for the preview slot and prints its retarget', async () => {
  const client = fixtureClient();
  client.toolSurface = async function toolSurface(request) {
    this.requests.push({ method: 'toolSurface', request });
    return { status: 'retargeted', commandState: 'running', surfaceId: 'surface:5', command: 'viewer a.md', cwd: request.cwd, minimized: false, key: null };
  };
  const result = await runCli(['open', '--preview', 'a.md'], { client, env: { PWD: '/repo' } });
  assert.equal(result.exitCode, 0);
  assert.equal(client.requests[0].request.preview, true);
  assert.equal(result.stdout, 'retargeted surface:5  [running]  "viewer a.md"\n');
  const plain = fixtureClient();
  await runCli(['open', 'a.md'], { client: plain, env: { PWD: '/repo' } });
  assert.equal('preview' in plain.requests[0].request, false);
});

test('open, tool, and tool --list escape control characters in a host error', async () => {
  const client = fixtureClient();
  const failure = async () => { throw new Error('ENAMETOOLONG: name too long, realpath \'/tmp/x\u001b]0;pwn\u0007\''); };
  client.toolSurface = failure;
  client.toolList = failure;
  for (const argv of [['open', 'a.md'], ['tool', 'viewer'], ['tool', '--list']]) {
    const result = await runCli(argv, { client, env: { PWD: '/repo' } });
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(result.stderr, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    assert.match(result.stderr, /x\\u001b\]0;pwn\\u0007/);
  }
});

test('open --preview refuses --fresh and --minimize before asking the host', async () => {
  for (const flag of ['--fresh', '--minimize']) {
    const client = fixtureClient();
    const result = await runCli(['open', '--preview', flag, 'a.md'], { client, env: { PWD: '/repo' } });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(`--preview cannot be combined with ${flag}`));
    assert.equal(client.requests.length, 0);
  }
});

test('open forwards a folder to Tool dispatch as it forwards a file', async () => {
  const client = fixtureClient();
  const result = await runCli(['open', '--preview', 'docs/'], { client, env: { PWD: '/repo' } });
  assert.equal(result.exitCode, 0);
  client.requests[0].request.cwd = smudgeWindowsPaths(client.requests[0].request.cwd);
  assert.deepEqual(client.requests[0], { method: 'toolSurface', request: {
    file: 'docs/', cwd: '/repo', fresh: false, minimized: false, focus: false, surface: undefined, tool: undefined, preview: true,
  } });
});

test('open requires exactly one file', async () => {
  for (const args of [['open'], ['open', 'one.md', 'two.md']]) {
    const client = fixtureClient();
    const result = await runCli(args, { client });
    assert.equal(result.exitCode, 1);
    assert.equal(client.requests.length, 0);
  }
});


test('valued options preserve literal arguments in separate and equals forms', async () => {
  for (const value of ['', '--help', '-h', '--text', '--', 'a=b', 'first\nsecond', '🐭']) {
    for (const option of [['--text', value], [`--text=${value}`]]) {
      const client = fixtureClient();
      const result = await runCli(['send', 'surface:1', ...option, '--key', 'enter'], { client });
      assert.equal(result.exitCode, 0, JSON.stringify({ option, result }));
      assert.deepEqual(client.requests[0].request.events, [{ text: value }, { key: 'enter' }]);
    }
  }
});

test('a valued option containing help does not suppress validation or later real help', async () => {
  const client = fixtureClient();
  const invalid = await runCli(['send', 'surface:1', '--text', '--help', '--wat'], { client });
  assert.equal(invalid.exitCode, 1);
  assert.equal(client.requests.length, 0);
  const help = await runCli(['send', '--text', '--help', '--help'], { client });
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /USAGE/);
  assert.equal(client.requests.length, 0);
});


test('argument errors report original values, never scanner transport tokens', async () => {
  const client = fixtureClient();
  const duplicate = await runCli(['read', 'surface:1', '--lines', '2', '--lines', '3'], { client });
  assert.match(duplicate.stderr, /encountered "3" after "2"/);
  const invalid = await runCli(['read', 'surface:1', '--lines', '--help'], { client });
  assert.match(invalid.stderr, /invalid --lines '--help'/);
  assert.equal(client.requests.length, 0);
});


test('browser identity values use the same literal option contract', () => {
  for (const value of ['--help', '--json', '--', 'first\nsecond']) {
    for (const args of [['--session', value], [`--session=${value}`]]) {
      assert.deepEqual(extractSessionFlags([...args, 'snapshot'], { sessionNoun: 'session' }), {
        ok: true, value: { session: value, rest: ['snapshot'] },
      });
    }
  }
});

test('browser providers read Dormouse options anywhere, as the native CLIs read theirs', async () => {
  // `open :5173 --key app`, options after the command, is the providers' own shape.
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  const result = await runCli(['agent-browser', 'open', ':5173', '--headed', '--key', 'app'], { client, execAgentBrowser: ab.exec });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(ab.calls[0], ['agent-browser', '--session', 'dormouse.1.app', 'open', 'http://localhost:5173/', '--headed']);
  assert.equal(client.requests[0].request.key, 'app');
  assert.deepEqual(extractSessionFlags(['snapshot', '-i', '--workspace=workspace-name:build', '--session', 'raw'], { sessionNoun: 'session' }), {
    ok: true, value: { session: 'raw', rest: ['snapshot', '-i'], workspace: 'workspace-name:build' },
  });
});

test('a bare -- ends interception and forwards with the rest verbatim', async () => {
  const tail = ['eval', '--surface', '--key', '--workspace=x', '--', '', 'a\nb'];
  assert.deepEqual(extractSessionFlags(['--key', 'app', '--', ...tail], { sessionNoun: 'session' }), {
    ok: true, value: { key: 'app', rest: ['--', ...tail] },
  });
  const ab = fakeAgentBrowser();
  const result = await runCli(['agent-browser', 'eval', '--session', 'raw', '--', ...tail.slice(1)], { execAgentBrowser: ab.exec, env: {} });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(ab.calls[0], ['agent-browser', '--session', 'raw', tail[0], '--', ...tail.slice(1)]);
});

test('only a lone --help is Dormouse help; any other goes to the provider', async () => {
  const ab = fakeAgentBrowser();
  const help = await runCli(['agent-browser', '--help'], { execAgentBrowser: ab.exec });
  assert.match(help.stdout, /USAGE/);
  assert.deepEqual(ab.calls, []);
  for (const argv of [['agent-browser', 'open', '--help'], ['agent-browser', 'snapshot', '--', '--help']]) {
    const native = fakeAgentBrowser();
    await runCli(argv, { execAgentBrowser: native.exec, env: {} });
    assert.deepEqual(native.calls[0], ['agent-browser', '--session', 'dormouse.1.default', ...argv.slice(1)]);
  }
});

test('named Tool arguments need -- only when they begin with a dash', async () => {
  for (const [argv, args] of [[['tool', 'viewer', 'a.md', 'b.md'], ['a.md', 'b.md']], [['tool', 'viewer', '--', '--json', '--help', '--', '', 'a\nb'], ['--json', '--help', '--', '', 'a\nb']]]) {
    const client = fixtureClient();
    const result = await runCli(argv, { client });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(client.requests[0].request.args, args);
  }
});

test('empty browser identities fail before a provider or host request', async () => {
  for (const provider of ['agent-browser', 'playwright']) {
    for (const flag of ['--session', '--key', '--surface', '--workspace', '--from', ...(provider === 'playwright' ? ['-s'] : [])]) {
      for (const args of [[flag, ''], [`${flag}=`]]) {
        const client = fixtureClient();
        const invoked = [];
        const exec = async (...args) => { invoked.push(args); return { exitCode: 0, stdout: '', stderr: '' }; };
        const result = await runCli([provider, ...args, 'click', '@e3'], { client, execAgentBrowser: exec, execPlaywright: exec });
        assert.equal(result.exitCode, 1, JSON.stringify({ provider, args, result }));
        assert.match(result.stderr, /requires a value/);
        assert.deepEqual(invoked, []);
        assert.deepEqual(client.requests, []);
      }
    }
  }
});

test('native browser option terminators survive before dash-leading values', async () => {
  for (const provider of ['agent-browser', 'playwright']) {
    for (const tail of [['fill', '@e1', '--', '-5'], ['fill', '@e1', '--', '--session'], ['fill', '@e1', '--', '--focus']]) {
      const calls = [];
      const exec = async (binary, args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '' }; };
      const result = await runCli([provider, '--session', 'raw', ...tail], { execAgentBrowser: exec, execPlaywright: exec, env: {} });
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.deepEqual(calls[0], [...(provider === 'playwright' ? ['--session=raw'] : ['--session', 'raw']), ...tail]);
    }
  }
});

test('a -- before the provider command is refused before anything runs', async () => {
  for (const provider of ['agent-browser', 'playwright']) {
    for (const argv of [['--', 'open', ':5173'], ['--key', 'app', '--', 'open', ':5173'], ['--', 'dor-embed-size']]) {
      const calls = [];
      const exec = async (binary, args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '' }; };
      const client = fixtureClient();
      const result = await runCli([provider, ...argv], { client, execAgentBrowser: exec, execPlaywright: exec, env: {} });
      assert.equal(result.exitCode, 1, JSON.stringify(argv));
      assert.match(result.stderr, /put -- after the .* command/);
      assert.deepEqual(calls, []);
      assert.deepEqual(client.requests, []);
    }
  }
});

test('send preserves repeated event order and inserts stdin without changing its text', async () => {
  const client = fixtureClient();
  const result = await runCli(['send', 'surface:1', '--key', 'escape', '--text', 'C:\\tmp\\n', '--stdin', '--key', 'enter', '--text=last'], { client, readStdin: async () => 'line\r\nnext\t🐭' });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(client.requests[0].request.events, [{ key: 'escape' }, { text: 'C:\\tmp\\n' }, { text: 'line\r\nnext\t🐭' }, { key: 'enter' }, { text: 'last' }]);
});

test('send validates all events before reading stdin or contacting the host', async () => {
  for (const args of [['--stdin', '--key', 'not-a-key'], ['--sequence', '[{"text":"first"},{"key":"bad"}]'], ['--sequence', '[{"text":"first","extra":true}]'], ['--sequence', '[{"text":"first"}]', '--stdin'], ['--stdin', '--stdin']]) {
    const client = fixtureClient();
    const result = await runCli(['send', 'surface:1', ...args], { client, readStdin: () => assert.fail('must validate before reading stdin') });
    assert.equal(result.exitCode, 1, args.join(' '));
    assert.deepEqual(client.requests, []);
  }
});

test('send does not claim success until host delivery and never retries a failed batch', async () => {
  let finish;
  let calls = 0;
  let completed = false;
  const pending = runCli(['send', 'surface:1', '--text', 'hello'], { client: { sendSurface: () => { calls++; return new Promise((_resolve, reject) => { finish = reject; }); } } }).then(result => { completed = true; return result; });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  finish(new Error('PTY died after partial delivery'));
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /partial delivery/);
  assert.equal(calls, 1);
});


test('JSON errors are objects for parsing, host, and endpoint failures', async () => {
  const cases = [
    [['read', 'surface:1', '--lines', '0', '--json'], { client: fixtureClient() }, 'INVALID_ARGUMENT'],
    [['ensure', '--json', 'oops'], { client: fixtureClient() }, 'INVALID_ARGUMENT'],
    [['unknown', '--json'], {}, 'INVALID_ARGUMENT'],
    [['read', 'surface:1', '--json'], { env: {} }, 'CONTROL_UNAVAILABLE'],
    [['read', 'surface:1', '--json'], { client: { readSurface: async () => { throw new Error('host refused \u001b[31m \n Unicode 🐭'); } } }, 'COMMAND_FAILED'],
    [['await', 'surface:1', '--until', 'exit', '--json'], { client: awaitClient({ outcome: 'died', waitedMs: 3 }) }, 'SURFACE_DIED'],
  ];
  for (const [argv, options, code] of cases) {
    const result = await runCli(argv, options);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).error.code, code, JSON.stringify(result));
    assert.ok(JSON.parse(result.stdout).error.message);
  }
  const literal = await runCli(['read', '--workspace', '--json', 'surface:1'], { env: {} });
  assert.equal(literal.stdout, '');
  const help = await runCli(['read', '--json', '--help']);
  assert.match(help.stdout, /USAGE/);
});


test('JSON errors preserve original text while both output channels escape terminal controls', async () => {
  const message = 'C:\\tmp\n \u001b[2J \u202e 🐭';
  for (const argv of [['tool', 'example'], ['read', 'surface:1']]) {
    const client = { toolSurface: async () => { throw new Error(message); }, readSurface: async () => { throw new Error(message); } };
    for (const json of ['--json', '--json=true']) {
      const result = await runCli([...argv, json], { client });
      assert.equal(JSON.parse(result.stdout).error.message, message);
      assert.doesNotMatch(result.stdout + result.stderr, HIDDEN);
    }
  }
});

test('launch output reports command_state in text and JSON', async () => {
  for (const [status, commandState] of [['pending', 'awaiting_approval'], ['takeover', 'queued'], ['created', 'unconfirmed'], ['existing', 'running'], ['superseded', 'ended']]) {
    const client = { toolSurface: async () => ({ status, commandState, surfaceId: 'surface:2', command: 'server', cwd: '/repo', minimized: false, key: null }) };
    const json = await runCli(['tool', 'server', '--json'], { client });
    assert.equal(json.exitCode, 0);
    assert.equal(JSON.parse(json.stdout).command_state, commandState);
    assert.equal(JSON.parse(json.stdout).status, status);
    assert.equal('completion' in JSON.parse(json.stdout), false);
    const text = await runCli(['tool', 'server'], { client });
    assert.equal(text.stdout, `${status} surface:2  [${commandState}]  "server"\n`);
  }
});

test('agent-browser exits 4 when its successful command cannot bind a pane', async () => {
  const ab = fakeAgentBrowser();
  const client = fixtureClient();
  client.browserSurface = async () => { throw new Error('pane unavailable'); };
  const result = await runCli(['agent-browser', 'open', ':5173', '--json'], { client, execAgentBrowser: ab.exec });
  assert.equal(result.exitCode, 4);
  assert.equal(result.stdout, '✓ ok\n');
  assert.match(result.stderr, /agent-browser command succeeded/);
  assert.match(result.stderr, /pane unavailable/);
  assert.match(result.stderr, /already ran; do not repeat it blindly/);
  assert.equal(ab.calls.filter(args => args.includes('open')).length, 1);
});

test('creation uses --from and rejects the old --surface spelling before host calls', async () => {
  for (const args of [['split'], ['ensure', '--', 'echo'], ['tool', '--', 'echo'], ['open', 'a.md'], ['iframe', ':5173']]) {
    const client = fixtureClient();
    const result = await runCli([args[0], '--from', 'surface:8', ...args.slice(1)], { client });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(client.requests.at(-1).request.surface, 'surface:8');
    const rejected = fixtureClient();
    const old = await runCli([args[0], '--surface', 'surface:8', ...args.slice(1)], { client: rejected });
    assert.equal(old.exitCode, 1);
    assert.equal(rejected.requests.length, 0);
  }
});

test('browser placement is carried through resolution and binding, never forwarded', async () => {
  const client = fixtureClient();
  const ab = fakeAgentBrowser();
  const result = await runCli(['agent-browser', 'open', ':5173', '--from', 'surface:8', '--key', 'docs'], { client, execAgentBrowser: ab.exec });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(client.requests.find(r => r.method === 'resolveBrowser').request.from, 'surface:8');
  assert.equal(client.requests.find(r => r.method === 'browserSurface').request.from, 'surface:8');
  assert.equal(ab.calls.some(args => args.includes('--from')), false);
  const before = ab.calls.length;
  const bad = await runCli(['agent-browser', 'open', ':5173', '--from', 'surface:8', '--surface', 'surface:3'], { client, execAgentBrowser: ab.exec });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /--from and --surface are mutually exclusive/);
  assert.equal(ab.calls.length, before);
  // After the bare `--`, a --from is the provider's.
  const forwarded = await runCli(['agent-browser', '--key', 'docs', 'eval', '--', '--from'], { client, execAgentBrowser: ab.exec });
  assert.equal(forwarded.exitCode, 0, forwarded.stderr);
  assert.deepEqual(ab.calls.find(args => args.includes('eval')).slice(-3), ['eval', '--', '--from']);
});

test('reference prefixes are required before any host mutation', async () => {
  for (const args of [['list', '--workspace', '2'], ['split', '--workspace', 'build'], ['workspace', 'switch', 'build'], ['move', 'surface:1', '2'], ['list', '--window', 'main'], ['workspace', 'move', 'workspace:2', '--window', 'new']]) {
    const client = fixtureClient();
    const result = await runCli(args, { client });
    assert.equal(result.exitCode, 1, JSON.stringify(args));
    assert.equal(client.requests.length, 0);
  }
  for (const provider of ['agent-browser', 'playwright']) {
    const client = fixtureClient();
    const ab = fakeAgentBrowser();
    const result = await runCli([provider, 'open', ':5173', '--workspace', 'build'], { client, execAgentBrowser: ab.exec, execPlaywright: ab.exec });
    assert.equal(result.exitCode, 1, provider);
    assert.match(result.stderr, /invalid Workspace reference 'build'/);
    assert.equal(ab.calls.length, 0);
    assert.equal(client.requests.length, 0);
  }
  const client = fixtureClient();
  const result = await runCli(['workspace', 'move', 'workspace-name:2', '--new-window'], { client });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(client.requests[0].request.workspace, 'workspace-name:2');
  assert.equal(client.requests[0].request.toWindow, 'new');
  const conflict = fixtureClient();
  assert.equal((await runCli(['workspace', 'move', 'workspace:2', '--new-window', '--window', 'window:main'], { client: conflict })).exitCode, 1);
  assert.equal(conflict.requests.length, 0);
});

test('send --stdin=true keeps its position among ordered events', async () => {
  const client = fixtureClient();
  const result = await runCli(['send', 'surface:1', '--text', 'first', '--stdin=true', '--key', 'Enter'], { client, readStdin: async () => 'second' });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(client.requests[0].request.events, [{ text: 'first' }, { text: 'second' }, { key: 'Enter' }]);
});
