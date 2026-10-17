import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './bundle.mjs';

const { DRAG_THRESHOLD, dragSize, pastThreshold, savedSize } = await load('../viewer/image-drag.ts');

test('a handle resizes only once it travels past the threshold', () => {
  assert.equal(pastThreshold(0.5, -0.5), false, 'sub-pixel jitter');
  assert.equal(pastThreshold(1, 1), false);
  assert.equal(pastThreshold(DRAG_THRESHOLD, 0), true);
  assert.equal(pastThreshold(-1.5, 1.5), true);
});

test('a corner drag keeps the aspect, within the column', () => {
  const start = { width: 400, height: 200 };
  assert.deepEqual(dragSize(start, 100, 0, 16, 1000), { width: 480, height: 240 });
  assert.deepEqual(dragSize(start, 0, 0, 16, 1000), start);
  assert.deepEqual(dragSize(start, 1000, 1000, 16, 600), { width: 600, height: 300 });
  assert.deepEqual(dragSize(start, -1000, 0, 32, 600), { width: 32, height: 16 });
});

test('a release saves only a width that changed', () => {
  const start = { width: 400.4, height: 200.2 };
  assert.equal(savedSize(start, null), null, 'never past the threshold, or cancelled');
  assert.equal(savedSize(start, { width: 400, height: 200 }), null, 'back at the width it started at');
  assert.deepEqual(savedSize(start, { width: 401, height: 201 }), { width: 401, height: 201 });
});
