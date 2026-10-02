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
vi.mock('../src/shell-selection', () => ({
  resolveSelectedShell: (_context: unknown, shells: unknown[]) => shells[0],
}));
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
const cmd = [{ name: 'cmd', path: 'cmd.exe', args: [] }];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.take.mockReturnValue({});
  mocks.serve.mockReturnValue({ post: () => Promise.resolve(true) });
  mocks.attach.mockReturnValue({ dispose: vi.fn() });
});

it('does not touch a disposed view after asynchronous shell discovery', async () => {
  const ready = deferred<unknown[]>(), target = view();
  const description = vi.fn();
  Object.defineProperty(target.value, 'description', { set: description });
  mocks.shells.mockReturnValue(ready.promise);
  const host = new DormouseViewProvider({ extensionPath: 'extension' } as never);
  const pending = host.resolveWebviewView(target.value, {} as never, {} as never);
  target.dispose();
  ready.resolve(cmd);
  await pending;
  expect(description).not.toHaveBeenCalled();
  expect(mocks.take).not.toHaveBeenCalled();
  expect(mocks.serve).not.toHaveBeenCalled();
  expect(mocks.attach).not.toHaveBeenCalled();
});

it('a late old shell discovery and old disposal cannot replace or dispose a newer view', async () => {
  const ready = deferred<unknown[]>(), first = view(), second = view();
  const host = new DormouseViewProvider({ extensionPath: 'extension' } as never);
  const newRouter = { dispose: vi.fn() };
  mocks.attach.mockReturnValue(newRouter);
  mocks.shells.mockReturnValueOnce(ready.promise).mockResolvedValueOnce(cmd);
  const old = host.resolveWebviewView(first.value, {} as never, {} as never);
  await host.resolveWebviewView(second.value, {} as never, {} as never);
  ready.resolve(cmd);
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
