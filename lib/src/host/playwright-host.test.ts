// @vitest-environment node
import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnAndCapture } from 'dor-lib-common';
import type { BrowserOp, BrowserRequestBinding, ViewerState } from '../lib/platform/browser-automation';
import { createBrowserHost } from './browser-host';
import { openViewer, type TestViewer } from './browser-host-test-utils';
import { createPlaywrightProvider } from './playwright-host';

/** A JPEG's pixel width, from its start-of-frame segment. */
function jpegWidth(jpeg: Uint8Array): number {
  for (let i = 2; i + 8 < jpeg.length;) {
    if (jpeg[i] !== 0xff) return 0;
    const marker = jpeg[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return (jpeg[i + 7] << 8) | jpeg[i + 8];
    i += 2 + ((jpeg[i + 2] << 8) | jpeg[i + 3]);
  }
  return 0;
}

// Opt-in: tests the user's real CLI and matching Chromium, with a private session.
const binaryPath = process.env.DORMOUSE_PLAYWRIGHT_TEST_BIN;
test.skipIf(!binaryPath)('real CLI: GUI launch, viewer sockets, native tabs, input, crisp captures, relaunch and close', async () => {
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
  let viewer: TestViewer | undefined;
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
    expect(nested.stream).toBe(opened.stream);
    expect(nested.nativeIdentity).toBe(opened.nativeIdentity);
    const { url: viewUrl } = await pw({ op: 'view', stream: opened.stream! }, req);
    viewer = await openViewer(viewUrl!);
    await waitFor(() => viewer!.frames.length > 0 && viewer!.states.some(m => m.type === 'tabs'));
    await expect(openViewer(viewUrl!)).rejects.toThrow('403');
    // Parking drops the viewer socket, then reconnects to the same CLI browser.
    viewer.socket.close();
    await viewer.closed;
    expect((await pw({ op: 'attach' }, req)).stream).toBe(opened.stream);
    viewer = await openViewer((await pw({ op: 'view', stream: opened.stream! }, req)).url!);
    await waitFor(() => viewer!.frames.length > 0);
    expect((await pw({ op: 'edit', edit: 'selectAll' }, req)).ok).toBe(true);
    expect((await pw({ op: 'edit', edit: 'copy' }, req)).ok).toBe(true);
    expect(clipboard).toBe('hello');
    viewer.send({ type: 'input_keyboard', eventType: 'keyDown', key: 'x', code: 'KeyX', text: 'x', windowsVirtualKeyCode: 88 });
    await new Promise(r => setTimeout(r, 200));
    await pw({ op: 'edit', edit: 'selectAll' }, req);
    await pw({ op: 'edit', edit: 'copy' }, req);
    expect(clipboard).toBe('x');
    // The typed key changed the page, so the host sharpened its stream frame.
    await waitFor(() => viewer!.frames.some(f => f.kind === 'crisp'));
    const native = await spawnAndCapture(binaryPath!, [`--session=${session}`, 'tab-new', `${url}/second`], { cwd });
    expect(native.ok && native.exitCode).toBe(0);
    await waitFor(() => viewer!.states.some(m => m.type === 'tabs' && m.tabs.length === 2 && m.tabs[1].active));
    expect((await pw({ op: 'tab', action: 'select', tabId: '0' }, req)).ok).toBe(true);
    const lastTabs = () => [...viewer!.states].reverse().find((m): m is Extract<ViewerState, { type: 'tabs' }> => m.type === 'tabs');
    await waitFor(() => viewer!.states.at(-1)?.type === 'status' && !!lastTabs()?.tabs[0].active);
    const viewport = await pw({ op: 'viewport', width: 640, height: 480, dpr: 2 }, req);
    expect(viewport.ok).toBe(true);
    // Captured at device resolution, unlike the CSS-resolution stream.
    await waitFor(() => viewer!.frames.some(f => f.kind === 'crisp' && jpegWidth(f.jpeg) === 1280));
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
    expect(relaunched.stream).not.toBe(opened.stream);
    // The relaunch ended the old browser's viewer, and nothing views it again.
    expect(await viewer.closed).toBe(1001);
    const stale = await openViewer((await pw({ op: 'view', stream: opened.stream! }, req)).url!);
    expect(await stale.closed).toBe(1011);
    expect((await pw({ op: 'close' }, req)).ok).toBe(true);
    expect((await pw({ op: 'attach' }, req)).ok).toBe(false);
  } finally {
    viewer?.socket.terminate();
    if (session) await pw({ op: 'close' }, { cwd, binaryPath, session });
    await host.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
}, 60000);
