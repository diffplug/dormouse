// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createBrowserCaptures } from './browser-capture';
import { createBrowserHost, type BrowserProvider } from './browser-host';
import { openViewer } from './browser-host-test-utils';
import { WINDOW_GONE_GRACE_MS } from './browser-viewer';
import { createPlaywrightProvider } from './playwright-host';
import { BROWSER_REQUEST_TIMEOUT_MS, VIEWER_TEXT_INPUT_MAX, viewerTextInputs, type BrowserOp, type BrowserRequestBinding } from '../lib/platform/browser-automation';

const mocks = vi.hoisted(() => ({ cli: vi.fn(), connect: vi.fn(), clipboard: vi.fn() }));
vi.mock('dor-lib-common', async importOriginal => ({ ...await importOriginal<typeof import('dor-lib-common')>(), spawnAndCapture: mocks.cli }));
vi.mock('./playwright-install', () => ({
  resolvePlaywrightInstall: () => ({ binary: '/tools/playwright-cli', libraryPath: process.cwd(), library: { chromium: { connect: mocks.connect } } }),
  playwrightWorkspace: () => process.cwd(),
}));

let host: ReturnType<typeof createBrowserHost>;
let provider: BrowserProvider<any>;
let page: EventEmitter & Record<string, any>;
let browser: EventEmitter & Record<string, any>;
let cdp: { send: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
let attach: ReturnType<typeof vi.fn>;
const binding = { cwd: process.cwd(), session: 'test' };
/** One Playwright request through the shared host, bound to `b`. */
const pw = (op: BrowserOp, b: BrowserRequestBinding = binding) => host.request({ provider: 'playwright', binding: b, ...op });
let captures: ReturnType<typeof createBrowserCaptures>;
/** One crisp capture, as the host takes it for a viewer socket: joined per
 *  browser. */
const capture = () => {
  const b = provider.bind({ ...binding });
  return captures.take(provider.identity(b), (file) => provider.screenshot(b, file)).then(() => true, () => false);
};
/** A viewer socket onto the session's live browser. */
const viewSession = async () => {
  const { stream } = await pw({ op: 'attach' });
  return openViewer((await pw({ op: 'view', stream: stream! })).url!);
};

beforeEach(() => {
  vi.clearAllMocks();
  cdp = { send: vi.fn().mockResolvedValue({ data: 'aGVsbG8=' }), detach: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
  attach = vi.fn().mockResolvedValue(cdp);
  page = Object.assign(new EventEmitter(), {
    context: () => ({ newCDPSession: attach }), isClosed: () => false,
    title: async () => 'Test', url: () => 'http://localhost/',
    evaluate: async () => ({ width: 640, height: 480, dpr: 1 }), viewportSize: () => ({ width: 640, height: 480 }),
  });
  browser = Object.assign(new EventEmitter(), {
    contexts: () => [{ pages: () => [page] }], isConnected: () => true,
    close: vi.fn().mockResolvedValue(undefined),
  });
  mocks.connect.mockResolvedValue(browser);
  mocks.cli.mockImplementation(async (_binary, args) => ({
    ok: true, exitCode: 0, stderr: '',
    stdout: JSON.stringify(args.includes('list') ? { servers: [{
      title: args[0].slice('--session='.length), workspaceDir: process.cwd(), playwrightLib: process.cwd(),
      endpoint: '/tmp/test-playwright.pipe', browser: { browserName: 'chromium' },
    }] } : { result: '- 0: (current) Test' }),
  }));
  provider = createPlaywrightProvider();
  captures = createBrowserCaptures();
  host = createBrowserHost({ writeClipboardText: mocks.clipboard, providers: { playwright: () => provider } });
});
afterEach(async () => { await host.close(); await captures.remove(); vi.restoreAllMocks(); });

test('concurrent captures join one, a concurrent control shares its CDP attachment, and close detaches it once', async () => {
  page.setViewportSize = vi.fn(async () => {});
  const [first, second, sized] = await Promise.all([
    capture(),
    capture(),
    pw({ op: 'viewport', width: 640, height: 480, dpr: 1 }),
  ]);
  expect([first, second]).toEqual([true, true]);
  expect(sized.ok).toBe(true);
  expect(attach).toHaveBeenCalledTimes(1);
  expect(cdp.send.mock.calls.filter(([method]) => method === 'Page.captureScreenshot')).toHaveLength(1);
  expect((await pw({ op: 'close' })).ok).toBe(true);
  expect(cdp.detach).toHaveBeenCalledTimes(1);
  expect(browser.close).toHaveBeenCalledTimes(1);
});

test('closing during a CDP attachment releases it without capturing', async () => {
  let complete!: (value: typeof cdp) => void;
  attach.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  await pw({ op: 'attach' });
  const captured = capture();
  await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
  const closing = pw({ op: 'close' });
  // The close releases the connection, whose disposal waits on the attachment.
  await new Promise((resolve) => setTimeout(resolve, 20));
  complete(cdp);
  expect(await captured).toBe(false);
  expect((await closing).ok).toBe(true);
  expect(cdp.send).not.toHaveBeenCalled();
  expect(cdp.detach).toHaveBeenCalledTimes(1);
});

test('a failed attachment can be retried', async () => {
  attach.mockRejectedValueOnce(new Error('Tab detached'));
  expect(await capture()).toBe(false);
  expect(await capture()).toBe(true);
  expect(attach).toHaveBeenCalledTimes(2);
});

test('captures reuse recent tab state but refresh it when it expires', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
  browser.contexts = () => [{ pages: () => [page, Object.assign(new EventEmitter(), page)] }];
  expect((await pw({ op: 'attach' })).ok).toBe(true);
  // No viewer yet, so attach left the tab state to the first capture.
  expect(await capture()).toBe(true);
  mocks.cli.mockClear();
  for (let i = 0; i < 10; i++) expect(await capture()).toBe(true);
  expect(mocks.cli).not.toHaveBeenCalled();
  now.mockReturnValue(10750);
  expect(await capture()).toBe(true);
  expect(mocks.cli).toHaveBeenCalledExactlyOnceWith('/tools/playwright-cli', ['--session=test', 'tab-list', '--json'], { cwd: binding.cwd, timeoutMs: 10_000 });
});

test('GUI tab selection refreshes immediately even with a recent capture', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(10000);
  const second = Object.assign(new EventEmitter(), page, { url: () => 'http://localhost/second' });
  browser.contexts = () => [{ pages: () => [page, second] }];
  const originalCli = mocks.cli.getMockImplementation()!;
  let active = 0;
  mocks.cli.mockImplementation(async (binary, args, options) => {
    if (args.includes('tab-select')) active = Number(args.at(-1));
    if (args.includes('tab-list')) return { ok: true, exitCode: 0, stdout: JSON.stringify({ result: `- ${active}: (current) Test` }), stderr: '' };
    return originalCli(binary, args, options);
  });
  expect(await capture()).toBe(true);
  expect((await pw({ op: 'tab', action: 'select', tabId: '1' })).ok).toBe(true);
  expect(await capture()).toBe(true);
  expect(attach).toHaveBeenLastCalledWith(second);
});

test('a native reopen in headless mode clears headed shutdown ownership', async () => {
  const originalCli = mocks.cli.getMockImplementation()!;
  let headless = false;
  mocks.cli.mockImplementation(async (binary, args, options) => {
    const result = await originalCli(binary, args, options);
    if (args.includes('list')) {
      const registry = JSON.parse(result.stdout);
      registry.servers[0].browser.launchOptions = { headless };
      result.stdout = JSON.stringify(registry);
    }
    return result;
  });
  expect((await pw({ op: 'attach' })).headed).toBe(true);
  browser.emit('disconnected');
  headless = true;
  expect((await pw({ op: 'attach' })).headed).toBe(false);
  mocks.cli.mockClear();
  await host.close();
  expect(mocks.cli).not.toHaveBeenCalled();
});

test('a single-page browser refreshes without asking the CLI for its selection', async () => {
  expect((await pw({ op: 'attach' })).ok).toBe(true);
  expect(mocks.cli.mock.calls.map(([, args]) => args[1])).toEqual(['list']);
});

test('a GUI open launches its fresh session without closing it first; a named launch navigates it in its mode and relaunches it into the other', async () => {
  page.goto = vi.fn(async () => null);
  const opened = await pw({ op: 'launch', url: 'http://localhost/', headed: false }, { cwd: process.cwd() });
  expect(opened.error).toBeUndefined();
  expect(mocks.cli.mock.calls.map(([, args]) => args[1])).not.toContain('close');
  const named = { ...binding, session: opened.session! };

  // Up headless (a Tool re-announced): its page opens there, and nothing an
  // agent drives is stopped.
  mocks.cli.mockClear();
  expect(await pw({ op: 'launch', url: 'http://localhost/next', headed: false }, named)).toMatchObject({ ok: true, headed: false });
  expect(mocks.cli.mock.calls.map(([, args]) => args[1])).not.toContain('close');
  expect(mocks.cli.mock.calls.map(([, args]) => args[1])).not.toContain('open');
  await vi.waitFor(() => expect(page.goto).toHaveBeenCalledWith('http://localhost/next', { waitUntil: 'commit' }));

  // A pop-out asks for the other mode: a relaunch, closing first.
  mocks.cli.mockClear();
  expect((await pw({ op: 'launch', url: 'http://localhost/', headed: true }, named)).ok).toBe(true);
  expect(mocks.cli.mock.calls[0][1]).toEqual([`--session=${opened.session}`, 'close']);
});

test('a relaunch without an http(s) page reopens blank; a GUI open still needs one', async () => {
  // A bare `dor pw open` pane sits on about:blank; a headed window can be left
  // on a file, data or error page when the user closes it. Each is a pop-out
  // of the headless browser up, so a relaunch.
  for (const url of [undefined, 'about:blank', 'file:///etc/passwd', 'data:text/html,hi', 'chrome-error://chromewebdata/']) {
    mocks.cli.mockClear();
    const result = await pw({ op: 'launch', headed: true, ...(url === undefined ? {} : { url }) });
    expect(result.error, url).toBeUndefined();
    const open = mocks.cli.mock.calls.find(([, args]) => args[1] === 'open')![1];
    expect(open, url).toEqual(['--session=test', 'open', '--browser=chromium', '--headed']);
  }
  mocks.cli.mockClear();
  expect((await pw({ op: 'launch', url: 'http://localhost/next', headed: true })).ok).toBe(true);
  expect(mocks.cli.mock.calls.find(([, args]) => args[1] === 'open')![1]).toContain('http://localhost/next');
  expect((await pw({ op: 'launch', url: 'file:///etc/passwd', headed: false }, { cwd: process.cwd() })).error).toBe('Browser navigation requires an http(s) URL');
});

test.each(['attach', 'startScreencast'] as const)('a screencast whose %s fails mid-navigation is retried on the next poll', async (failing) => {
  const { stream } = await pw({ op: 'attach' });
  const starts = () => cdp.send.mock.calls.filter(([method]) => method === 'Page.startScreencast').length;
  if (failing === 'attach') attach.mockRejectedValueOnce(new Error('Target navigated'));
  else {
    cdp.send.mockImplementationOnce(async (method: string) => {
      if (method === 'Page.startScreencast') throw new Error('Target navigated');
      return { data: 'aGVsbG8=' };
    });
  }
  const viewer = await openViewer((await pw({ op: 'view', stream: stream! })).url!);
  try {
    // The next 750 ms poll attaches again and starts the screencast.
    await vi.waitFor(() => expect(starts()).toBe(failing === 'attach' ? 1 : 2), { timeout: 3000 });
  } finally {
    viewer.socket.terminate();
  }
});

describe('attach', () => {
  // The registry lists the session only once `open` has run for it.
  let running: boolean;
  let browserName: string;
  beforeEach(() => {
    running = false;
    browserName = 'chromium';
    mocks.cli.mockImplementation(async (_binary, args) => {
      if (args[1] === 'open') running = true;
      const servers = running ? [{
        title: 'test', workspaceDir: process.cwd(), playwrightLib: process.cwd(),
        endpoint: '/tmp/test-playwright.pipe', browser: { browserName },
      }] : [];
      return { ok: true, exitCode: 0, stderr: '', stdout: JSON.stringify(args[1] === 'list' ? { servers } : { result: '- 0: (current) Test' }) };
    });
  });
  const verbs = () => mocks.cli.mock.calls.map(([, args]) => args[1]);

  test('a live session answers its viewer port without launching', async () => {
    running = true;
    const attached = await pw({ op: 'attach', url: 'http://localhost/' });
    expect(attached).toMatchObject({ ok: true, headed: false, stream: expect.any(Number) });
    expect(attached).not.toHaveProperty('relaunched');
    expect(verbs()).not.toContain('open');
  });

  test('a gone session relaunches at the page named, and fails without one', async () => {
    expect((await pw({ op: 'attach' })).error).toBe('Playwright session is not open or has no viewable endpoint');
    expect(verbs()).not.toContain('open');

    const attached = await pw({ op: 'attach', url: 'http://localhost/', headed: true });
    // Opened at the page, so the caller has no navigation left to run.
    expect(attached).toMatchObject({ ok: true, stream: expect.any(Number), relaunched: true });
    expect(mocks.cli.mock.calls.map(([, args]) => args)).toContainEqual(['--session=test', 'open', 'http://localhost/', '--browser=chromium', '--headed']);
  });

  test('refreshes tab state only for viewers already connected', async () => {
    running = true;
    // Two tabs, so a refresh would ask the CLI which is selected.
    browser.contexts = () => [{ pages: () => [page, Object.assign(new EventEmitter(), page)] }];
    expect((await pw({ op: 'attach' })).ok).toBe(true);
    expect(verbs()).toEqual(['list']);
  });

  test('relaunches a session no registry entry names without closing it first', async () => {
    expect((await pw({ op: 'attach', url: 'http://localhost/' })).ok).toBe(true);
    expect(verbs()).not.toContain('close');
  });

  test('a session it cannot view is never relaunched', async () => {
    running = true;
    browserName = 'firefox';
    expect((await pw({ op: 'attach', url: 'http://localhost/' })).ok).toBe(false);
    expect(verbs()).not.toContain('open');
  });
});

test('copy runs the shared edit script and never overwrites the clipboard with an empty selection', async () => {
  page.evaluate = vi.fn(async (script: unknown) => typeof script === 'string' ? '' : { width: 640, height: 480, dpr: 1 });
  expect(await pw({ op: 'edit', edit: 'copy' })).toMatchObject({ ok: true, text: '' });
  expect(mocks.clipboard).not.toHaveBeenCalled();
  page.evaluate = vi.fn(async (script: unknown) => typeof script === 'string' ? 'hello' : { width: 640, height: 480, dpr: 1 });
  expect(await pw({ op: 'edit', edit: 'copy' })).toMatchObject({ ok: true, text: 'hello' });
  expect(mocks.clipboard).toHaveBeenCalledExactlyOnceWith('hello');
  expect((await pw({ op: 'edit', edit: 'constructor' as never })).error).toBe("unknown edit op 'constructor'");
});

test('viewers get tabs, url and status only when they change, and the current state when they connect', async () => {
  const viewers: Awaited<ReturnType<typeof viewSession>>[] = [];
  const connectViewer = async () => {
    const viewer = await viewSession();
    viewers.push(viewer);
    return () => viewer.states.map((state) => state.type);
  };
  try {
    const first = await connectViewer();
    await vi.waitFor(() => expect(first()).toEqual(['url', 'tabs', 'status']));
    await pw({ op: 'attach' });
    await pw({ op: 'attach' });
    page.url = () => 'http://localhost/next';
    await pw({ op: 'attach' });
    // A repeated state message would have arrived ahead of the navigation.
    await vi.waitFor(() => expect(first()).toEqual(['url', 'tabs', 'status', 'url', 'tabs']));
    const second = await connectViewer();
    await vi.waitFor(() => expect(second()).toEqual(['url', 'tabs', 'status']));
    expect(first()).toHaveLength(5);
  } finally {
    for (const viewer of viewers) viewer.socket.terminate();
  }
});

test('a long paste reaches the page whole without tripping the input backlog', async () => {
  const viewer = await viewSession();
  const closed = vi.fn();
  viewer.socket.on('close', closed);
  try {
    // Past 128 characters, a key pair per character overflowed the 256-message
    // queue. The first message would end between an emoji's two halves.
    const text = `${'x'.repeat(VIEWER_TEXT_INPUT_MAX - 1)}🙂${'é🙂\n'.repeat(40_000)}`;
    for (const message of viewerTextInputs(text)) viewer.send(message);
    const insertions = () => cdp.send.mock.calls.filter(([method]) => method === 'Input.insertText').map(([, params]) => params.text as string);
    const inserted = () => insertions().join('');
    await vi.waitFor(() => expect(inserted()).toBe(text));
    expect(insertions().every(chunk => chunk.isWellFormed())).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    // Text past the per-message bound is refused, like oversized key input.
    cdp.send.mockClear();
    viewer.send({ type: 'input_text', text: 'x'.repeat(VIEWER_TEXT_INPUT_MAX + 1) });
    viewer.send({ type: 'input_text', text: 'ok' });
    await vi.waitFor(() => expect(inserted()).toBe('ok'));
  } finally {
    viewer.socket.terminate();
  }
});

test('closes a viewer socket whose input backs up behind CDP', async () => {
  const viewer = await viewSession();
  // CDP stops answering input.
  cdp.send.mockImplementation((method: string) => method.startsWith('Input.') ? new Promise(() => {}) : Promise.resolve({ data: 'aGVsbG8=' }));
  for (let i = 0; i < 300; i++) viewer.send({ type: 'input_mouse', eventType: 'mouseMoved', x: i, y: 1 });
  expect(await viewer.closed).toBe(1008);
});

test('frames reach the viewer as binary, decoded once, their acks paced to ~20 a second', async () => {
  const handlers = new Map<string, (event: unknown) => void>();
  cdp.on.mockImplementation((event: string, handler: (event: unknown) => void) => { handlers.set(event, handler); });
  const viewer = await viewSession();
  try {
    await vi.waitFor(() => expect(handlers.has('Page.screencastFrame')).toBe(true));
    const acks = () => cdp.send.mock.calls.filter(([method]) => method === 'Page.screencastFrameAck');
    const screencastFrame = (n: number) => handlers.get('Page.screencastFrame')!({
      data: Buffer.from([0xff, 0xd8, n]).toString('base64'), sessionId: n, metadata: { deviceWidth: 640, deviceHeight: 480 },
    });
    screencastFrame(1);
    await vi.waitFor(() => expect(acks()).toHaveLength(1));
    const start = Date.now();
    screencastFrame(2);
    await vi.waitFor(() => expect(acks()).toHaveLength(2));
    // Chrome sends the next frame only once this one is acknowledged.
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    await vi.waitFor(() => expect(viewer.frames.length).toBeGreaterThan(0));
    expect(viewer.frames[0]).toMatchObject({ kind: 'provisional', size: { width: 640, height: 480 } });
    expect([...viewer.frames[0].jpeg]).toEqual([0xff, 0xd8, 1]);
  } finally {
    viewer.socket.terminate();
  }
});

test('a browser that disconnects on its own tells its viewers it is gone', async () => {
  const viewer = await viewSession();
  await vi.waitFor(() => expect(viewer.states.map((state) => state.type)).toContain('status'));
  browser.emit('disconnected');
  expect(await viewer.closed).toBe(1000);
  expect(viewer.states.at(-1)).toEqual({ type: 'status', connected: false, screencasting: false });
});

describe('a headed window', () => {
  let pages: unknown[];
  beforeEach(() => {
    pages = [page];
    browser.contexts = () => [{ pages: () => pages }];
    // The host's own measure, run as the page would.
    vi.stubGlobal('innerWidth', 1200);
    vi.stubGlobal('innerHeight', 736);
    vi.stubGlobal('devicePixelRatio', 2);
    page.evaluate = async (measure: () => unknown) => measure();
    // The CLI launched it headed.
    const originalCli = mocks.cli.getMockImplementation()!;
    mocks.cli.mockImplementation(async (binary, args, options) => {
      const result = await originalCli(binary, args, options);
      if (!args.includes('list')) return result;
      const registry = JSON.parse(result.stdout);
      registry.servers[0].browser.launchOptions = { headless: false };
      return { ...result, stdout: JSON.stringify(registry) };
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  /** A popped-out pane's viewer socket onto the session's browser. */
  const viewWindow = async () => {
    const { stream } = await pw({ op: 'attach' });
    return openViewer((await pw({ op: 'view', stream: stream!, headed: true })).url!);
  };

  test('reports its viewport and ratio, as its page measures them', async () => {
    const viewer = await viewWindow();
    try {
      await vi.waitFor(() => expect(viewer.states).toContainEqual(
        { type: 'status', connected: true, screencasting: false, viewportWidth: 1200, viewportHeight: 736, devicePixelRatio: 2 },
      ));
    } finally {
      viewer.socket.terminate();
    }
  });

  test('is gone once every page of its browser has closed, though the browser runs on', async () => {
    const viewer = await viewWindow();
    await vi.waitFor(() => expect(viewer.states.map((state) => state.type)).toContain('status'));
    pages = [];
    // A refresh reports the pages it sees, as the poll does.
    await pw({ op: 'attach' });
    expect(await viewer.closed).toBe(1000);
    expect(viewer.states.at(-1)).toEqual({ type: 'status', connected: false, screencasting: false });
  });

  test('is not gone when a tab closed is replaced', async () => {
    const viewer = await viewWindow();
    try {
      await vi.waitFor(() => expect(viewer.states.map((state) => state.type)).toContain('status'));
      pages = [];
      await pw({ op: 'attach' });
      pages = [Object.assign(new EventEmitter(), page)];
      await pw({ op: 'attach' });
      await new Promise((resolve) => setTimeout(resolve, 2 * WINDOW_GONE_GRACE_MS));
      expect(viewer.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      viewer.socket.terminate();
    }
  });
});

describe('a GUI launch that gives up', () => {
  const ok = { ok: true, exitCode: 0, stdout: '', stderr: '' };
  let events: string[];
  let open: PromiseWithResolvers<typeof ok>;
  let listed: () => boolean;
  // A wedged playwright-cli: the verbs here never finish on their own, and end
  // only as a bounded `spawnAndCapture` would, at their `timeoutMs`.
  let hung: (verb: string) => boolean;
  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    open = Promise.withResolvers();
    listed = () => false;
    hung = () => false;
    mocks.cli.mockImplementation(async (_binary, args, options?: { timeoutMs?: number }) => {
      events.push(args[1]);
      if (hung(args[1])) {
        return new Promise((resolve) => {
          if (options?.timeoutMs !== undefined) setTimeout(() => resolve({ ok: false, error: { code: 'ETIMEDOUT', message: `${args[1]} timed out` } }), options.timeoutMs);
        });
      }
      if (args[1] === 'open') return open.promise;
      if (args[1] === 'list') {
        const servers = listed() ? [{ title: 'test', workspaceDir: process.cwd(), playwrightLib: process.cwd(), endpoint: '/tmp/test-playwright.pipe', browser: { browserName: 'chromium' } }] : [];
        return { ...ok, stdout: JSON.stringify({ servers }) };
      }
      return ok;
    });
  });
  // Shutdown's own CLI calls must not meet a wedged CLI once the clock is real.
  afterEach(() => { hung = () => false; vi.useRealTimers(); });

  const popOut = () => {
    const done = { at: -1 };
    const start = Date.now();
    const answer = pw({ op: 'launch', url: 'http://localhost/', headed: true }).then((r) => { done.at = Date.now() - start; return r; });
    return { answer, done };
  };

  test('lets its open land before closing the session', async () => {
    const { answer } = popOut();
    // The endpoint never appears; the open is still starting the browser.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(events.filter(verb => verb === 'close')).toHaveLength(1); // the relaunch's own
    events.push('open landed');
    open.resolve(ok);
    await vi.advanceTimersByTimeAsync(0);
    expect((await answer).ok).toBe(false);
    expect(events.slice(events.indexOf('open landed'))).toContain('close');
  });

  test('closes an open that lands after it answered, unless a newer launch owns the session', async () => {
    const { answer, done } = popOut();
    await vi.advanceTimersByTimeAsync(BROWSER_REQUEST_TIMEOUT_MS);
    expect((await answer).ok).toBe(false);
    expect(done.at).toBeLessThan(BROWSER_REQUEST_TIMEOUT_MS);
    const closes = () => events.filter(verb => verb === 'close').length;
    const before = closes();
    open.resolve(ok);
    await vi.advanceTimersByTimeAsync(0);
    expect(closes()).toBe(before + 1);

    // A newer launch of the session: the earlier open landing must not close it.
    const stale = open = Promise.withResolvers();
    const gaveUp = popOut();
    await vi.advanceTimersByTimeAsync(BROWSER_REQUEST_TIMEOUT_MS);
    await gaveUp.answer;
    open = Promise.withResolvers();
    const newer = popOut();
    await vi.advanceTimersByTimeAsync(1_000);
    const settled = closes();
    stale.resolve(ok);
    await vi.advanceTimersByTimeAsync(0);
    expect(closes()).toBe(settled);
    await vi.advanceTimersByTimeAsync(BROWSER_REQUEST_TIMEOUT_MS);
    await newer.answer;
  });

  test('answers inside the transport budget when the endpoint appears only as time runs out', async () => {
    // An 8 s connect started at the last moment used to run past the webview's wait.
    const start = Date.now();
    listed = () => Date.now() - start >= 29_800;
    mocks.connect.mockImplementation((_endpoint: string, { timeout }: { timeout: number }) => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('connect timed out')), timeout);
    }));
    const { answer, done } = popOut();
    await vi.advanceTimersByTimeAsync(BROWSER_REQUEST_TIMEOUT_MS);
    expect((await answer).ok).toBe(false);
    expect(done.at).toBeGreaterThan(0);
    expect(done.at).toBeLessThan(BROWSER_REQUEST_TIMEOUT_MS);
  });

  test('a launch queued behind a slow one still answers inside its own budget', async () => {
    const first = popOut();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = popOut();
    await vi.advanceTimersByTimeAsync(BROWSER_REQUEST_TIMEOUT_MS);
    expect((await first.answer).ok).toBe(false);
    expect((await second.answer).ok).toBe(false);
    expect(second.done.at).toBeLessThan(BROWSER_REQUEST_TIMEOUT_MS);
  });

  test('a wedged CLI cannot hold a launch past its budget', async () => {
    // A GUI open: the CLI lists nothing until the last second of startup, then
    // wedges, and wedges again on the closing call.
    const start = Date.now();
    hung = (verb) => verb === 'close' || (verb === 'list' && Date.now() - start >= 29_000);
    let at = -1;
    const answer = pw({ op: 'launch', url: 'http://localhost/', headed: false }, { cwd: process.cwd() }).then((r) => { at = Date.now() - start; return r; });
    await vi.advanceTimersByTimeAsync(BROWSER_REQUEST_TIMEOUT_MS);
    expect((await answer).ok).toBe(false);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(BROWSER_REQUEST_TIMEOUT_MS);
  });

  test('a wedged close before a queued relaunch ends it at its startup deadline', async () => {
    // The first launch's two closes finish; the queued one's own close wedges.
    hung = (verb) => verb === 'close' && events.filter(e => e === 'close').length > 2;
    const first = popOut();
    await vi.advanceTimersByTimeAsync(7_000);
    // The first gives up about 34 s in; the second then starts with 3 s of its 30 s left.
    const second = popOut();
    await vi.advanceTimersByTimeAsync(BROWSER_REQUEST_TIMEOUT_MS);
    expect((await first.answer).ok).toBe(false);
    expect((await second.answer).ok).toBe(false);
    expect(second.done.at).toBeLessThanOrEqual(30_000);
  });
});
