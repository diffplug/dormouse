import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnAndCapture } from '../dist/index.js';

const node = process.execPath;

test('captures stdout and a zero exit code', async () => {
  const result = await spawnAndCapture(node, ['-e', 'process.stdout.write("hello")']);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello');
});

test('captures stderr and a non-zero exit code', async () => {
  const result = await spawnAndCapture(node, ['-e', 'process.stderr.write("boom"); process.exit(3)']);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, 'boom');
});

test('reports a missing binary as a spawn failure, never throwing', async () => {
  const result = await spawnAndCapture('dormouse-no-such-binary-xyz', []);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ENOENT');
});
