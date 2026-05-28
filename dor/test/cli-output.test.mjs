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

function fixtureClient() {
  return {
    requests: [],
    async listSurfaces(request) {
      this.requests.push(request);
      const focusedPaneRef = fixtureSurfaces.find((surface) => surface.focused)?.paneRef;
      const paneTarget = request.pane === 'focused' ? focusedPaneRef : request.pane;
      const surfaces = paneTarget
        ? fixtureSurfaces.filter((surface) => (
          surface.paneRef === paneTarget ||
          surface.ref === paneTarget ||
          surface.id === paneTarget
        ))
        : fixtureSurfaces;
      return {
        surfaces,
        windowRef: 'window:1',
        workspaceRef: 'workspace:1',
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
  ].join('\n') + '\n';
  const path = join(snapshotsDir, `${name}.snap`);
  if (updateSnapshots) {
    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(path, actual);
    return;
  }
  const expected = await readFile(path, 'utf8');
  assert.equal(actual, expected);
}

test('global help output', async () => {
  await snapshot('global-help', await runCli(['--help']));
});

test('new-split help output', async () => {
  await snapshot('new-split-help', await runCli(['new-split', '--help']));
});

test('new-split pending implementation output', async () => {
  await snapshot(
    'new-split-unimplemented',
    await runCli(['new-split', 'right'], {
      env: {
        DORMOUSE_CONTROL_SOCKET: '/tmp/dormouse.sock',
        DORMOUSE_CONTROL_TOKEN: 'token',
      },
    }),
  );
});

test('list-surfaces help output', async () => {
  await snapshot('list-surfaces-help', await runCli(['list-surfaces', '--help']));
});

test('list-panes help output', async () => {
  await snapshot('list-panes-help', await runCli(['list-panes', '--help']));
});

test('list-pane-surfaces help output', async () => {
  await snapshot('list-pane-surfaces-help', await runCli(['list-pane-surfaces', '--help']));
});

test('list-panels help output', async () => {
  await snapshot('list-panels-help', await runCli(['list-panels', '--help']));
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

test('list-surfaces legacy alias output', async () => {
  await snapshot('list-surfaces-alias', await runCli(['list-surfaces'], { client: fixtureClient() }));
});

test('list-panels text output', async () => {
  await snapshot('list-panels-alias', await runCli(['list-panels'], { client: fixtureClient() }));
});

test('list-panels id-format both output', async () => {
  await snapshot(
    'list-panels-id-format-both',
    await runCli(['list-panels', '--id-format', 'both'], { client: fixtureClient() }),
  );
});

test('list-panels json output', async () => {
  await snapshot(
    'list-panels-json',
    await runCli(['list-panels', '--json'], { client: fixtureClient() }),
  );
});

test('list-pane-surfaces pane-scoped alias output', async () => {
  const client = fixtureClient();
  const result = await runCli(['list-pane-surfaces'], { client });
  assert.deepEqual(client.requests, [{ pane: 'focused', workspace: undefined, window: undefined }]);
  await snapshot('list-pane-surfaces-alias', result);
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

test('focus-surface help output', async () => {
  await snapshot('focus-surface-help', await runCli(['focus-surface', '--help']));
});

test('focus-surface pending implementation output', async () => {
  await snapshot(
    'focus-surface-unimplemented',
    await runCli(['focus-surface', 'surface:1'], {
      env: {
        DORMOUSE_CONTROL_SOCKET: '/tmp/dormouse.sock',
        DORMOUSE_CONTROL_TOKEN: 'token',
      },
    }),
  );
});

test('unknown command output', async () => {
  await snapshot('unknown-command', await runCli(['wat']));
});

test('missing control endpoint output', async () => {
  await snapshot('missing-control-endpoint', await runCli(['focus-surface', 'surface:1']));
});

test('unsupported workspace output', async () => {
  await snapshot(
    'unsupported-workspace',
    await runCli(['list-surfaces', '--workspace', 'workspace:2'], { client: fixtureClient() }),
  );
});
