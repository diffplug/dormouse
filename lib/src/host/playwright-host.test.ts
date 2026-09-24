// @vitest-environment node
import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { spawnAndCapture } from 'dor-lib-common';
import type { BrowserOp, BrowserRequestBinding } from '../lib/platform/browser-automation';
import { createBrowserHost } from './browser-host';
import { createPlaywrightProvider } from './playwright-host';

// Opt-in: tests the user's real CLI and matching Chromium, with a private session.
const binaryPath = process.env.DORMOUSE_PLAYWRIGHT_TEST_BIN;
test.skipIf(!binaryPath)('real CLI: GUI launch, stream grants, native tabs, input, screenshots, relaunch and close', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'dor-pw-test-'));
  await mkdir(path.join(cwd, '.playwright'));
  await mkdir(path.join(cwd, 'nested'));
  const server = createServer((_req, res) => { res.end('<title>Playwright fixture</title><input autofocus value="hello"><a href="/next">Next</a>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let clipboard = '';
  const host = createBrowserHost({ writeClipboardText: text => { clipboard = text; }, providers: { playwright: () => createPlaywrightProvider() } });
  const pw = (op: BrowserOp, binding: BrowserRequestBinding) => host.request({ provider: 'playwright', binding, ...op });
  let session = '';
  let socket: WebSocket | undefined;
  const messages: any[] = [];
  const waitFor = async (predicate: () => boolean) => {
    const until = Date.now() + 10000;
    while (!predicate() && Date.now() < until) await new Promise(r => setTimeout(r, 50));
    expect(predicate()).toBe(true);
  };
  try {
    const opened = await pw({ op: 'launch', url, headed: false }, { cwd, binaryPath });
    expect(opened.error).toBeUndefined();
    expect(opened.ok).toBe(true);
    session = opened.session!;
    const req = { cwd, binaryPath, session };
    const nested = await pw({ op: 'attach' }, { ...req, cwd: path.join(cwd, 'nested') });
    expect(nested.wsPort).toBe(opened.wsPort);
    expect(nested.nativeIdentity).toBe(opened.nativeIdentity);
    const stream = await pw({ op: 'streamUrl', port: opened.wsPort! }, {});
    socket = new WebSocket(stream.url!);
    socket.on('message', raw => messages.push(JSON.parse(String(raw))));
    await waitFor(() => messages.some(m => m.type === 'frame') && messages.some(m => m.type === 'tabs'));
    const replay = new WebSocket(stream.url!);
    await new Promise<void>(resolve => replay.on('unexpected-response', (_req, res) => { expect(res.statusCode).toBe(403); res.resume(); replay.terminate(); resolve(); }).on('error', () => {}));
    // Parking drops the viewer socket, then reconnects to the same CLI browser.
    socket.close();
    await new Promise<void>(resolve => socket!.once('close', () => resolve()));
    expect((await pw({ op: 'attach' }, req)).wsPort).toBe(opened.wsPort);
    messages.length = 0;
    const resumedStream = await pw({ op: 'streamUrl', port: opened.wsPort! }, {});
    socket = new WebSocket(resumedStream.url!);
    socket.on('message', raw => messages.push(JSON.parse(String(raw))));
    await waitFor(() => messages.some(m => m.type === 'frame'));
    expect((await pw({ op: 'edit', edit: 'selectAll' }, req)).ok).toBe(true);
    expect((await pw({ op: 'edit', edit: 'copy' }, req)).ok).toBe(true);
    expect(clipboard).toBe('hello');
    socket.send(JSON.stringify({ type: 'input_keyboard', eventType: 'keyDown', key: 'x', code: 'KeyX', text: 'x', windowsVirtualKeyCode: 88 }));
    await new Promise(r => setTimeout(r, 200));
    await pw({ op: 'edit', edit: 'selectAll' }, req);
    await pw({ op: 'edit', edit: 'copy' }, req);
    expect(clipboard).toBe('x');
    const shot = await pw({ op: 'screenshot', format: 'png' }, req);
    expect(Buffer.isBuffer(shot.bytes)).toBe(false);
    expect(Buffer.from(shot.bytes!).subarray(1, 4).toString()).toBe('PNG');
    const native = await spawnAndCapture(binaryPath!, [`--session=${session}`, 'tab-new', `${url}/second`], { cwd });
    expect(native.ok && native.exitCode).toBe(0);
    await waitFor(() => messages.some(m => m.type === 'tabs' && m.tabs.length === 2 && m.tabs[1].active));
    expect((await pw({ op: 'tab', action: 'select', tabId: '0' }, req)).ok).toBe(true);
    await waitFor(() => messages.at(-1)?.type === 'status' && [...messages].reverse().find(m => m.type === 'tabs')?.tabs[0].active);
    const viewport = await pw({ op: 'viewport', width: 640, height: 480, dpr: 2 }, req);
    expect(viewport.ok).toBe(true);
    const sized = await pw({ op: 'screenshot', format: 'png' }, req);
    expect(Buffer.from(sized.bytes!).readUInt32BE(16)).toBe(1280);
    // No operation outside the typed set reaches the CLI.
    expect((await host.request({ provider: 'playwright', binding: req, op: 'eval', script: 'process.exit()' })).ok).toBe(false);
    const popped = await pw({ op: 'launch', url, headed: true }, req);
    expect(popped.ok, popped.error).toBe(true);
    expect((await pw({ op: 'attach' }, req)).headed).toBe(true);
    await new Promise(r => setTimeout(r, 1000));
    // The relaunch swept its startup blank tab.
    const popTabs = await spawnAndCapture(binaryPath!, [`--session=${session}`, 'tab-list', '--json'], { cwd });
    expect(popTabs.ok && popTabs.stdout.match(/\d+:/g)).toHaveLength(1);
    const relaunched = await pw({ op: 'launch', url, headed: false }, req);
    expect(relaunched.ok, relaunched.error).toBe(true);
    expect(relaunched.wsPort).not.toBe(opened.wsPort);
    expect((await pw({ op: 'streamUrl', port: opened.wsPort! }, {})).ok).toBe(false);
    expect((await pw({ op: 'close' }, req)).ok).toBe(true);
    expect((await pw({ op: 'attach' }, req)).ok).toBe(false);
  } finally {
    socket?.terminate();
    if (session) await pw({ op: 'close' }, { cwd, binaryPath, session });
    await host.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
}, 60000);
