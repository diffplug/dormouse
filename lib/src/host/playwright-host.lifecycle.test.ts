// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Server } from 'node:http';
import { WebSocket } from 'ws';
import { createPlaywrightHost } from './playwright-host';
import { PLAYWRIGHT_TEXT_INPUT_MAX, playwrightTextInputs } from '../lib/platform/browser-automation';

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
  const { wsPort } = await host.request({ ...binding, op: 'streamStatus' });
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
  const result = await host.request({ ...binding, op: 'streamStatus' });
  expect(result.error).toBe('Listener unavailable');
  expect(browser.close).toHaveBeenCalledTimes(1);
});

test('captures reuse recent tab state but refresh it when it expires', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
  browser.contexts = () => [{ pages: () => [page, Object.assign(new EventEmitter(), page)] }];
  expect((await host.request({ ...binding, op: 'streamStatus' })).ok).toBe(true);
  mocks.cli.mockClear();
  for (let i = 0; i < 10; i++) expect((await host.request({ ...binding, op: 'screenshot' })).ok).toBe(true);
  expect(mocks.cli).not.toHaveBeenCalled();
  now.mockReturnValue(10750);
  expect((await host.request({ ...binding, op: 'screenshot' })).ok).toBe(true);
  expect(mocks.cli).toHaveBeenCalledExactlyOnceWith('/tools/playwright-cli', ['--session=test', 'tab-list', '--json'], { cwd: binding.cwd });
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
  expect((await host.request({ ...binding, op: 'streamStatus' })).headed).toBe(true);
  browser.emit('disconnected');
  headless = true;
  expect((await host.request({ ...binding, op: 'streamStatus' })).headed).toBe(false);
  mocks.cli.mockClear();
  await host.close();
  expect(mocks.cli).not.toHaveBeenCalled();
});

test('a single-page browser refreshes without asking the CLI for its selection', async () => {
  expect((await host.request({ ...binding, op: 'streamStatus' })).ok).toBe(true);
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
  const { wsPort } = await host.request({ ...binding, op: 'streamStatus' });
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
    await host.request({ ...binding, op: 'streamStatus' });
    await host.request({ ...binding, op: 'streamStatus' });
    page.url = () => 'http://localhost/next';
    await host.request({ ...binding, op: 'streamStatus' });
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
  const { wsPort } = await host.request({ ...binding, op: 'streamStatus' });
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
