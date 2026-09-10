// @vitest-environment node
import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { spawnAndCapture } from 'dor-lib-common';
import { createPlaywrightHost } from './playwright-host';

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
  const host = createPlaywrightHost({ writeClipboardText: text => { clipboard = text; } });
  let session = '';
  let socket: WebSocket | undefined;
  const messages: any[] = [];
  const waitFor = async (predicate: () => boolean) => {
    const until = Date.now() + 10000;
    while (!predicate() && Date.now() < until) await new Promise(r => setTimeout(r, 50));
    expect(predicate()).toBe(true);
  };
  try {
    const opened = await host.request({ op: 'open', cwd, binaryPath, url });
    expect(opened.error).toBeUndefined();
    expect(opened.ok).toBe(true);
    session = opened.session!;
    const req = { cwd, binaryPath, session };
    const nested = await host.request({ ...req, cwd: path.join(cwd, 'nested'), op: 'streamStatus' });
    expect(nested.wsPort).toBe(opened.wsPort);
    expect(nested.nativeIdentity).toBe(opened.nativeIdentity);
    const stream = await host.request({ op: 'streamUrl', port: opened.wsPort! });
    socket = new WebSocket(stream.url!);
    socket.on('message', raw => messages.push(JSON.parse(String(raw))));
    await waitFor(() => messages.some(m => m.type === 'frame') && messages.some(m => m.type === 'tabs'));
    const replay = new WebSocket(stream.url!);
    await new Promise<void>(resolve => replay.on('unexpected-response', (_req, res) => { expect(res.statusCode).toBe(403); res.resume(); replay.terminate(); resolve(); }).on('error', () => {}));
    // Parking drops the viewer socket, then reconnects to the same CLI browser.
    socket.close();
    await new Promise<void>(resolve => socket!.once('close', () => resolve()));
    expect((await host.request({ ...req, op: 'streamStatus' })).wsPort).toBe(opened.wsPort);
    messages.length = 0;
    const resumedStream = await host.request({ op: 'streamUrl', port: opened.wsPort! });
    socket = new WebSocket(resumedStream.url!);
    socket.on('message', raw => messages.push(JSON.parse(String(raw))));
    await waitFor(() => messages.some(m => m.type === 'frame'));
    expect((await host.request({ ...req, op: 'edit', edit: 'selectAll' })).ok).toBe(true);
    expect((await host.request({ ...req, op: 'edit', edit: 'copy' })).ok).toBe(true);
    expect(clipboard).toBe('hello');
    socket.send(JSON.stringify({ type: 'input_keyboard', eventType: 'keyDown', key: 'x', code: 'KeyX', text: 'x', windowsVirtualKeyCode: 88 }));
    await new Promise(r => setTimeout(r, 200));
    await host.request({ ...req, op: 'edit', edit: 'selectAll' });
    await host.request({ ...req, op: 'edit', edit: 'copy' });
    expect(clipboard).toBe('x');
    const shot = await host.request({ ...req, op: 'screenshot', format: 'png' });
    expect(Buffer.isBuffer(shot.bytes)).toBe(false);
    expect(Buffer.from(shot.bytes!).subarray(1, 4).toString()).toBe('PNG');
    const native = await spawnAndCapture(binaryPath!, [`--session=${session}`, 'tab-new', `${url}/second`], { cwd });
    expect(native.ok && native.exitCode).toBe(0);
    await waitFor(() => messages.some(m => m.type === 'tabs' && m.tabs.length === 2 && m.tabs[1].active));
    expect((await host.request({ ...req, op: 'command', args: ['tab', '0'] })).ok).toBe(true);
    await waitFor(() => messages.at(-1)?.type === 'status' && [...messages].reverse().find(m => m.type === 'tabs')?.tabs[0].active);
    const viewport = await host.request({ ...req, op: 'command', args: ['set', 'viewport', '640', '480', '2'] });
    expect(viewport.ok).toBe(true);
    const sized = await host.request({ ...req, op: 'screenshot', format: 'png' });
    expect(Buffer.from(sized.bytes!).readUInt32BE(16)).toBe(1280);
    expect((await host.request({ ...req, op: 'command', args: ['eval', 'process.exit()'] })).ok).toBe(false);
    const popped = await host.request({ ...req, op: 'popOut', url });
    expect(popped.ok, popped.error).toBe(true);
    expect((await host.request({ ...req, op: 'streamStatus' })).headed).toBe(true);
    await new Promise(r => setTimeout(r, 1000));
    const popTabs = await host.request({ ...req, op: 'command', args: ['tab', 'list'] });
    expect(JSON.parse(popTabs.stdout!).tabs).toHaveLength(1);
    const relaunched = await host.request({ ...req, op: 'popIn', url });
    expect(relaunched.ok, relaunched.error).toBe(true);
    expect(relaunched.wsPort).not.toBe(opened.wsPort);
    expect((await host.request({ op: 'streamUrl', port: opened.wsPort! })).ok).toBe(false);
    expect((await host.request({ ...req, op: 'command', args: ['close'] })).ok).toBe(true);
    expect((await host.request({ ...req, op: 'streamStatus' })).ok).toBe(false);
  } finally {
    socket?.terminate();
    if (session) await host.request({ cwd, binaryPath, session, op: 'command', args: ['close'] });
    await host.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
}, 60000);
