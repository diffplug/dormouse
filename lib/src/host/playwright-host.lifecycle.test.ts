// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Server } from 'node:http';
import { WebSocket } from 'ws';
import { createPlaywrightHost } from './playwright-host';
import { PLAYWRIGHT_REQUEST_TIMEOUT_MS, PLAYWRIGHT_TEXT_INPUT_MAX, playwrightTextInputs } from '../lib/platform/browser-automation';

const mocks = vi.hoisted(() => ({ cli: vi.fn(), connect: vi.fn(), clipboard: vi.fn() }));
vi.mock('dor-lib-common', async importOriginal => ({ ...await importOriginal<typeof import('dor-lib-common')>(), spawnAndCapture: mocks.cli }));
vi.mock('./playwright-install', () => ({
  resolvePlaywrightInstall: () => ({ binary: '/tools/playwright-cli', libraryPath: process.cwd(), library: { chromium: { connect: mocks.connect } } }),
  playwrightWorkspace: () => process.cwd(),
}));

let host: ReturnType<typeof createPlaywrightHost>;
let page: EventEmitter & Record<string, any>;
let browser: EventEmitter & Record<string, any>;
let cdp: { send: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
let attach: ReturnType<typeof vi.fn>;
const binding = { cwd: process.cwd(), session: 'test' };

beforeEach(() => {
  vi.clearAllMocks();
  cdp = { send: vi.fn().mockResolvedValue({ data: 'aGVsbG8=' }), detach: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
  attach = vi.fn().mockResolvedValue(cdp);
  page = Object.assign(new EventEmitter(), {
    context: () => ({ newCDPSession: attach }), isClosed: () => false,
    title: async () => 'Test', url: () => 'http://localhost/',
    evaluate: async () => ({ width: 640, height: 480 }),
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
  host = createPlaywrightHost({ writeClipboardText: mocks.clipboard });
});
afterEach(async () => { await host.close(); vi.restoreAllMocks(); });

test('concurrent captures share one CDP attachment and detach it once on close', async () => {
  const results = await Promise.all(Array.from({ length: 3 }, () => host.request({ ...binding, op: 'screenshot' })));
  expect(results.map(result => result.error)).toEqual([undefined, undefined, undefined]);
  expect(attach).toHaveBeenCalledTimes(1);
  expect(cdp.send).toHaveBeenCalledTimes(3);
  expect((await host.request({ ...binding, op: 'command', args: ['close'] })).ok).toBe(true);
  expect(cdp.detach).toHaveBeenCalledTimes(1);
  expect(browser.close).toHaveBeenCalledTimes(1);
});

test('closing during a CDP attachment releases it without capturing', async () => {
  let complete!: (value: typeof cdp) => void;
  attach.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const { wsPort } = await host.request({ ...binding, op: 'attach' });
  const capture = host.request({ ...binding, op: 'screenshot' });
  await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
  const closing = host.request({ ...binding, op: 'command', args: ['close'] });
  await vi.waitFor(async () => expect((await host.request({ op: 'streamUrl', port: wsPort! })).ok).toBe(false));
  complete(cdp);
  expect((await capture).ok).toBe(false);
  expect((await closing).ok).toBe(true);
  expect(cdp.send).not.toHaveBeenCalled();
  expect(cdp.detach).toHaveBeenCalledTimes(1);
});

test('a failed attachment can be retried', async () => {
  attach.mockRejectedValueOnce(new Error('Tab detached'));
  expect((await host.request({ ...binding, op: 'screenshot' })).ok).toBe(false);
  expect((await host.request({ ...binding, op: 'screenshot' })).ok).toBe(true);
  expect(attach).toHaveBeenCalledTimes(2);
});

test('a viewer listener failure releases its browser connection', async () => {
  vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
    queueMicrotask(() => this.emit('error', new Error('Listener unavailable')));
    return this;
  });
  const result = await host.request({ ...binding, op: 'attach' });
  expect(result.error).toBe('Listener unavailable');
  expect(browser.close).toHaveBeenCalledTimes(1);
});

test('captures reuse recent tab state but refresh it when it expires', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
  browser.contexts = () => [{ pages: () => [page, Object.assign(new EventEmitter(), page)] }];
  expect((await host.request({ ...binding, op: 'attach' })).ok).toBe(true);
  mocks.cli.mockClear();
  for (let i = 0; i < 10; i++) expect((await host.request({ ...binding, op: 'screenshot' })).ok).toBe(true);
  expect(mocks.cli).not.toHaveBeenCalled();
  now.mockReturnValue(10750);
  expect((await host.request({ ...binding, op: 'screenshot' })).ok).toBe(true);
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
  expect((await host.request({ ...binding, op: 'screenshot' })).ok).toBe(true);
  expect((await host.request({ ...binding, op: 'command', args: ['tab', '1'] })).ok).toBe(true);
  expect((await host.request({ ...binding, op: 'screenshot' })).ok).toBe(true);
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
  expect((await host.request({ ...binding, op: 'attach' })).headed).toBe(true);
  browser.emit('disconnected');
  headless = true;
  expect((await host.request({ ...binding, op: 'attach' })).headed).toBe(false);
  mocks.cli.mockClear();
  await host.close();
  expect(mocks.cli).not.toHaveBeenCalled();
});

test('a single-page browser refreshes without asking the CLI for its selection', async () => {
  expect((await host.request({ ...binding, op: 'attach' })).ok).toBe(true);
  expect(mocks.cli.mock.calls.map(([, args]) => args[1])).toEqual(['list']);
});

test('a GUI open launches its fresh session without closing it first; a relaunch still does', async () => {
  const opened = await host.request({ cwd: process.cwd(), op: 'open', url: 'http://localhost/' });
  expect(opened.error).toBeUndefined();
  expect(mocks.cli.mock.calls.map(([, args]) => args[1])).not.toContain('close');
  mocks.cli.mockClear();
  expect((await host.request({ ...binding, session: opened.session!, op: 'popIn', url: 'http://localhost/' })).ok).toBe(true);
  expect(mocks.cli.mock.calls[0][1]).toEqual([`--session=${opened.session}`, 'close']);
});

test('a relaunch without an http(s) page reopens blank; a GUI open still needs one', async () => {
  // A bare `dor pw open` pane sits on about:blank; a headed window can be left
  // on a file, data or error page when the user closes it.
  for (const url of [undefined, 'about:blank', 'file:///etc/passwd', 'data:text/html,hi', 'chrome-error://chromewebdata/']) {
    for (const op of ['popOut', 'popIn'] as const) {
      mocks.cli.mockClear();
      const result = await host.request({ ...binding, op, ...(url === undefined ? {} : { url }) });
      expect(result.error, `${op} ${url}`).toBeUndefined();
      const open = mocks.cli.mock.calls.find(([, args]) => args[1] === 'open')![1];
      expect(open, `${op} ${url}`).toEqual(['--session=test', 'open', '--browser=chromium', ...(op === 'popOut' ? ['--headed'] : [])]);
    }
  }
  mocks.cli.mockClear();
  expect((await host.request({ ...binding, op: 'popIn', url: 'http://localhost/next' })).ok).toBe(true);
  expect(mocks.cli.mock.calls.find(([, args]) => args[1] === 'open')![1]).toContain('http://localhost/next');
  expect((await host.request({ cwd: process.cwd(), op: 'open', url: 'file:///etc/passwd' })).error).toBe('Browser navigation requires an http(s) URL');
});

test.each(['attach', 'startScreencast'] as const)('a screencast whose %s fails mid-navigation is retried on the next poll', async (failing) => {
  const { wsPort } = await host.request({ ...binding, op: 'attach' });
  const starts = () => cdp.send.mock.calls.filter(([method]) => method === 'Page.startScreencast').length;
  if (failing === 'attach') attach.mockRejectedValueOnce(new Error('Target navigated'));
  else {
    cdp.send.mockImplementationOnce(async (method: string) => {
      if (method === 'Page.startScreencast') throw new Error('Target navigated');
      return { data: 'aGVsbG8=' };
    });
  }
  const { url } = await host.request({ op: 'streamUrl', port: wsPort! });
  const ws = new WebSocket(url!);
  ws.on('error', () => {});
  try {
    await new Promise(resolve => ws.once('open', resolve));
    // The next 750 ms poll attaches again and starts the screencast.
    await vi.waitFor(() => expect(starts()).toBe(failing === 'attach' ? 1 : 2), { timeout: 3000 });
  } finally {
    ws.terminate();
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
    const attached = await host.request({ ...binding, op: 'attach', url: 'http://localhost/' });
    expect(attached).toMatchObject({ ok: true, headed: false, wsPort: expect.any(Number) });
    expect(verbs()).not.toContain('open');
  });

  test('a gone session relaunches at the page named, and fails without one', async () => {
    expect((await host.request({ ...binding, op: 'attach' })).ok).toBe(false);
    expect(verbs()).not.toContain('open');

    const attached = await host.request({ ...binding, op: 'attach', url: 'http://localhost/', headed: true });
    expect(attached).toMatchObject({ ok: true, wsPort: expect.any(Number) });
    expect(mocks.cli.mock.calls.map(([, args]) => args)).toContainEqual(['--session=test', 'open', 'http://localhost/', '--browser=chromium', '--headed']);
  });

  test('a session it cannot view is never relaunched', async () => {
    running = true;
    browserName = 'firefox';
    expect((await host.request({ ...binding, op: 'attach', url: 'http://localhost/' })).ok).toBe(false);
    expect(verbs()).not.toContain('open');
  });
});

test('copy runs the shared edit script and never overwrites the clipboard with an empty selection', async () => {
  page.evaluate = vi.fn(async (script: unknown) => typeof script === 'string' ? '' : { width: 640, height: 480 });
  expect(await host.request({ ...binding, op: 'edit', edit: 'copy' })).toMatchObject({ ok: true, text: '' });
  expect(mocks.clipboard).not.toHaveBeenCalled();
  page.evaluate = vi.fn(async (script: unknown) => typeof script === 'string' ? 'hello' : { width: 640, height: 480 });
  expect(await host.request({ ...binding, op: 'edit', edit: 'copy' })).toMatchObject({ ok: true, text: 'hello' });
  expect(mocks.clipboard).toHaveBeenCalledExactlyOnceWith('hello');
  expect((await host.request({ ...binding, op: 'edit', edit: 'constructor' as never })).error).toBe('Invalid editing operation');
});

test('viewers get tabs, url and status only when they change, and the current state when they connect', async () => {
  const { wsPort } = await host.request({ ...binding, op: 'attach' });
  const sockets: WebSocket[] = [];
  const connectViewer = async () => {
    const { url } = await host.request({ op: 'streamUrl', port: wsPort! });
    const types: string[] = [];
    const ws = new WebSocket(url!);
    sockets.push(ws);
    ws.on('error', () => {});
    ws.on('message', raw => types.push(JSON.parse(String(raw)).type));
    await new Promise(resolve => ws.once('open', resolve));
    return types;
  };
  try {
    const first = await connectViewer();
    await vi.waitFor(() => expect(first).toEqual(['url', 'tabs', 'status']));
    await host.request({ ...binding, op: 'attach' });
    await host.request({ ...binding, op: 'attach' });
    page.url = () => 'http://localhost/next';
    await host.request({ ...binding, op: 'attach' });
    // A repeated state message would have arrived ahead of the navigation.
    await vi.waitFor(() => expect(first).toEqual(['url', 'tabs', 'status', 'url', 'tabs']));
    const second = await connectViewer();
    await vi.waitFor(() => expect(second).toEqual(['url', 'tabs', 'status']));
    expect(first).toHaveLength(5);
  } finally {
    for (const ws of sockets) ws.terminate();
  }
});

test('a long paste reaches the page whole without tripping the input backlog', async () => {
  const { wsPort } = await host.request({ ...binding, op: 'attach' });
  const { url } = await host.request({ op: 'streamUrl', port: wsPort! });
  const ws = new WebSocket(url!);
  ws.on('error', () => {});
  const closed = vi.fn();
  ws.on('close', closed);
  try {
    await new Promise(resolve => ws.once('open', resolve));
    // Past 128 characters, a key pair per character overflowed the 256-message
    // queue. The first message would end between an emoji's two halves.
    const text = `${'x'.repeat(PLAYWRIGHT_TEXT_INPUT_MAX - 1)}🙂${'é🙂\n'.repeat(40_000)}`;
    for (const message of playwrightTextInputs(text)) ws.send(JSON.stringify(message));
    const insertions = () => cdp.send.mock.calls.filter(([method]) => method === 'Input.insertText').map(([, params]) => params.text as string);
    const inserted = () => insertions().join('');
    await vi.waitFor(() => expect(inserted()).toBe(text));
    expect(insertions().every(chunk => chunk.isWellFormed())).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    // Text past the per-message bound is refused, like oversized key input.
    cdp.send.mockClear();
    ws.send(JSON.stringify({ type: 'input_text', text: 'x'.repeat(PLAYWRIGHT_TEXT_INPUT_MAX + 1) }));
    ws.send(JSON.stringify({ type: 'input_text', text: 'ok' }));
    await vi.waitFor(() => expect(inserted()).toBe('ok'));
  } finally {
    ws.terminate();
  }
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
    const answer = host.request({ ...binding, op: 'popOut', url: 'http://localhost/' }).then((r) => { done.at = Date.now() - start; return r; });
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
    await vi.advanceTimersByTimeAsync(PLAYWRIGHT_REQUEST_TIMEOUT_MS);
    expect((await answer).ok).toBe(false);
    expect(done.at).toBeLessThan(PLAYWRIGHT_REQUEST_TIMEOUT_MS);
    const closes = () => events.filter(verb => verb === 'close').length;
    const before = closes();
    open.resolve(ok);
    await vi.advanceTimersByTimeAsync(0);
    expect(closes()).toBe(before + 1);

    // A newer launch of the session: the earlier open landing must not close it.
    const stale = open = Promise.withResolvers();
    const gaveUp = popOut();
    await vi.advanceTimersByTimeAsync(PLAYWRIGHT_REQUEST_TIMEOUT_MS);
    await gaveUp.answer;
    open = Promise.withResolvers();
    const newer = popOut();
    await vi.advanceTimersByTimeAsync(1_000);
    const settled = closes();
    stale.resolve(ok);
    await vi.advanceTimersByTimeAsync(0);
    expect(closes()).toBe(settled);
    await vi.advanceTimersByTimeAsync(PLAYWRIGHT_REQUEST_TIMEOUT_MS);
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
    await vi.advanceTimersByTimeAsync(PLAYWRIGHT_REQUEST_TIMEOUT_MS);
    expect((await answer).ok).toBe(false);
    expect(done.at).toBeGreaterThan(0);
    expect(done.at).toBeLessThan(PLAYWRIGHT_REQUEST_TIMEOUT_MS);
  });

  test('a launch queued behind a slow one still answers inside its own budget', async () => {
    const first = popOut();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = popOut();
    await vi.advanceTimersByTimeAsync(PLAYWRIGHT_REQUEST_TIMEOUT_MS);
    expect((await first.answer).ok).toBe(false);
    expect((await second.answer).ok).toBe(false);
    expect(second.done.at).toBeLessThan(PLAYWRIGHT_REQUEST_TIMEOUT_MS);
  });

  test('a wedged CLI cannot hold a launch past its budget', async () => {
    // A GUI open: the CLI lists nothing until the last second of startup, then
    // wedges, and wedges again on the closing call.
    const start = Date.now();
    hung = (verb) => verb === 'close' || (verb === 'list' && Date.now() - start >= 29_000);
    let at = -1;
    const answer = host.request({ cwd: process.cwd(), op: 'open', url: 'http://localhost/' }).then((r) => { at = Date.now() - start; return r; });
    await vi.advanceTimersByTimeAsync(PLAYWRIGHT_REQUEST_TIMEOUT_MS);
    expect((await answer).ok).toBe(false);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(PLAYWRIGHT_REQUEST_TIMEOUT_MS);
  });

  test('a wedged close before a queued relaunch ends it at its startup deadline', async () => {
    // The first launch's two closes finish; the queued one's own close wedges.
    hung = (verb) => verb === 'close' && events.filter(e => e === 'close').length > 2;
    const first = popOut();
    await vi.advanceTimersByTimeAsync(7_000);
    // The first gives up about 34 s in; the second then starts with 3 s of its 30 s left.
    const second = popOut();
    await vi.advanceTimersByTimeAsync(PLAYWRIGHT_REQUEST_TIMEOUT_MS);
    expect((await first.answer).ok).toBe(false);
    expect((await second.answer).ok).toBe(false);
    expect(second.done.at).toBeLessThanOrEqual(30_000);
  });
});
