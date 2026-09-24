// @vitest-environment node
import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnAndCapture } from 'dor-lib-common';
import { createAgentBrowserProvider } from './agent-browser-host';
import { createBrowserHost } from './browser-host';

// Opt-in: the installed agent-browser and Chromium, in a private socket dir.
const binaryPath = process.env.DORMOUSE_AGENT_BROWSER_TEST_BIN;
test.skipIf(!binaryPath)('real agent-browser: first destination script sees initial viewport and DPR', async () => {
  const socketDir = await mkdtemp(path.join(os.tmpdir(), 'av-'));
  const priorSocketDir = process.env.AGENT_BROWSER_SOCKET_DIR;
  process.env.AGENT_BROWSER_SOCKET_DIR = socketDir;
  const server = createServer((_req, res) => {
    res.end('<title>loading</title><script>document.title = `first:${innerWidth}x${innerHeight}@${devicePixelRatio}`</script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const session = 'av';
  const host = createBrowserHost({ writeClipboardText: () => {}, providers: { 'agent-browser': () => createAgentBrowserProvider() } });
  const binding = { session, binaryPath };
  try {
    const opened = await host.request({ provider: 'agent-browser', binding, op: 'launch', url, headed: false,
      initialViewport: { mode: 'fixed', width: 1440, height: 900, dpr: 2 } });
    expect(opened.ok, opened.error).toBe(true);
    let title = '';
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await spawnAndCapture(binaryPath!, ['--session', session, 'get', 'title'], { timeoutMs: 5000 });
      if (result.ok && result.exitCode === 0) title = result.stdout.trim();
      if (title.includes('first:')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(title).toContain('first:1440x900@2');
    expect(await host.request({ provider: 'agent-browser', binding, op: 'measure' })).toEqual({ ok: true, viewport: { width: 1440, height: 900, dpr: 2 } });
    expect((await host.request({ provider: 'agent-browser', binding, op: 'viewport', width: 800, height: 600 })).ok).toBe(true);
    expect(await host.request({ provider: 'agent-browser', binding, op: 'measure' })).toEqual({ ok: true, viewport: { width: 800, height: 600, dpr: 2 } });
  } finally {
    await host.request({ provider: 'agent-browser', binding, op: 'close' });
    await host.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (priorSocketDir === undefined) delete process.env.AGENT_BROWSER_SOCKET_DIR;
    else process.env.AGENT_BROWSER_SOCKET_DIR = priorSocketDir;
    await rm(socketDir, { recursive: true, force: true });
  }
}, 60_000);
