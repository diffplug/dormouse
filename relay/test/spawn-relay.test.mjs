/**
 * The spawn helper itself: an early exit must carry the child's stderr, so a CI
 * failure names its cause rather than only `code 1`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { startRelay } from './spawn-relay.mjs';

test('a Relay that cannot bind reports why it exited', async () => {
  const holder = createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  try {
    // An explicit `PORT` is the caller's choice, so the helper does not retry it.
    await assert.rejects(startRelay({ PORT: String(holder.address().port) }), (error) => {
      assert.match(error.message, /relay exited early with code 1/);
      assert.match(error.message, /EADDRINUSE/);
      assert.equal(error.addressInUse, true);
      return true;
    });
  } finally {
    holder.close();
  }
});
