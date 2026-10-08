import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSurfaceIds, parseSurfaceTarget, surfaceIdNumber, surfaceRefForId } from '../dist/protocol.js';

test('a Surface ref is its id number', () => {
  assert.equal(surfaceRefForId('surface-347'), 'surface:347');
  assert.equal(surfaceRefForId('surface-0b9c'), 'surface:0b9c');
  assert.equal(surfaceRefForId('pane-a'), 'pane-a');
  assert.equal(surfaceIdNumber('surface-347'), 347);
  assert.equal(surfaceIdNumber('surface-0b9c'), null);
  assert.equal(surfaceIdNumber('pane-a'), null);
});

test('a ref and a bare id name the same Surface', () => {
  assert.deepEqual(parseSurfaceTarget('surface:347'), { kind: 'id', id: 'surface-347' });
  assert.deepEqual(parseSurfaceTarget('surface-347'), { kind: 'id', id: 'surface-347' });
  assert.deepEqual(parseSurfaceTarget('pane-a'), { kind: 'id', id: 'pane-a' });
  assert.deepEqual(parseSurfaceTarget('surface:self'), { kind: 'self' });
  assert.deepEqual(parseSurfaceTarget('surface:focused'), { kind: 'focused' });
  assert.deepEqual(parseSurfaceTarget('title:build'), { kind: 'title', title: 'build' });
});

test('bare numbers, pane:N, and an empty surface: are refused with the surface:N form', () => {
  assert.deepEqual(parseSurfaceTarget('3'), { kind: 'invalid', message: "'3' is not a Surface handle; use surface:3" });
  assert.deepEqual(parseSurfaceTarget('pane:3'), { kind: 'invalid', message: "'pane:3' is not a Surface handle; use surface:3" });
  assert.deepEqual(parseSurfaceTarget('pane:a'), { kind: 'invalid', message: "'pane:a' is not a Surface handle; use surface:<n>" });
  assert.deepEqual(parseSurfaceTarget('surface:'), { kind: 'invalid', message: "'surface:' is not a Surface handle; use surface:<n>" });
});

test('Surface ids sort by number, other ids last', () => {
  const ids = ['pane-b', 'surface-10', 'surface-uuid', 'surface-2', 'pane-a', 'surface-1'];
  assert.deepEqual([...ids].sort(compareSurfaceIds), ['surface-1', 'surface-2', 'surface-10', 'pane-a', 'pane-b', 'surface-uuid']);
});
