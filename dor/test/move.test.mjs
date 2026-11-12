import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../dist/cli.js';
import { spansWorkspaces } from '../dist/protocol.js';

const response = { status: 'moved', surfaceId: 'surface:4', workspaceId: 'workspace:2' };
test('move targets a Workspace named new and prints the moved id', async () => {
  let received;
  const result = await runCli(['move', 'surface:3', 'workspace-name:new', '--workspace', 'workspace-name:source'], { client: { moveSurface: async request => { received = request; return response; } } });
  assert.equal(result.stdout, 'moved surface:4 workspace:2\n');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(received, { surface: 'surface:3', destination: { workspace: 'workspace-name:new' }, workspace: 'workspace-name:source', focus: false, dangerouslyDestroyIframePageState: false });
});
test('move --new-workspace carries focus and iframe consent and prints the ids in JSON', async () => {
  let received;
  const result = await runCli(['move', 'surface:4', '--new-workspace', '--focus', '--dangerously-destroy-iframe-page-state', '--json'], { client: { moveSurface: async request => { received = request; return response; } } });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(received, { surface: 'surface:4', destination: { new: true }, focus: true, dangerouslyDestroyIframePageState: true });
  assert.deepEqual(JSON.parse(result.stdout), { status: 'moved', surface_id: 'surface:4', workspace_id: 'workspace:2' });
});
test('move requires exactly one destination before contacting the host', async () => {
  for (const args of [['surface:3'], ['surface:3', 'workspace:2', '--new-workspace'], ['surface:3', 'workspace:2', 'workspace:3']]) {
    const result = await runCli(['move', ...args], { client: { moveSurface: () => { throw new Error('host should not be contacted'); } } });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /exactly one destination/);
  }
  // The old flag spelling and a bare destination are refused too.
  for (const args of [['surface:3', '--new'], ['surface:3', '2']]) {
    let contacted = false;
    const result = await runCli(['move', ...args], { client: { moveSurface: async () => { contacted = true; return response; } } });
    assert.equal(result.exitCode, 1, args.join(' '));
    assert.equal(contacted, false, args.join(' '));
  }
  assert.equal(spansWorkspaces('surface.move'), true);
});
