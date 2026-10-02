import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  take: vi.fn(), serve: vi.fn(), attach: vi.fn(), shells: vi.fn(),
}));
vi.mock('../src/session-state', () => ({
  takeRecoveryCommands: mocks.take, getSavedSessionState: () => undefined,
  mergeAlertStates: (state: unknown) => state, saveSessionState: vi.fn(),
}));
vi.mock('../src/message-router', () => ({
  attachRouter: mocks.attach, getAlertStates: () => new Map(),
}));
vi.mock('../src/webview-messaging', () => ({ serveWebview: mocks.serve }));
vi.mock('../src/pty-manager', () => ({ getAvailableShells: mocks.shells }));
import { DormouseViewProvider } from '../src/webview-view-provider';

function view() {
  let dispose!: () => void;
  const value = { webview: {}, onDidDispose: (callback: () => void) => { dispose = callback; } };
  return { value: value as never, dispose: () => dispose() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function provider() {
  const value = new DormouseViewProvider({ extensionPath: 'extension' } as never);
  value.setSelectedShell({ shell: 'cmd.exe' });
  return value;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.serve.mockReturnValue({ post: () => Promise.resolve(true) });
  mocks.attach.mockReturnValue({ dispose: vi.fn() });
});

it('waits for the asynchronous recovery claim before serving the boot document', async () => {
  const ready = deferred<Record<string, string>>();
  mocks.take.mockReturnValue(ready.promise);
  const pending = provider().resolveWebviewView(view().value, {} as never, {} as never);
  expect(mocks.serve).not.toHaveBeenCalled();
  ready.resolve({ pane: 'codex resume ID' });
  await pending;
  expect(mocks.serve.mock.calls[0][4]).toEqual({ pane: 'codex resume ID' });
  expect(mocks.attach).toHaveBeenCalledTimes(1);
});

it('does not serve or attach a view disposed during its recovery claim', async () => {
  const ready = deferred<Record<string, string>>(), target = view();
  mocks.take.mockReturnValue(ready.promise);
  const pending = provider().resolveWebviewView(target.value, {} as never, {} as never);
  target.dispose();
  ready.resolve({});
  await pending;
  expect(mocks.serve).not.toHaveBeenCalled();
  expect(mocks.attach).not.toHaveBeenCalled();
});

it('a late old claim and old disposal cannot replace or dispose a newer view', async () => {
  const ready = deferred<Record<string, string>>(), first = view(), second = view(), host = provider();
  const newRouter = { dispose: vi.fn() };
  mocks.attach.mockReturnValue(newRouter);
  mocks.take.mockReturnValueOnce(ready.promise).mockResolvedValueOnce({});
  const old = host.resolveWebviewView(first.value, {} as never, {} as never);
  await host.resolveWebviewView(second.value, {} as never, {} as never);
  ready.resolve({});
  await old;
  first.dispose();
  expect(mocks.serve).toHaveBeenCalledTimes(1);
  expect(mocks.serve.mock.calls[0][0]).toBe((second.value as { webview: unknown }).webview);
  expect(newRouter.dispose).not.toHaveBeenCalled();
  expect(await host.postMessage({ type: 'dormouse:newTerminal' } as never)).toBe(true);
  second.dispose();
  expect(newRouter.dispose).toHaveBeenCalledTimes(1);
  expect(await host.postMessage({ type: 'dormouse:newTerminal' } as never)).toBe(false);
});

it('does not touch a disposed view after asynchronous shell discovery', async () => {
  const ready = deferred<unknown[]>(), target = view();
  const description = vi.fn();
  Object.defineProperty(target.value, 'description', { set: description });
  mocks.shells.mockReturnValue(ready.promise);
  const host = new DormouseViewProvider({ extensionPath: 'extension' } as never);
  const pending = host.resolveWebviewView(target.value, {} as never, {} as never);
  target.dispose();
  ready.resolve([{ name: 'cmd', path: 'cmd.exe', args: [] }]);
  await pending;
  expect(description).not.toHaveBeenCalled();
  expect(mocks.take).not.toHaveBeenCalled();
  expect(mocks.serve).not.toHaveBeenCalled();
});
