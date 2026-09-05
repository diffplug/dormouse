import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HELLO_ROUTE, helloResponse } from '../dist/index.js';

test('HELLO_ROUTE is the shared API path', () => {
  assert.equal(HELLO_ROUTE, '/api/hello');
});

test('helloResponse defaults to world', () => {
  assert.deepEqual(helloResponse(), { message: 'Hello, world!' });
});

test('helloResponse greets the given name', () => {
  assert.deepEqual(helloResponse('dormouse'), { message: 'Hello, dormouse!' });
});
