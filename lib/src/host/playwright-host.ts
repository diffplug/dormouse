/** The installed Playwright CLI owns browsers; this host owns only their Dormouse viewers. */
import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Browser, Page, CDPSession } from 'playwright-core';
import { spawnAndCapture } from 'dor-lib-common';
import { messageOf } from '../lib/errors';
import {
  PLAYWRIGHT_REQUEST_TIMEOUT_MS,
  PLAYWRIGHT_TEXT_INPUT_MAX,
  type PlaywrightRequest,
  type PlaywrightResult,
} from '../lib/platform/browser-automation';
import {
  captureFormat,
  editScript,
  generateGuiSession,
  isBrowsableUrl,
  isPlaywrightSession,
  jpegQuality,
  parseWebviewCommand,
} from './browser-host-shared';
import { resolvePlaywrightInstall, playwrightWorkspace, type PlaywrightInstall } from './playwright-install';
import { isLoopbackHost } from './loopback-guard';
import { BrowserStreamGrants } from './browser-stream-guard';
import { privateCaptureDir } from './private-capture-dir';

const TAB_REFRESH_INTERVAL_MS = 750;
const CONNECT_TIMEOUT_MS = 8_000;
// Every CLI call but `open` ends here at the latest, so a wedged playwright-cli
// cannot hold a viewer refresh or a host operation forever. `open` alone runs
// unbounded: it lasts as long as the page load, nothing waits on it past a
// launch's own bounds, and ending it could take down the browser it started.
const CLI_TIMEOUT_MS = 10_000;
// A GUI launch answers inside the webview's wait for any host request
// (`PLAYWRIGHT_REQUEST_TIMEOUT_MS`), or the webview restores the previous
// renderer while the host is still bringing a browser up. The whole request,
// from its arrival, gets REQUEST_BUDGET_MS, a margin short of that wait for the
// transport. Startup — queueing behind an earlier launch, closing the old
// session, listing, polling and connecting — ends LAUNCH_CLOSE_RESERVE_MS
// before it; a launch that gives up then waits up to OPEN_SETTLE_MS for its
// `open`, and closes the session with whatever remains.
const REQUEST_BUDGET_MS = PLAYWRIGHT_REQUEST_TIMEOUT_MS - 2_000;
const OPEN_SETTLE_MS = 4_000;
const LAUNCH_CLOSE_RESERVE_MS = OPEN_SETTLE_MS + 4_000;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function realpathOrUndefined(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

/** `key` is the native identity: installation, CLI workspace and session. */
type Binding = { session: string; cwd: string; install: PlaywrightInstall; workspace: string | undefined; key: string };
function bind(session: string, cwd: string, install: PlaywrightInstall): Binding {
  const workspace = playwrightWorkspace(cwd);
  return { session, cwd, install, workspace, key: JSON.stringify([install.libraryPath, workspace ?? '', session]) };
}
type StateMessage =
  | { type: 'url'; url: string }
  | { type: 'tabs'; tabs: { tabId: string; url: string; title: string; active: boolean }[] }
  | { type: 'status'; connected: true; screencasting: boolean; viewportWidth?: number; viewportHeight?: number };
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
  refreshedAt?: number;
  queue: Promise<void>;
  queued: number;
  headed: boolean;
  /** The last payload published per state message type, replayed to each viewer that connects. */
  sent: Map<StateMessage['type'], string>;
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
  // The newest launch per native identity; a failed launch's late close defers to it.
  const latestLaunch = new Map<string, object>();
  const headed = new Map<string, Binding>();
  const grants = new BrowserStreamGrants();
  const captures = privateCaptureDir('dormouse-playwright-');
  let closed = false;
  const log = (e: unknown) => deps.log?.(`[playwright] ${messageOf(e)}`);
  /** One CLI call, ended after `timeoutMs` (none for `null`); throws when it could not run or finish. */
  async function cli(b: Binding, args: string[], timeoutMs: number | null = CLI_TIMEOUT_MS) {
    const r = await spawnAndCapture(b.install.binary, [`--session=${b.session}`, ...args], {
      cwd: b.cwd,
      ...(timeoutMs === null ? {} : { timeoutMs: Math.max(0, timeoutMs) }),
    });
    if (!r.ok) throw new Error(r.error.message);
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }
  // A frame is superseded by the next one, so a socket backed up past 2 MB
  // skips it. State is published only on change, so it is never skipped.
  function broadcast(v: Viewer, payload: string, frame: boolean) {
    for (const ws of v.sockets) {
      if (ws.readyState === WebSocket.OPEN && (!frame || ws.bufferedAmount < 2_000_000)) ws.send(payload);
    }
  }
  // Every state message re-renders the pane, so the poll publishes only
  // changes; a connecting viewer is sent the latest state instead.
  function publish(v: Viewer, data: StateMessage) {
    const payload = JSON.stringify(data);
    if (v.sent.get(data.type) === payload) return;
    v.sent.set(data.type, payload);
    broadcast(v, payload, false);
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
    generations.set(b.key, (generations.get(b.key) ?? 0) + 1);
    const v = viewers.get(b.key);
    viewers.delete(b.key);
    if (v) await dispose(v);
  }
  function serialize<T>(b: Binding, action: () => Promise<T>): Promise<T> {
    const operation = (lifecycle.get(b.key) ?? Promise.resolve()).catch(() => {}).then(action);
    lifecycle.set(b.key, operation);
    void operation.finally(() => { if (lifecycle.get(b.key) === operation) lifecycle.delete(b.key); }).catch(() => {});
    return operation;
  }
  async function activeIndex(b: Binding): Promise<number> {
    const r = await cli(b, ['tab-list', '--json']);
    if (r.exitCode !== 0) return 0;
    // JSON CLI results contain the tool's text; tolerate the text formatter too.
    let text = r.stdout;
    try {
      const parsed = JSON.parse(r.stdout);
      text = typeof parsed === 'string' ? parsed : parsed.result ?? '';
    } catch { /* The text formatter. */ }
    const match = /(?:^|\\n|\n)\s*-?\s*(\d+):?\s*\(current\)/.exec(text);
    return match ? Number(match[1]) : 0;
  }
  async function refresh(v: Viewer, force = true) {
    if (v.disposed) return;
    if (v.refreshing) return v.refreshing;
    // Captures share the viewer polling cadence; explicit controls refresh immediately.
    if (!force && v.page && !v.page.isClosed() && v.refreshedAt !== undefined && Date.now() - v.refreshedAt < TAB_REFRESH_INTERVAL_MS) return;
    v.refreshing = refreshNow(v);
    try { await v.refreshing; } finally { v.refreshing = undefined; }
  }
  async function refreshNow(v: Viewer) {
    try {
      // A lone page is the selected one; only a choice needs the CLI spawn.
      const index = pagesOf(v).length > 1 ? await activeIndex(v) : 0;
      const pages = pagesOf(v);
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
      // `url` precedes `tabs`: the pane drops the active tab's title on a `url`
      // until the next `tabs` restates it.
      if (page) publish(v, { type: 'url', url: page.url() });
      publish(v, { type: 'tabs', tabs });
      if (page) {
        const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => page.viewportSize());
        publish(v, { type: 'status', connected: true, screencasting: !v.headed, viewportWidth: size?.width, viewportHeight: size?.height });
      }
      v.refreshedAt = Date.now();
    } catch (e) { log(e); }
  }
  async function startFrames(v: Viewer) {
    if (!v.page || v.cdp || v.disposed || v.headed) return;
    const page = v.page;
    try {
      const cdp = await page.context().newCDPSession(page);
      // Another refresh, tab change, or parking may finish while CDP attaches.
      if (v.disposed || !v.sockets.size || v.page !== page || v.cdp) { await cdp.detach().catch(() => {}); return; }
      v.cdp = cdp;
      cdp.on('Page.screencastFrame', event => {
        void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
        if (!v.disposed && v.cdp === cdp) broadcast(v, JSON.stringify({ type: 'frame', data: event.data, metadata: event.metadata }), true);
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70 });
    } catch (e) {
      // A page that navigates while CDP attaches fails either call. Forget the
      // page, so the next refresh sees a new one: it releases the attachment
      // and starts again, instead of leaving the viewer frozen on a screencast
      // that never started.
      if (v.page === page) v.page = undefined;
      throw e;
    }
  }
  function schedule(v: Viewer) {
    if (v.disposed || !v.sockets.size || v.timer) return;
    v.timer = setTimeout(() => {
      v.timer = undefined;
      void refresh(v).finally(() => schedule(v));
    }, TAB_REFRESH_INTERVAL_MS);
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
    } else if (data.type === 'input_text' && typeof data.text === 'string' && data.text.length <= PLAYWRIGHT_TEXT_INPUT_MAX) {
      // A paste arrives as text, not a key pair per character (`playwrightTextInputs`).
      const cdp = await control(v, page);
      await cdp.send('Input.insertText', { text: data.text });
    }
  }
  /** The viewer for `b`, discovered and connected by `deadline`. */
  async function connect(b: Binding, deadline = Date.now() + CLI_TIMEOUT_MS + CONNECT_TIMEOUT_MS): Promise<Viewer> {
    const key = b.key;
    const cached = viewers.get(key);
    if (cached && cached.browser.isConnected()) return cached;
    const pending = connecting.get(key);
    if (pending) return pending;
    const gen = generations.get(key) ?? 0;
    const operation = (async () => {
      const list = await cli(b, ['list', '--all', '--json'], Math.min(CLI_TIMEOUT_MS, deadline - Date.now()));
      if (list.exitCode !== 0) throw new Error(list.stderr || 'Cannot discover Playwright browsers');
      const parsed = JSON.parse(list.stdout);
      const servers: unknown = parsed.servers ?? parsed.data?.servers;
      if (!Array.isArray(servers)) throw new Error('Unsupported Playwright CLI registry. Install @playwright/cli 0.1.19 or newer.');
      const matches = servers.filter(s =>
        s.title === b.session
        && (s.workspaceDir || undefined) === b.workspace
        && typeof s.playwrightLib === 'string'
        && realpathOrUndefined(s.playwrightLib) === b.install.libraryPath);
      if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous Playwright session' : 'Playwright session is not open or has no viewable endpoint');
      const descriptor = matches[0];
      if (descriptor.browser?.browserName !== 'chromium') throw new Error('Dormouse currently views Chromium Playwright sessions only. The native CLI command still ran.');
      const endpoint = descriptor.endpoint ?? descriptor.pipeName;
      if (typeof endpoint !== 'string' || !endpoint) throw new Error('Playwright browser endpoint unavailable');
      // CLI-created browsers publish private local pipes. Never dial an arbitrary network endpoint from saved data.
      if (/^[a-z]+:\/\//i.test(endpoint)) throw new Error('Only local Playwright CLI browser pipes can be viewed');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Playwright browser connection timed out');
      const browser = await b.install.library.chromium.connect(endpoint, { timeout: Math.min(CONNECT_TIMEOUT_MS, remaining) });
      if (closed || gen !== (generations.get(key) ?? 0)) { await browser.close(); throw new Error('Browser launch superseded'); }
      const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
      const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
      const v: Viewer = {
        ...b,
        browser,
        server,
        sockets: new Set(),
        port: 0,
        controls: new Map(),
        disposed: false,
        queue: Promise.resolve(),
        queued: 0,
        headed: descriptor.browser.launchOptions?.headless === false,
        sent: new Map(),
      };
      server.on('upgrade', (req, socket, head) => {
        const token = /^\/stream\/([a-f0-9]{64})$/.exec(req.url ?? '')?.[1];
        if (!isLoopbackHost(req.headers.host, v.port) || !token || !grants.consume(token, v.port)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
        wss.handleUpgrade(req, socket, head, ws => {
          v.sockets.add(ws);
          // Earlier viewers already hold this state; the refresh below sends only what changed.
          for (const payload of v.sent.values()) ws.send(payload);
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
      if (v.headed) headed.set(key, b); else headed.delete(key);
      return v;
    })();
    connecting.set(key, operation);
    try { return await operation; } finally { if (connecting.get(key) === operation) connecting.delete(key); }
  }
  /** Launch `b`'s browser at `url`, or blank when there is none. */
  async function launch(b: Binding, url: string | undefined, isHeaded: boolean, fresh: boolean, requestDeadline: number) {
    if (closed) throw new Error('Playwright host is shutting down');
    const deadline = requestDeadline - LAUNCH_CLOSE_RESERVE_MS;
    if (Date.now() >= deadline) throw new Error('Playwright browser launch timed out behind an earlier one');
    await invalidate(b);
    // Finish the old CLI session before discovering the replacement endpoint.
    // A freshly minted session has none to finish.
    if (!fresh) await cli(b, ['close'], deadline - Date.now());
    const key = b.key;
    const launchToken = {};
    latestLaunch.set(key, launchToken);
    if (isHeaded) headed.set(key, b); else headed.delete(key);
    const generation = generations.get(key);
    let result: Awaited<ReturnType<typeof cli>> | undefined;
    const opening = cli(b, ['open', ...(url === undefined ? [] : [url]), '--browser=chromium', ...(isHeaded ? ['--headed'] : [])], null);
    const opened = opening.then(r => { result = r; }, e => { result = { exitCode: 1, stdout: '', stderr: messageOf(e) }; });
    // Endpoint readiness, not the page load, completes GUI launches.
    let last: unknown;
    while (Date.now() < deadline && !closed) {
      try {
        const v = await connect(b, deadline);
        // Only a completed, still-current launch may remove startup blank tabs.
        void opening.then(async () => {
          if (closed || generation !== generations.get(key) || v.disposed) return;
          const pages = pagesOf(v);
          if (!pages.some(p => isBrowsableUrl(p.url()))) return;
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
    // Until `open` registers the session, `close` has nothing to close, and the
    // browser it then brings up is one nothing tracks. Let it land first; if it
    // is still running, close again once it does, unless a newer launch has
    // taken the session over by then.
    const landed = await Promise.race([opened.then(() => true), wait(OPEN_SETTLE_MS).then(() => false)]);
    await cli(b, ['close'], requestDeadline - Date.now()).catch(log);
    if (!landed) {
      void opened.then(async () => {
        if (latestLaunch.get(key) === launchToken) await cli(b, ['close']);
      }).catch(log);
    }
    throw new Error(result?.stderr || (last === undefined ? 'Playwright browser launch timed out' : messageOf(last)));
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
    const session = request.op === 'open' ? generateGuiSession() : request.session;
    if (!isPlaywrightSession(session)) throw new Error('Invalid Playwright session name');
    const b = bind(session, cwd, install);
    if (request.op === 'open' || request.op === 'popOut' || request.op === 'popIn') {
      // A GUI open navigates where it was asked, so that URL must pass the
      // http(s) check. A relaunch only carries the page along: one Dormouse may
      // not navigate to (about:blank, `file:`, `data:`, an error page) reopens
      // blank rather than failing the pop-out or pop-in.
      if (request.op === 'open' && !isBrowsableUrl(request.url)) throw new Error('Browser navigation requires an http(s) URL');
      const url = isBrowsableUrl(request.url) ? request.url : undefined;
      const isHeaded = request.op === 'open' ? !!request.headed : request.op === 'popOut';
      const fresh = request.op === 'open';
      const deadline = Date.now() + REQUEST_BUDGET_MS;
      const v = await serialize(b, () => launch(b, url, isHeaded, fresh, deadline));
      return { ok: true, session, cwd, binaryPath: install.binary, wsPort: v.port, nativeIdentity: b.key };
    }
    // Parsed before anything connects, so a refused command costs nothing.
    const command = request.op === 'command' ? parseWebviewCommand(request.args) : undefined;
    if (command === null) throw new Error('Unsupported Playwright host command');
    if (command?.kind === 'close') {
      return serialize(b, async () => {
        await invalidate(b);
        headed.delete(b.key);
        const r = await cli(b, ['close']);
        return { ok: r.exitCode === 0, ...r };
      });
    }
    const v = await connect(b);
    if (request.op === 'streamStatus') {
      await refresh(v);
      return { ok: true, wsPort: v.port, headed: v.headed, nativeIdentity: b.key };
    }
    await refresh(v, request.op !== 'screenshot');
    const page = v.page;
    if (!page) throw new Error('No Playwright page is open');
    if (request.op === 'screenshot') {
      const format = captureFormat(request.format);
      const cdp = await control(v, page);
      const { data } = await cdp.send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: jpegQuality(request.quality) } : {}), captureBeyondViewport: false });
      // Keep the cross-host contract a plain typed array, including VS Code's message transport.
      const bytes = new Uint8Array(Buffer.from(data, 'base64'));
      return { ok: true, bytes, mime: `image/${format}` };
    }
    if (request.op === 'edit') {
      const script = editScript(request.edit);
      if (!script) throw new Error('Invalid editing operation');
      const result: unknown = await page.evaluate(script);
      const text = typeof result === 'string' ? result : '';
      // Skip empty, so an empty selection doesn't clobber the clipboard.
      if (request.edit !== 'selectAll' && text) await deps.writeClipboardText(text);
      return { ok: true, text };
    }
    if (!command) throw new Error('Invalid browser operation');
    switch (command.kind) {
      case 'open': await page.goto(command.url, { waitUntil: 'commit' }); break;
      case 'reload': await page.reload({ waitUntil: 'commit' }); break;
      case 'back': await page.goBack({ waitUntil: 'commit' }); break;
      case 'forward': await page.goForward({ waitUntil: 'commit' }); break;
      case 'tab-list': return { ok: true, exitCode: 0, stdout: JSON.stringify({ tabs: await tabsOf(v) }), stderr: '' };
      case 'tab-select':
      case 'tab-close': {
        // The Playwright CLI names tabs by index.
        if (!/^\d+$/.test(command.tab)) throw new Error('Unsupported tab operation');
        const r = await cli(b, [command.kind, command.tab]);
        await refresh(v);
        return { ok: r.exitCode === 0, ...r };
      }
      case 'viewport':
      case 'device': {
        const devices = install.library.devices;
        const device = command.kind === 'device' && Object.prototype.hasOwnProperty.call(devices, command.name) ? devices[command.name] : undefined;
        const size = command.kind === 'viewport' ? command
          : device ? { width: device.viewport.width, height: device.viewport.height, dpr: device.deviceScaleFactor } : undefined;
        if (!size) throw new Error('Invalid viewport/device');
        const { width, height, dpr } = size;
        await page.setViewportSize({ width, height });
        const cdp = await control(v, page);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: device?.isMobile ?? false });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: device?.hasTouch ?? false });
        if (device) await cdp.send('Emulation.setUserAgentOverride', { userAgent: device.userAgent });
        break;
      }
      default: throw new Error('Unsupported Playwright host command');
    }
    await refresh(v);
    return { ok: true, exitCode: 0, stdout: '', stderr: '' };
  }
  async function request(r: PlaywrightRequest): Promise<PlaywrightResult> {
    try {
      if (closed) throw new Error('Playwright host is shutting down');
      return await execute(r);
    } catch (e) {
      const error = messageOf(e);
      return { ok: false, error, exitCode: 1, stdout: '', stderr: error };
    }
  }
  async function requestFile(r: PlaywrightRequest): Promise<PlaywrightResult> {
    try {
      const result = await request(r);
      if (!result.bytes) return result;
      if (closed) return { ok: false, error: 'Playwright host is shutting down' };
      const file = path.join(await captures.get(), `${randomBytes(16).toString('hex')}.frame`);
      await writeFile(file, result.bytes, { mode: 0o600 });
      // Shutdown may have begun while the frame was written.
      if (closed) {
        await captures.remove();
        return { ok: false, error: 'Playwright host is shutting down' };
      }
      return { ok: true, path: file, mime: result.mime };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }
  async function close() {
    closed = true;
    await Promise.allSettled([...lifecycle.values(), ...connecting.values()]);
    await Promise.all([...headed.values()].map(async b => {
      await invalidate(b);
      await cli(b, ['close']).catch(log);
    }));
    await Promise.all([...viewers.values()].map(dispose));
    viewers.clear();
    headed.clear();
    await captures.remove();
  }
  return { request, requestFile, close };
}
