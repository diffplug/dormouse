/** The real entrypoint wires its persisted setup password into Host enrollment. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { API_ROUTES } from 'server-lib-common';

import { startServer, stopServer } from './spawn-server.mjs';

test('the running server accepts the setup password it persisted', async (t) => {
  const { child, port, stateDir } = await startServer();
  t.after(() => stopServer(child));

  const { password } = JSON.parse(
    await readFile(join(stateDir, 'setup-password.json'), 'utf8'),
  );
  const response = await fetch(`http://127.0.0.1:${port}${API_ROUTES.hostEnroll}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  assert.equal(response.status, 200);
});
