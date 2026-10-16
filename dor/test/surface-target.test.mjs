import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareSurfaceIds, parseSurfaceTarget, surfaceIdFor, surfaceIdNumber, workspaceIdFor, workspaceIdNumber } from '../dist/protocol.js';

/** The id grammar's cases, shared with Rust's `ids::Kind::number` and the
 *  browser dev harness. */
const idCases = JSON.parse(readFileSync(new URL('./id-cases.json', import.meta.url), 'utf8'));

test('a Surface id is surface:<n>, and its number is the counter', () => {
  assert.equal(surfaceIdFor(347), 'surface:347');
  assert.equal(surfaceIdNumber('surface:347'), 347);
  assert.equal(surfaceIdNumber('surface:0b9c'), null);
  assert.equal(surfaceIdNumber('surface-347'), null);
  assert.equal(workspaceIdFor(3), 'workspace:3');
});

test('an id\'s number reads as the shared cases say, for each kind and only its own', () => {
  const kinds = [['surface:', surfaceIdNumber], ['workspace:', workspaceIdNumber]];
  for (const [prefix, read] of kinds) {
    for (const { suffix, number } of idCases.numbered) {
      assert.equal(read(prefix + suffix), number, prefix + suffix);
      for (const [other, readOther] of kinds) if (other !== prefix) assert.equal(readOther(prefix + suffix), null, `${other} ${prefix}${suffix}`);
    }
  }
  for (const id of idCases.unnumbered) for (const [, read] of kinds) assert.equal(read(id), null, id);
});

test('the handle is the id', () => {
  assert.deepEqual(parseSurfaceTarget('surface:347'), { kind: 'id', id: 'surface:347' });
  assert.deepEqual(parseSurfaceTarget('surface:0b9c'), { kind: 'id', id: 'surface:0b9c' });
  assert.deepEqual(parseSurfaceTarget('surface:self'), { kind: 'self' });
  assert.deepEqual(parseSurfaceTarget('surface:focused'), { kind: 'focused' });
  assert.deepEqual(parseSurfaceTarget('title:build'), { kind: 'title', title: 'build' });
});

test('bare numbers, pane:N, surface-N, bare strings, and an empty surface: are refused with the surface:N form', () => {
  assert.deepEqual(parseSurfaceTarget('3'), { kind: 'invalid', message: "'3' is not a Surface handle; use surface:3" });
  assert.deepEqual(parseSurfaceTarget('pane:3'), { kind: 'invalid', message: "'pane:3' is not a Surface handle; use surface:3" });
  assert.deepEqual(parseSurfaceTarget('surface-3'), { kind: 'invalid', message: "'surface-3' is not a Surface handle; use surface:3" });
  assert.deepEqual(parseSurfaceTarget('pane:a'), { kind: 'invalid', message: "'pane:a' is not a Surface handle; use surface:<n>" });
  assert.deepEqual(parseSurfaceTarget('pane-a'), { kind: 'invalid', message: "'pane-a' is not a Surface handle; use surface:<n>" });
  assert.deepEqual(parseSurfaceTarget('surface:'), { kind: 'invalid', message: "'surface:' is not a Surface handle; use surface:<n>" });
});

test('Surface ids sort by number, other ids last', () => {
  const ids = ['surface:b', 'surface:10', 'surface:uuid', 'surface:2', 'surface:a', 'surface:1'];
  assert.deepEqual([...ids].sort(compareSurfaceIds), ['surface:1', 'surface:2', 'surface:10', 'surface:a', 'surface:b', 'surface:uuid']);
});
