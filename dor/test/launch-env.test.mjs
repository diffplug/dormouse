import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../dist/cli.js';

test('private launch helper returns a framed environment without the Electron launcher flag', async () => {
  const marker = 'abcdef0123456789abcdef0123456789';
  const result = await runCli(['__launch-env', marker], { env: { PATH: '/shell/bin', VALUE: 'line\nvalue', ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  const payload = result.stdout.trim().slice(marker.length + 1);
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64').toString()), { PATH: '/shell/bin', VALUE: 'line\nvalue' });
});
