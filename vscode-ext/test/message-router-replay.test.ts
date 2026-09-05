import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExtensionMessage, WebviewMessage } from '../src/message-types';
import type { WebviewChannel } from '../src/webview-messaging';

const childSlot = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('child_process', () => ({ fork: () => childSlot.current }));
vi.mock('vscode', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  workspace: {},
}));
// The router configures these services at module load; this suite exercises the
// real router and PTY manager over a fake child IPC boundary, without opening
// peer sockets or an enrolled Burrow.
vi.mock('../src/peer-link', () => ({ configurePeerLink: vi.fn(), remoteNotifyPeerChange: vi.fn() }));
vi.mock('../src/burrow', () => ({
  configureBurrow: vi.fn(), deliverCommandResult: vi.fn(), deliverUiEvent: vi.fn(),
  dropForwardedCommands: vi.fn(), greetPeerWindow: vi.fn(), handleForwardedCommand: vi.fn(),
  handleBurrowCommand: vi.fn(), notifyDirectoryChanged: vi.fn(),
}));
vi.mock('../src/agent-browser-host', () => ({}));
vi.mock('../src/iframe-proxy-host', () => ({}));

let child: EventEmitter;
const routers: { dispose(): void }[] = [];
let attachRouter: typeof import('../src/message-router').attachRouter;
let ptyManager: typeof import('../src/pty-manager');

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
  childSlot.current = child;
  ptyManager = await import('../src/pty-manager');
  ({ attachRouter } = await import('../src/message-router'));
  ptyManager.spawn('pane-1');
  child.emit('message', { type: 'ready' });
});

afterEach(() => {
  for (const router of routers.splice(0)) router.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function webview() {
  const messages: ExtensionMessage[] = [];
  let receive: ((message: WebviewMessage) => void) | undefined;
  const channel: WebviewChannel = {
    post: (message) => { messages.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (listener) => {
      receive = listener;
      return { dispose() { receive = undefined; } };
    },
  };
  const router = attachRouter(channel, { reconnect: true });
  routers.push(router);
  return {
    router,
    messages,
    init: () => { messages.length = 0; receive!({ type: 'dormouse:init' }); },
    replay: () => messages.filter((message) => message.type === 'pty:replay'),
  };
}

function output(data: string) {
  child.emit('message', { type: 'data', id: 'pane-1', data });
}

it('replays retained output when a disposed view is replaced more than once', () => {
  output('before first view\r\n');
  const first = webview();
  first.init();
  expect(first.replay()).toEqual([{ type: 'pty:replay', id: 'pane-1', data: 'before first view\r\n' }]);
  output('while visible\r\n');
  first.router.dispose();
  output('while disposed\r\n');

  const second = webview();
  second.init();
  const expected = [{ type: 'pty:replay', id: 'pane-1', data: 'before first view\r\nwhile visible\r\nwhile disposed\r\n' }];
  expect(second.replay()).toEqual(expected);
  second.router.dispose();

  const third = webview();
  third.init();
  expect(third.replay()).toEqual(expected);
});

it('replays on repeated init and forwards later output exactly once', () => {
  output('before init\r\n');
  const view = webview();
  view.init();
  output('after init\r\n');
  expect(view.messages.filter((message) => message.type === 'pty:replay' || message.type === 'pty:data')).toEqual([
    { type: 'pty:replay', id: 'pane-1', data: 'before init\r\n' },
    { type: 'pty:data', id: 'pane-1', data: 'after init\r\n', textData: undefined },
  ]);
  view.init();
  expect(view.replay()).toEqual([{ type: 'pty:replay', id: 'pane-1', data: 'before init\r\nafter init\r\n' }]);
  output('after reinit\r\n');
  expect(view.messages.filter((message) => message.type === 'pty:data')).toEqual([
    { type: 'pty:data', id: 'pane-1', data: 'after reinit\r\n', textData: undefined },
  ]);
});

it('retains exited transcripts for replacements but never resurrects a killed PTY', () => {
  output('finished\r\n');
  const first = webview();
  first.init();
  child.emit('message', { type: 'exit', id: 'pane-1', exitCode: 3 });
  first.router.dispose();

  const second = webview();
  second.init();
  expect(second.replay()).toEqual([{ type: 'pty:replay', id: 'pane-1', data: 'finished\r\n' }]);
  expect(second.messages.find((message) => message.type === 'pty:list')).toEqual({
    type: 'pty:list', ptys: [{ id: 'pane-1', alive: false, exitCode: 3, shell: undefined }],
  });
  second.router.dispose();
  ptyManager.kill('pane-1');
  output('late killed output');
  child.emit('message', { type: 'exit', id: 'pane-1', exitCode: 0 });

  const third = webview();
  third.init();
  expect(third.replay()).toEqual([]);
  expect(third.messages.find((message) => message.type === 'pty:list')).toEqual({ type: 'pty:list', ptys: [] });
});

it('replays only the retained tail after the buffer cap evicts old output', () => {
  output('old'.repeat(200_000));
  const first = webview();
  first.init();
  output('new'.repeat(200_000));
  const mark = ptyManager.getScrollbackReceived('pane-1');
  output('tail');
  first.router.dispose();

  const second = webview();
  second.init();
  expect(second.replay()).toEqual([{ type: 'pty:replay', id: 'pane-1', data: `${'new'.repeat(200_000)}tail` }]);
  expect(ptyManager.getScrollbackReceived('pane-1')).toBe(1_200_004);
  expect(ptyManager.getScrollbackSince('pane-1', mark)).toBe('tail');
});

it('does not replay or forward PTYs owned by a sibling view', () => {
  output('owned history');
  const owner = webview();
  owner.init();
  const sibling = webview();
  sibling.init();
  expect(sibling.replay()).toEqual([]);
  expect(sibling.messages.find((message) => message.type === 'pty:list')).toEqual({ type: 'pty:list', ptys: [] });
  output('live output');
  expect(sibling.messages.some((message) => message.type === 'pty:data')).toBe(false);
  expect(owner.messages.filter((message) => message.type === 'pty:data')).toHaveLength(1);
});
