/** The installed Playwright CLI owns browsers; this host owns only their Dormouse viewers. */
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Browser, Page, CDPSession } from 'playwright-core';
import { spawnAndCapture, sessionForKey } from 'dor-lib-common';
import type { PlaywrightRequest, PlaywrightResult } from '../lib/platform/browser-automation';
import { resolvePlaywrightInstall, playwrightWorkspace, type PlaywrightInstall } from './playwright-install';
import { isLoopbackHost } from './loopback-guard';
import { BrowserStreamGrants } from './browser-stream-guard';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const validSession = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) && value.length <= 200;
const validUrl = (value: unknown): value is string => { try { return typeof value === 'string' && ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } };
const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 16384;

type Binding = { session: string; cwd: string; install: PlaywrightInstall };
type Viewer = Binding & {
  browser: Browser;
  server: Server;
  sockets: Set<WebSocket>;
  port: number;
  controls: Map<Page, Promise<CDPSession>>;
  page?: Page;
  cdp?: CDPSession;
  timer?: ReturnType<typeof setTimeout>;
  disposed: boolean;
  refreshing?: Promise<void>;
  queue: Promise<void>;
  queued: number;
  headed: boolean;
};
const pagesOf = (v: Viewer) => v.browser.contexts().flatMap(context => context.pages());
const tabsOf = (v: Viewer) => Promise.all(pagesOf(v).map(async (page, index) => ({
  tabId: String(index), url: page.url(), title: await page.title().catch(() => ''), active: page === v.page,
})));
export function createPlaywrightHost(deps: { writeClipboardText(text: string): void | Promise<void>; log?(text: string): void }) {
  const viewers = new Map<string, Viewer>();
  const connecting = new Map<string, Promise<Viewer>>();
  const generations = new Map<string, number>();
  const lifecycle = new Map<string, Promise<unknown>>();
  const headed = new Map<string, Binding>();
  const grants = new BrowserStreamGrants();
  let captureDir: Promise<string> | undefined;
  let closed = false;
  const keyOf = (b: Binding) => JSON.stringify([b.install.libraryPath, playwrightWorkspace(b.cwd) ?? '', b.session]);
  const log = (e: unknown) => deps.log?.(`[playwright] ${message(e)}`);
  async function cli(b: Binding, args: string[]) {
    const r = await spawnAndCapture(b.install.binary, [`--session=${b.session}`, ...args], { cwd: b.cwd });
    if (!r.ok) throw new Error(r.error.message);
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }
  function broadcast(v: Viewer, data: unknown) {
    const payload = JSON.stringify(data);
    for (const ws of v.sockets) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2_000_000) ws.send(payload);
  }
  async function dispose(v: Viewer) {
    if (v.disposed) return;
    v.disposed = true;
    if (v.timer) clearTimeout(v.timer);
    for (const ws of v.sockets) ws.terminate();
    v.server.close();
    await v.cdp?.detach().catch(() => {});
    await Promise.allSettled([...v.controls.values()].map(async pending => { await (await pending).detach(); }));
    v.controls.clear();
    // browser.close() on a connected client disconnects it; the CLI remains owner.
    await v.browser.close().catch(() => {});
  }
  async function invalidate(b: Binding) {
    const key = keyOf(b);
    generations.set(key, (generations.get(key) ?? 0) + 1);
    const v = viewers.get(key);
    viewers.delete(key);
    if (v) await dispose(v);
  }
  function serialize<T>(b: Binding, action: () => Promise<T>): Promise<T> {
    const key = keyOf(b);
    const operation = (lifecycle.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    lifecycle.set(key, operation);
    void operation.finally(() => { if (lifecycle.get(key) === operation) lifecycle.delete(key); }).catch(() => {});
    return operation;
  }
  async function activeIndex(b: Binding): Promise<number> {
    const r = await cli(b, ['tab-list', '--json']);
    if (r.exitCode !== 0) return 0;
    // JSON CLI results contain the tool's text; tolerate the text formatter too.
    const parsed = (() => { try { return JSON.parse(r.stdout); } catch { return r.stdout; } })();
    const text = typeof parsed === 'string' ? parsed : parsed.result ?? '';
    const match = /(?:^|\\n|\n)\s*-?\s*(\d+):?\s*\(current\)/.exec(text);
    return match ? Number(match[1]) : 0;
  }
  async function refresh(v: Viewer) {
    if (v.disposed) return;
    if (v.refreshing) return v.refreshing;
    v.refreshing = refreshNow(v);
    try { await v.refreshing; } finally { v.refreshing = undefined; }
  }
  async function refreshNow(v: Viewer) {
    try {
      const pages = pagesOf(v);
      const index = await activeIndex(v);
      if (v.disposed) return;
      const page = pages[index] ?? pages[0];
      if (page !== v.page) {
        await v.cdp?.detach().catch(() => {});
        v.cdp = undefined;
        v.page = page;
        if (page && !v.headed && v.sockets.size) await startFrames(v);
      }
      const tabs = await tabsOf(v);
      if (v.disposed) return;
      broadcast(v, { type: 'tabs', tabs });
      if (page) {
        const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => page.viewportSize());
        broadcast(v, { type: 'url', url: page.url() });
        broadcast(v, { type: 'status', connected: true, screencasting: !v.headed, viewportWidth: size?.width, viewportHeight: size?.height });
      }
    } catch (e) { log(e); }
  }
  async function startFrames(v: Viewer) {
    if (!v.page || v.cdp || v.disposed || v.headed) return;
    const page = v.page;
    const cdp = await page.context().newCDPSession(page);
    // Another refresh, tab change, or parking may finish while CDP attaches.
    if (v.disposed || !v.sockets.size || v.page !== page || v.cdp) { await cdp.detach(); return; }
    v.cdp = cdp;
    cdp.on('Page.screencastFrame', event => {
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      if (!v.disposed && v.cdp === cdp) broadcast(v, { type: 'frame', data: event.data, metadata: event.metadata });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70 });
  }
  function schedule(v: Viewer) {
    if (v.disposed || !v.sockets.size || v.timer) return;
    v.timer = setTimeout(() => {
      v.timer = undefined;
      void refresh(v).finally(() => schedule(v));
    }, 750);
    v.timer.unref();
  }
  function control(v: Viewer, page: Page): Promise<CDPSession> {
    const existing = v.controls.get(page);
    if (existing) return existing;
    // Store the pending attachment: input and screenshots can arrive together.
    const pending = page.context().newCDPSession(page).then(async cdp => {
      if (v.disposed || page.isClosed()) {
        await cdp.detach();
        throw new Error('Browser viewer closed');
      }
      page.once('close', () => {
        v.controls.delete(page);
        void cdp.detach().catch(() => {});
      });
      return cdp;
    });
    v.controls.set(page, pending);
    void pending.catch(() => { if (v.controls.get(page) === pending) v.controls.delete(page); });
    return pending;
  }
  async function input(v: Viewer, raw: string) {
    if (v.disposed || raw.length > 65536 || !v.page) return;
    const data = JSON.parse(raw);
    const page = v.page;
    if (data.type === 'input_mouse' && ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(data.eventType)) {
      if (![data.x, data.y].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6)) return;
      const cdp = await control(v, page);
      await cdp.send('Input.dispatchMouseEvent', { type: data.eventType, x: data.x, y: data.y,
        button: ['left', 'right', 'middle', 'none'].includes(data.button) ? data.button : 'none',
        buttons: Number.isInteger(data.buttons) ? data.buttons & 31 : 0,
        modifiers: Number.isInteger(data.modifiers) ? data.modifiers & 15 : 0,
        clickCount: Math.min(3, Math.max(0, Number(data.clickCount) || 0)),
        ...(data.eventType === 'mouseWheel' ? { deltaX: Number(data.deltaX) || 0, deltaY: Number(data.deltaY) || 0 } : {}) });
    } else if (data.type === 'input_keyboard' && ['keyDown', 'keyUp'].includes(data.eventType) && typeof data.key === 'string' && data.key.length <= 100) {
      const cdp = await control(v, page);
      await cdp.send('Input.dispatchKeyEvent', { type: data.eventType, key: data.key, code: typeof data.code === 'string' ? data.code.slice(0, 100) : '',
        text: typeof data.text === 'string' ? data.text.slice(0, 1000) : '',
        windowsVirtualKeyCode: Number.isInteger(data.windowsVirtualKeyCode) ? data.windowsVirtualKeyCode : 0,
        modifiers: Number.isInteger(data.modifiers) ? data.modifiers & 15 : 0 });
    }
  }
  async function connect(b: Binding): Promise<Viewer> {
    const key = keyOf(b);
    const cached = viewers.get(key);
    if (cached && cached.browser.isConnected()) { void refresh(cached); return cached; }
    const pending = connecting.get(key);
    if (pending) return pending;
    const gen = generations.get(key) ?? 0;
    const operation = (async () => {
      const list = await cli(b, ['list', '--all', '--json']);
      if (list.exitCode !== 0) throw new Error(list.stderr || 'Cannot discover Playwright browsers');
      const parsed = JSON.parse(list.stdout);
      const servers: unknown = parsed.servers ?? parsed.data?.servers;
      if (!Array.isArray(servers)) throw new Error('Unsupported Playwright CLI registry. Install @playwright/cli 0.1.19 or newer.');
      const scope = playwrightWorkspace(b.cwd);
      const matches = servers.filter(s => s.title === b.session && (s.workspaceDir || undefined) === scope && typeof s.playwrightLib === 'string' && (() => { try { return realpathSync(s.playwrightLib) === b.install.libraryPath; } catch { return false; } })());
      if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous Playwright session' : 'Playwright session is not open or has no viewable endpoint');
      const descriptor = matches[0];
      if (descriptor.browser?.browserName !== 'chromium') throw new Error('Dormouse currently views Chromium Playwright sessions only. The native CLI command still ran.');
      const endpoint = descriptor.endpoint ?? descriptor.pipeName;
      if (typeof endpoint !== 'string' || !endpoint) throw new Error('Playwright browser endpoint unavailable');
      // CLI-created browsers publish private local pipes. Never dial an arbitrary network endpoint from saved data.
      if (/^[a-z]+:\/\//i.test(endpoint)) throw new Error('Only local Playwright CLI browser pipes can be viewed');
      const browser = await b.install.library.chromium.connect(endpoint, { timeout: 8000 });
      if (closed || gen !== (generations.get(key) ?? 0)) { await browser.close(); throw new Error('Browser launch superseded'); }
      const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
      const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
      const v: Viewer = { ...b, browser, server, sockets: new Set(), port: 0, controls: new Map(), disposed: false, queue: Promise.resolve(), queued: 0, headed: descriptor.browser.launchOptions?.headless === false };
      server.on('upgrade', (req, socket, head) => {
        const token = /^\/stream\/([a-f0-9]{64})$/.exec(req.url ?? '')?.[1];
        if (!isLoopbackHost(req.headers.host, v.port) || !token || !grants.consume(token, v.port)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
        wss.handleUpgrade(req, socket, head, ws => {
          v.sockets.add(ws);
          ws.on('error', log);
          ws.on('message', raw => {
            if (v.queued >= 256) { ws.close(1008, 'Input backlog exceeded'); return; }
            v.queued++;
            v.queue = v.queue.then(() => input(v, raw.toString())).catch(log).finally(() => { v.queued--; });
          });
          ws.on('close', () => {
            v.sockets.delete(ws);
            if (!v.sockets.size) {
              if (v.timer) clearTimeout(v.timer);
              v.timer = undefined;
              void v.cdp?.detach().catch(() => {});
              v.cdp = undefined;
            }
          });
          void refresh(v).then(() => startFrames(v)).catch(log);
          if (v.sockets.size === 1) schedule(v);
        });
      });
      try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      } catch (error) {
        await dispose(v);
        throw error;
      }
      server.unref();
      v.port = (server.address() as { port: number }).port;
      browser.on('disconnected', () => { if (viewers.get(key) === v) viewers.delete(key); void dispose(v); });
      if (closed || gen !== (generations.get(key) ?? 0)) { await dispose(v); throw new Error('Browser launch superseded'); }
      viewers.set(key, v);
      if (v.headed) headed.set(key, b);
      return v;
    })();
    connecting.set(key, operation);
    try { return await operation; } finally { if (connecting.get(key) === operation) connecting.delete(key); }
  }
  async function launch(b: Binding, url: string, isHeaded: boolean) {
    if (!validUrl(url)) throw new Error('Browser navigation requires an http(s) URL');
    if (closed) throw new Error('Playwright host is shutting down');
    await invalidate(b);
    // Finish the old CLI session before discovering the replacement endpoint.
    await cli(b, ['close']);
    const key = keyOf(b);
    if (isHeaded) headed.set(key, b); else headed.delete(key);
    const generation = generations.get(key);
    let result: Awaited<ReturnType<typeof cli>> | undefined;
    const opening = cli(b, ['open', url, '--browser=chromium', ...(isHeaded ? ['--headed'] : [])]);
    void opening.then(r => { result = r; }, e => { result = { exitCode: 1, stdout: '', stderr: message(e) }; });
    // Endpoint readiness, not the page load, completes GUI launches.
    const deadline = Date.now() + 30_000;
    let last: unknown;
    while (Date.now() < deadline && !closed) {
      try {
        const v = await connect(b);
        // Only a completed, still-current launch may remove startup blank tabs.
        void opening.then(async () => {
          if (closed || generation !== generations.get(key) || v.disposed) return;
          const pages = pagesOf(v);
          if (!pages.some(p => validUrl(p.url()))) return;
          for (let i = pages.length - 1; i >= 0; i--) {
            if (closed || generation !== generations.get(key) || v.disposed) return;
            if (pages[i].url() === 'about:blank') await cli(b, ['tab-close', String(i)]);
          }
        }).catch(log);
        return v;
      } catch (e) { last = e; }
      if (result && result.exitCode !== 0) break;
      await wait(200);
    }
    await cli(b, ['close']).catch(log);
    throw new Error(result?.stderr || message(last));
  }
  async function execute(request: PlaywrightRequest): Promise<PlaywrightResult> {
    if (!request || typeof request !== 'object') throw new Error('Invalid Playwright request');
    if (request.op === 'streamUrl') {
      const v = [...viewers.values()].find(v => v.port === request.port && !v.disposed);
      if (!v) throw new Error('Playwright stream is no longer live');
      return { ok: true, url: `ws://127.0.0.1:${v.port}/stream/${grants.issue(v.port)}` };
    }
    const install = resolvePlaywrightInstall(request.binaryPath);
    const cwd = typeof request.cwd === 'string' && path.isAbsolute(request.cwd) ? request.cwd : process.cwd();
    const session = request.op === 'open' ? sessionForKey(`gui-${randomBytes(8).toString('hex')}`) : request.session;
    if (!validSession(session)) throw new Error('Invalid Playwright session name');
    const b = { session, cwd, install };
    if (request.op === 'open' || request.op === 'popOut' || request.op === 'popIn') {
      const v = await serialize(b, () => launch(b, request.url ?? '', request.op === 'open' ? !!request.headed : request.op === 'popOut'));
      return { ok: true, session, cwd, binaryPath: install.binary, wsPort: v.port, nativeIdentity: keyOf(b) };
    }
    if (request.op === 'command' && request.args?.[0] === 'close') {
      return serialize(b, async () => {
        await invalidate(b); headed.delete(keyOf(b));
        const r = await cli(b, ['close']); return { ok: r.exitCode === 0, ...r };
      });
    }
    const v = await connect(b);
    if (request.op === 'streamStatus') { await refresh(v); return { ok: true, wsPort: v.port, headed: v.headed, nativeIdentity: keyOf(b) }; }
    await refresh(v);
    const page = v.page;
    if (!page) throw new Error('No Playwright page is open');
    if (request.op === 'screenshot') {
      const format = request.format === 'png' ? 'png' : 'jpeg';
      const cdp = await control(v, page);
      const { data } = await cdp.send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: Math.min(100, Math.max(1, request.quality ?? 85)) } : {}), captureBeyondViewport: false });
      // Keep the cross-host contract a plain typed array, including VS Code's message transport.
      const bytes = new Uint8Array(Buffer.from(data, 'base64'));
      return { ok: true, bytes, mime: `image/${format}` };
    }
    if (request.op === 'edit') {
      if (!['selectAll', 'copy', 'cut'].includes(request.edit)) throw new Error('Invalid editing operation');
      const text = await page.evaluate(op => {
        const el = document.activeElement;
        if (op === 'selectAll') { if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select(); else document.execCommand('selectAll'); return ''; }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const start = el.selectionStart ?? 0, end = el.selectionEnd ?? 0, value = el.value.slice(start, end);
          if (op === 'cut') { el.setRangeText('', start, end, 'end'); el.dispatchEvent(new Event('input', { bubbles: true })); }
          return value;
        }
        const value = String(window.getSelection() ?? '');
        if (op === 'cut' && value) document.execCommand('delete');
        return value;
      }, request.edit);
      if (request.edit !== 'selectAll') await deps.writeClipboardText(text);
      return { ok: true, text };
    }
    if (request.op !== 'command' || !Array.isArray(request.args) || !request.args.every(a => typeof a === 'string')) throw new Error('Invalid browser operation');
    const [cmd, sub, ...args] = request.args;
    if (cmd === 'open' && request.args.length === 2 && validUrl(sub)) await page.goto(sub, { waitUntil: 'commit' });
    else if (cmd === 'reload' && !sub) await page.reload({ waitUntil: 'commit' });
    else if (cmd === 'back' && !sub) await page.goBack({ waitUntil: 'commit' });
    else if (cmd === 'forward' && !sub) await page.goForward({ waitUntil: 'commit' });
    else if (cmd === 'tab') {
      if (sub === 'list') return { ok: true, exitCode: 0, stdout: JSON.stringify({ tabs: await tabsOf(v) }), stderr: '' };
      const nativeArgs = sub === 'close' && args.length === 1 && /^\d+$/.test(args[0]) ? ['tab-close', args[0]] : request.args.length === 2 && /^\d+$/.test(sub ?? '') ? ['tab-select', sub] : null;
      if (!nativeArgs) throw new Error('Unsupported tab operation');
      const r = await cli(b, nativeArgs); await refresh(v); return { ok: r.exitCode === 0, ...r };
    } else if (cmd === 'set') {
      const device = sub === 'device' && args.length === 1 ? install.library.devices[args[0]] : undefined;
      const [width, height, dpr] = device ? [device.viewport.width, device.viewport.height, device.deviceScaleFactor] : args.map(Number);
      if (!(sub === 'viewport' && args.length === 3 || device) || !positive(width) || !positive(height) || !positive(dpr) || dpr > 10) throw new Error('Invalid viewport/device');
      await page.setViewportSize({ width, height });
      const cdp = await control(v, page);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: device?.isMobile ?? false });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: device?.hasTouch ?? false });
      if (device) await cdp.send('Emulation.setUserAgentOverride', { userAgent: device.userAgent });
    } else throw new Error('Unsupported Playwright host command');
    await refresh(v);
    return { ok: true, exitCode: 0, stdout: '', stderr: '' };
  }
  async function request(r: PlaywrightRequest): Promise<PlaywrightResult> {
    try { if (closed) throw new Error('Playwright host is shutting down'); return await execute(r); }
    catch (e) { return { ok: false, error: message(e), exitCode: 1, stdout: '', stderr: message(e) }; }
  }
  async function requestFile(r: PlaywrightRequest): Promise<PlaywrightResult> {
    try {
      const result = await request(r);
      if (!result.bytes) return result;
      if (closed) return { ok: false, error: 'Playwright host is shutting down' };
      captureDir ??= mkdtemp(path.join(os.tmpdir(), 'dormouse-playwright-')).then(dir => { process.once('exit', () => rmSync(dir, { recursive: true, force: true })); return dir; }).catch(error => { captureDir = undefined; throw error; });
      const file = path.join(await captureDir, `${randomBytes(16).toString('hex')}.frame`);
      await writeFile(file, result.bytes, { mode: 0o600 });
      if (closed) { await rm(path.dirname(file), { recursive: true, force: true }); return { ok: false, error: 'Playwright host is shutting down' }; }
      return { ok: true, path: file, mime: result.mime };
    } catch (error) { return { ok: false, error: message(error) }; }
  }
  async function close() {
    closed = true;
    await Promise.allSettled([...lifecycle.values(), ...connecting.values()]);
    await Promise.all([...headed.values()].map(async b => { await invalidate(b); await cli(b, ['close']).catch(log); }));
    await Promise.all([...viewers.values()].map(dispose)); viewers.clear(); headed.clear();
    if (captureDir) await rm(await captureDir, { recursive: true, force: true });
  }
  return { request, requestFile, close };
}
