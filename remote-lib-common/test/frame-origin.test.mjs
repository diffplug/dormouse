import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRAME_BOOTSTRAP_PATH, FRAME_WORKER_PATH, frameOriginFor, isFrameAssetPath } from '../dist/index.js';

const scope = {
  domain: 'frames.example',
  salt: new Uint8Array(32).fill(1),
  burrowId: 'burrow-1',
  surfaceId: 'surface:1',
  pageOrigin: 'http://localhost:5173',
};

test('a frame origin is one valid https host label, stable for its scope', async () => {
  const origin = await frameOriginFor(scope);
  assert.match(origin, /^https:\/\/[0-9a-f]{32}\.frames\.example$/);
  assert.equal(await frameOriginFor(scope), origin);
});

test('every part of the scope makes another origin, so no two pages or phones share one', async () => {
  const origin = await frameOriginFor(scope);
  for (const change of [
    { salt: new Uint8Array(32).fill(2) },
    { burrowId: 'burrow-2' },
    { surfaceId: 'surface:2' },
    { pageOrigin: 'http://localhost:5174' },
  ]) {
    assert.notEqual(await frameOriginFor({ ...scope, ...change }), origin, JSON.stringify(Object.keys(change)));
  }
});

test('the frame origin own paths are its worker and its directory, never a page path', () => {
  assert.ok(isFrameAssetPath(FRAME_WORKER_PATH));
  assert.ok(isFrameAssetPath(FRAME_BOOTSTRAP_PATH));
  assert.ok(!isFrameAssetPath('/'));
  assert.ok(!isFrameAssetPath('/__dormouse-frame'));
  assert.ok(!isFrameAssetPath('/app/__dormouse-frame/x'));
});
