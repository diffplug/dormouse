// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Server } from 'node:http';
import { createPlaywrightHost } from './playwright-host';

const mocks = vi.hoisted(() => ({ cli: vi.fn(), connect: vi.fn() }));
vi.mock('dor-lib-common', () => ({ spawnAndCapture: mocks.cli }));
vi.mock('./playwright-install', () => ({
  resolvePlaywrightInstall: () => ({ binary: '/tools/playwright-cli', libraryPath: process.cwd(), library: { chromium: { connect: mocks.connect } } }),
  playwrightWorkspace: () => process.cwd(),
}));

let host: ReturnType<typeof createPlaywrightHost>;
let page: EventEmitter & Record<string, any>;
let browser: EventEmitter & Record<string, any>;
let cdp: { send: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> };
let attach: ReturnType<typeof vi.fn>;
const binding = { cwd: process.cwd(), session: 'test' };

beforeEach(() => {
  vi.clearAllMocks();
  cdp = { send: vi.fn().mockResolvedValue({ data: 'aGVsbG8=' }), detach: vi.fn().mockResolvedValue(undefined) };
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
      title: 'test', workspaceDir: process.cwd(), playwrightLib: process.cwd(),
      endpoint: '/tmp/test-playwright.pipe', browser: { browserName: 'chromium' },
    }] } : { result: '- 0: (current) Test' }),
  }));
  host = createPlaywrightHost({ writeClipboardText() {} });
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
