import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../dist/cli.js';

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
    requestedWorkingDirectory: '/Users/example/.codex/worktrees/0cbc/mouseterm',
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
    requestedWorkingDirectory: '/workspace/app/packages/repo',
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
      return {
        status: 'created',
        surfaceId: '33333333-3333-4333-8333-333333333333',
        surfaceRef: 'surface:3',
        direction: request.direction === 'auto' ? 'right' : request.direction,
        minimized: request.minimized,
        ...(request.command ? { command: request.command } : {}),
      };
    },
    async ensureSurface(request) {
      this.requests.push({ method: 'ensureSurface', request });
      const title = request.title ?? request.command;
      return {
        status: title === 'dev server' ? 'existing' : 'created',
        surfaceId: '33333333-3333-4333-8333-333333333333',
        surfaceRef: 'surface:3',
        title,
        command: request.command,
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
    await runCli(['split', '--down', '--minimize', '--command', 'pnpm dev'], { client: fixtureClient() }),
  );
});

test('split json output', async () => {
  await snapshot(
    'split-json',
    await runCli(['split', '--command', 'pnpm dev', '--json'], { client: fixtureClient() }),
  );
});

test('ensure text output', async () => {
  await snapshot(
    'ensure-text',
    await runCli(['ensure', '--title', 'dev server', '--', 'pnpm', 'dev:workspace'], { client: fixtureClient() }),
  );
});

test('ensure json output', async () => {
  await snapshot(
    'ensure-json',
    await runCli(['ensure', '--json', '--minimize', '--', 'pnpm', 'dev:workspace'], { client: fixtureClient() }),
  );
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
  assert.deepEqual(client.requests, [{ pane: 'focused', workspace: undefined, window: undefined }]);
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

test('unsupported workspace output', async () => {
  await snapshot(
    'unsupported-workspace',
    await runCli(['list-panes', '--workspace', 'workspace:2'], { client: fixtureClient() }),
  );
});

test('ensure missing command output', async () => {
  await snapshot('ensure-missing-command', await runCli(['ensure'], { client: fixtureClient() }));
});

test('split conflicting direction output', async () => {
  await snapshot('split-conflicting-direction', await runCli(['split', '--left', '--right'], { client: fixtureClient() }));
});
