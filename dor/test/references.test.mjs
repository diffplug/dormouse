import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWorkspaceRef, isCanonicalWindowRef, parseSurfaceTarget } from '../dist/protocol.js';
const cases = JSON.parse(readFileSync(new URL('./reference-cases.json', import.meta.url), 'utf8'));
test('Workspace reference grammar shared with the Rust router', () => {
  for (const { input, id, name } of cases.workspaces) assert.deepEqual(parseWorkspaceRef(input), { target: input, id, name });
});
test('Window labels require their prefix and Surface titles remain literal', () => {
  for (const ref of ['window:main', 'window:ws-2']) assert.equal(isCanonicalWindowRef(ref), true);
  for (const ref of ['main', 'new', 'window:', ' window:main', 'window:main ']) assert.equal(isCanonicalWindowRef(ref), false);
  assert.deepEqual(parseSurfaceTarget('title: 2 '), { kind: 'title', title: ' 2 ' });
});
