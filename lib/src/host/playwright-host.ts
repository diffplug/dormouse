/**
 * The Playwright provider beneath the shared browser host (`browser-host.ts`;
 * docs/specs/dor-browser.md → "Playwright"). The installed Playwright
 * CLI owns browsers; this provider owns what is genuinely Playwright's — the
 * install and registry discovery, and the CDP connection each browser's
 * frames, state and input travel over to the host's viewer sockets. The host
 * owns everything the providers share.
 */
import { realpathSync } from 'node:fs';
import type { Browser, Page, CDPSession } from 'playwright-core';
import { BROWSER_PROVIDERS, spawnAndCapture } from 'dor-lib-common';
import { messageOf } from '../lib/errors';
import { CAPTURE_JPEG_QUALITY, type BrowserResult, type ViewerBrowserInput, type ViewerState } from '../lib/platform/browser-automation';
import type { BrowserProvider, LiveBrowser } from './browser-host';
import { measuredViewport, type ViewerSink } from './browser-viewer';
import { resolvePlaywrightInstall, playwrightWorkspace, type PlaywrightInstall } from './playwright-install';

const TAB_REFRESH_INTERVAL_MS = 750;
const CONNECT_TIMEOUT_MS = 8_000;
// Chrome sends the next screencast frame only once the last is acknowledged,
// so pacing the acks caps the stream at ~20 frames a second.
const FRAME_INTERVAL_MS = 50;
// Input waiting on CDP past this closes the viewer socket.
const INPUT_BACKLOG = 256;
// Every CLI call but `open` ends here at the latest, so a wedged playwright-cli
// cannot hold a viewer refresh or a host operation forever. `open` alone runs
// unbounded: it lasts as long as the page load, nothing waits on it past a
// launch's own bounds, and ending it could take down the browser it started.
const CLI_TIMEOUT_MS = 10_000;

function realpathOrUndefined(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

/** The CLI registry lists no browser for the session: it is gone, not merely
 *  unviewable. `named`: some entry carried the session's name, in another
 *  project scope or installation, so a relaunch still closes it first. */
class SessionNotOpenError extends Error {
  constructor(message: string, readonly named: boolean) {
    super(message);
  }
}

/** `key` is the native identity: installation, CLI workspace and session. */
type Binding = { session: string; cwd: string; install: PlaywrightInstall; workspace: string | undefined; key: string };
function bind(session: string, cwd: string, install: PlaywrightInstall): Binding {
  const workspace = playwrightWorkspace(cwd);
  return { session, cwd, install, workspace, key: JSON.stringify([install.libraryPath, workspace ?? '', session]) };
}
/** One viewer socket's hold on a browser: headed ones get no frames. */
type Subscriber = { sink: ViewerSink; headed: boolean };
type Viewer = Binding & {
  browser: Browser;
  /** This connection's number, which the host hands back as its stream. */
  instance: number;
  subscribers: Set<Subscriber>;
  controls: Map<Page, Promise<CDPSession>>;
  /** Pages whose touch and user agent a device set over their control. */
  devices: WeakSet<Page>;
  page?: Page;
  cdp?: CDPSession;
  timer?: ReturnType<typeof setTimeout>;
  disposed: boolean;
  refreshing?: Promise<void>;
  refreshedAt?: number;
  queue: Promise<void>;
  queued: number;
  headed: boolean;
  /** The last state published per message type, replayed to each viewer that connects. */
  sent: Map<ViewerState['type'], { json: string; message: ViewerState }>;
};
const pagesOf = (v: Viewer) => v.browser.contexts().flatMap(context => context.pages());
const tabsOf = (v: Viewer) => Promise.all(pagesOf(v).map(async (page, index) => ({
  tabId: String(index), url: page.url(), title: await page.title().catch(() => ''), active: page === v.page,
})));
const watching = (v: Viewer) => [...v.subscribers].some(s => !s.headed);
export function createPlaywrightProvider(deps: { log?(text: string): void } = {}): BrowserProvider<Binding> {
  const viewers = new Map<string, Viewer>();
  const connecting = new Map<string, Promise<Viewer>>();
  // Bumped whenever the host releases a binding's viewer: a connect begun
  // before must not publish the viewer it brings back.
  const generations = new Map<string, number>();
  let instances = 0;
  let closed = false;
  const log = (e: unknown) => deps.log?.(`[playwright] ${messageOf(e)}`);
  /** One CLI call, ended after `timeoutMs` (none for `null`); throws when it could not run or finish. */
  async function cli(b: Binding, args: string[], timeoutMs: number | null = CLI_TIMEOUT_MS) {
    const r = await spawnAndCapture(b.install.binary, [...BROWSER_PROVIDERS.playwright.sessionArgs(b.session), ...args], {
      cwd: b.cwd,
      ...(timeoutMs === null ? {} : { timeoutMs: Math.max(0, timeoutMs) }),
    });
    if (!r.ok) throw new Error(r.error.message);
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }
  // Every state message re-renders the pane, so the poll publishes only
  // changes; a connecting viewer is sent the latest state instead.
  function publish(v: Viewer, message: ViewerState) {
    const json = JSON.stringify(message);
    if (v.sent.get(message.type)?.json === json) return;
    v.sent.set(message.type, { json, message });
    for (const { sink } of v.subscribers) sink.state(message);
  }
  /** Release the connection; its viewers are the host's to end. */
  async function dispose(v: Viewer) {
    if (v.disposed) return;
    v.disposed = true;
    if (v.timer) clearTimeout(v.timer);
    v.subscribers.clear();
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
      // A headed window that closed can leave its browser running with none.
      for (const { sink } of v.subscribers) sink.pages(pages.length);
      const page = pages[index] ?? pages[0];
      if (page !== v.page) {
        await v.cdp?.detach().catch(() => {});
        v.cdp = undefined;
        v.page = page;
        if (page) await startFrames(v);
      }
      const tabs = await tabsOf(v);
      if (v.disposed) return;
      // `url` precedes `tabs`: the pane drops the active tab's title on a `url`
      // until the next `tabs` restates it.
      if (page) publish(v, { type: 'url', url: page.url() });
      publish(v, { type: 'tabs', tabs });
      if (page) {
        // Taken as the measurement begins: sync-to-pane counts it only when
        // no write of its landed after (docs/specs/dor-browser.md → "Display
        // Modal And Render Swaps"). The screencast's own metadata is no
        // measure of the viewport (rationale).
        const takenAt = performance.now();
        const measured = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })).then(measuredViewport, () => undefined);
        if (measured) for (const { sink } of v.subscribers) sink.viewport({ width: measured.viewportWidth, height: measured.viewportHeight }, takenAt);
        const size = measured ? undefined : page.viewportSize();
        publish(v, { type: 'status', connected: true, screencasting: !v.headed, viewportWidth: size?.width, viewportHeight: size?.height, ...measured });
      }
      v.refreshedAt = Date.now();
    } catch (e) { log(e); }
  }
  async function startFrames(v: Viewer) {
    if (!v.page || v.cdp || v.disposed || v.headed || !watching(v)) return;
    const page = v.page;
    try {
      const cdp = await page.context().newCDPSession(page);
      // Another refresh, tab change, or parking may finish while CDP attaches.
      if (v.disposed || !watching(v) || v.page !== page || v.cdp) { await cdp.detach().catch(() => {}); return; }
      v.cdp = cdp;
      let acked = 0;
      // The last frame forwarded: a capture over the host's CDP makes Chrome
      // send it again, which forwarded would pulse the next capture, round and
      // round (rationale).
      let last: string | undefined;
      cdp.on('Page.screencastFrame', event => {
        if (v.disposed || v.cdp !== cdp) return;
        const ack = () => {
          acked = Date.now();
          void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
        };
        setTimeout(ack, Math.max(0, acked + FRAME_INTERVAL_MS - Date.now())).unref();
        if (event.data === last) return;
        last = event.data;
        // Decoded once, here; the viewer sockets carry it as binary.
        const jpeg = Buffer.from(event.data, 'base64');
        const { deviceWidth: width, deviceHeight: height } = event.metadata;
        const size = width > 0 && height > 0 ? { width, height } : undefined;
        for (const { sink, headed } of v.subscribers) if (!headed) sink.frame(jpeg, size);
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
    if (v.disposed || !v.subscribers.size || v.timer) return;
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
  /** One input message, validated by the host (`parseViewerInput`). */
  async function input(v: Viewer, data: ViewerBrowserInput) {
    if (v.disposed || !v.page) return;
    const cdp = await control(v, v.page);
    if (data.type === 'input_mouse') {
      const { eventType: type, x, y, button, buttons, modifiers, clickCount, deltaX, deltaY } = data;
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, modifiers, clickCount, ...(type === 'mouseWheel' ? { deltaX, deltaY } : {}) });
    } else if (data.type === 'input_keyboard') {
      const { eventType: type, key, code, text, windowsVirtualKeyCode, modifiers } = data;
      await cdp.send('Input.dispatchKeyEvent', { type, key, code, text, windowsVirtualKeyCode, modifiers });
    } else {
      // A paste arrives as text, not a key pair per character (`viewerTextInputs`).
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
      if (matches.length > 1) throw new Error('Ambiguous Playwright session');
      if (matches.length === 0) {
        throw new SessionNotOpenError('Playwright session is not open or has no viewable endpoint', servers.some(s => s.title === b.session));
      }
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
      const v: Viewer = {
        ...b,
        browser,
        instance: ++instances,
        subscribers: new Set(),
        controls: new Map(),
        devices: new WeakSet(),
        disposed: false,
        queue: Promise.resolve(),
        queued: 0,
        headed: descriptor.browser.launchOptions?.headless === false,
        sent: new Map(),
      };
      browser.on('disconnected', () => {
        // Gone on its own: the CLI closed it, or its window closed.
        if (!v.disposed) for (const { sink } of v.subscribers) sink.gone();
        if (viewers.get(key) === v) viewers.delete(key);
        void dispose(v);
      });
      viewers.set(key, v);
      return v;
    })();
    connecting.set(key, operation);
    try { return await operation; } finally { if (connecting.get(key) === operation) connecting.delete(key); }
  }
  /** The viewer's live page, after a refresh — immediate for a control, the
   *  poll's own for a capture. */
  async function livePage(b: Binding, force: boolean): Promise<{ v: Viewer; page: Page }> {
    const v = await connect(b);
    await refresh(v, force);
    if (!v.page) throw new Error('No Playwright page is open');
    return { v, page: v.page };
  }
  const exited = (r: { exitCode: number; stderr: string }) => r.stderr.trim() || `playwright-cli exited ${r.exitCode}`;
  const live = (v: Viewer): LiveBrowser => ({ stream: v.instance, headed: v.headed });

  return {
    pollMs: 200,

    bind: (binding) => bind(binding.session, binding.cwd ?? process.cwd(), resolvePlaywrightInstall(binding.binaryPath)),

    // Installation, CLI project scope and session: a raw `--session` shares it
    // across one project's subdirectories.
    identity: (b) => b.key,

    describe: (b) => ({ session: b.session, cwd: b.cwd, binaryPath: b.install.binary }),

    async find(b) {
      try {
        const v = await connect(b);
        // A connecting viewer is sent the current state; only live ones need it now.
        if (v.subscribers.size) await refresh(v);
        return live(v);
      } catch (error) {
        if (!(error instanceof SessionNotOpenError)) throw error;
        return { gone: error.message, named: error.named };
      }
    },

    // Finish the old CLI session before discovering the replacement endpoint.
    stop: (b, timeoutMs) => cli(b, ['close'], timeoutMs),

    async open(b, url, isHeaded) {
      const r = await cli(b, ['open', ...(url === undefined ? [] : [url]), '--browser=chromium', ...(isHeaded ? ['--headed'] : [])], null);
      return { exitCode: r.exitCode, stderr: r.stderr };
    },

    // Endpoint readiness, not the page load, completes a launch: each probe
    // lists the registry and connects.
    async probe(b, { opened, deadline }) {
      try {
        return live(await connect(b, deadline));
      } catch (error) {
        if (opened && opened.exitCode !== 0) return { failed: opened.stderr.trim() || messageOf(error) };
        throw error;
      }
    },

    async close(b, timeoutMs) {
      const r = await cli(b, ['close'], timeoutMs);
      if (r.exitCode !== 0) throw new Error(exited(r));
    },

    release: (b) => invalidate(b),

    async listTabs(b) {
      const v = await connect(b);
      return pagesOf(v).map((page, index) => ({ tabId: String(index), url: page.url() }));
    },

    // The sweep's own close: no refresh around it, unlike a GUI tab close.
    async closeTab(b, tabId) {
      await cli(b, ['tab-close', tabId]);
    },

    async act(b, act): Promise<BrowserResult> {
      const { v, page } = await livePage(b, true);
      switch (act.op) {
        case 'navigate': await page.goto(act.url, { waitUntil: 'commit' }); break;
        case 'history': {
          const options = { waitUntil: 'commit' } as const;
          if (act.dir === 'reload') await page.reload(options);
          else if (act.dir === 'back') await page.goBack(options);
          else await page.goForward(options);
          break;
        }
        case 'tab': {
          // The Playwright CLI names tabs by index.
          if (!/^\d+$/.test(act.tabId)) throw new Error('Unsupported tab operation');
          const r = await cli(b, [act.action === 'select' ? 'tab-select' : 'tab-close', act.tabId]);
          await refresh(v);
          return r.exitCode === 0 ? { ok: true } : { ok: false, error: exited(r) };
        }
        case 'viewport':
        case 'device': {
          const devices = b.install.library.devices;
          const device = act.op === 'device' && Object.prototype.hasOwnProperty.call(devices, act.name) ? devices[act.name] : undefined;
          const size = act.op === 'viewport' ? act : device?.viewport;
          if (!size) throw new Error('Invalid viewport/device');
          // Playwright's own writer, alone, which keeps the browser context's
          // ratio: a CDP metrics override from this connection would be a
          // second writer Chrome re-applies on every navigation (rationale).
          await page.setViewportSize({ width: size.width, height: size.height });
          // A device's touch and user agent ride this connection's CDP, and
          // any other viewport leaves them.
          if (device || v.devices.has(page)) {
            const cdp = await control(v, page);
            await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: device?.hasTouch ?? false });
            await cdp.send('Emulation.setUserAgentOverride', { userAgent: device?.userAgent ?? '' });
            if (device) v.devices.add(page);
            else v.devices.delete(page);
          }
          // Landed: the next poll measures it, begun after (`refreshNow`).
          return { ok: true };
        }
        default: throw new Error('Unsupported Playwright host operation');
      }
      await refresh(v);
      return { ok: true };
    },

    async evaluate(b, script) {
      const { page } = await livePage(b, true);
      return page.evaluate(script);
    },

    // CDP capture in-process. Captures share the viewer's polling cadence.
    async screenshot(b) {
      const { v, page } = await livePage(b, false);
      const cdp = await control(v, page);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: CAPTURE_JPEG_QUALITY, captureBeyondViewport: false });
      return { bytes: Buffer.from(data, 'base64') };
    },

    async view(b, stream, { headed }, sink) {
      const v = await connect(b);
      if (v.instance !== stream || v.disposed) throw new Error('Playwright stream is no longer live');
      const subscriber: Subscriber = { sink, headed };
      v.subscribers.add(subscriber);
      // Earlier viewers already hold this state; the refresh below sends only what changed.
      for (const { message } of v.sent.values()) sink.state(message);
      void refresh(v).then(() => startFrames(v)).catch(log);
      if (v.subscribers.size === 1) schedule(v);
      return {
        capturable: true,
        input(message) {
          if (v.queued >= INPUT_BACKLOG) return false;
          v.queued++;
          v.queue = v.queue.then(() => input(v, message)).catch(log).finally(() => { v.queued--; });
          return true;
        },
        close() {
          if (!v.subscribers.delete(subscriber) || watching(v)) return;
          // Nobody sees its frames now; with no viewer left, nobody its tabs.
          void v.cdp?.detach().catch(() => {});
          v.cdp = undefined;
          if (v.subscribers.size) return;
          if (v.timer) clearTimeout(v.timer);
          v.timer = undefined;
        },
      };
    },

    async dispose() {
      closed = true;
      await Promise.allSettled(connecting.values());
      await Promise.all([...viewers.values()].map(dispose));
      viewers.clear();
    },
  };
}
