import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamPort } from '../dist/index.js';

test('parseStreamPort reads a top-level port', () => {
  assert.equal(parseStreamPort(JSON.stringify({ port: 61218 })), 61218);
});

test('parseStreamPort reads a nested data.port', () => {
  assert.equal(parseStreamPort(JSON.stringify({ data: { port: 5173 } })), 5173);
});

test('parseStreamPort returns undefined for malformed or portless output', () => {
  assert.equal(parseStreamPort('not json'), undefined);
  assert.equal(parseStreamPort(JSON.stringify({ data: {} })), undefined);
  assert.equal(parseStreamPort(JSON.stringify({ port: 'nope' })), undefined);
});
