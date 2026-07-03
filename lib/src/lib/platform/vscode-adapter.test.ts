import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const terminalStateStoreMocks = vi.hoisted(() => ({
  applyTerminalSemanticEventsByPtyId: vi.fn(),
  removeTerminalPaneState: vi.fn(),
}));

vi.mock('../terminal-state-store', () => ({
  applyTerminalSemanticEventsByPtyId: terminalStateStoreMocks.applyTerminalSemanticEventsByPtyId,
  removeTerminalPaneState: terminalStateStoreMocks.removeTerminalPaneState,
}));

const terminalThemeMocks = vi.hoisted(() => ({
  getTerminalTheme: vi.fn(() => ({ foreground: '#eeeeee', background: '#111111', cursor: '#abcabc' })),
  listeners: new Set<() => void>(),
}));

vi.mock('../terminal-theme', () => ({
  getTerminalTheme: terminalThemeMocks.getTerminalTheme,
  onTerminalThemeChange: (cb: () => void) => {
    terminalThemeMocks.listeners.add(cb);
    return () => terminalThemeMocks.listeners.delete(cb);
  },
}));

import {
  collectTerminalSemanticEvents,
  TerminalProtocolParser,
} from '../terminal-protocol';
import { VSCodeAdapter } from './vscode-adapter';

describe('VSCodeAdapter PTY exit handling', () => {
  let windowTarget: EventTarget;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    windowTarget = new EventTarget();
    postMessage = vi.fn();
    terminalThemeMocks.listeners.clear();
    terminalThemeMocks.getTerminalTheme.mockReturnValue({ foreground: '#eeeeee', background: '#111111', cursor: '#abcabc' });
    class TestCustomEvent<T = unknown> extends Event {
      readonly detail: T;

      constructor(type: string, eventInitDict?: CustomEventInit<T>) {
        super(type, eventInitDict);
        this.detail = eventInitDict?.detail as T;
      }

      initCustomEvent(): void {}
    }
    vi.stubGlobal('window', windowTarget);
    vi.stubGlobal('CustomEvent', TestCustomEvent);
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: vi.fn(),
      setState: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps semantic pane state when a PTY exits naturally', () => {
    const adapter = new VSCodeAdapter();
    const exits: Array<{ id: string; exitCode: number }> = [];
    adapter.onPtyExit((detail) => exits.push(detail));

    windowTarget.dispatchEvent(new MessageEvent('message', {
      data: { type: 'pty:exit', id: 'pane-1', exitCode: 7 },
    }));

    expect(exits).toEqual([{ id: 'pane-1', exitCode: 7 }]);
    expect(terminalStateStoreMocks.removeTerminalPaneState).not.toHaveBeenCalled();
  });

  it('lets lifecycle cleanup remove semantic pane state after explicitly killing a PTY', () => {
    const adapter = new VSCodeAdapter();

    adapter.killPty('pane-1');

    expect(terminalStateStoreMocks.removeTerminalPaneState).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: 'pty:kill', id: 'pane-1' });
  });

  it('pushes resolved theme colors to the extension host on init and on theme change', () => {
    const adapter = new VSCodeAdapter();

    adapter.requestInit();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'dormouse:themeColors',
      foreground: '#eeeeee',
      background: '#111111',
      cursor: '#abcabc',
    });

    // A VS Code theme switch fires the observer, which re-pushes current colors.
    postMessage.mockClear();
    terminalThemeMocks.getTerminalTheme.mockReturnValue({ foreground: '#000000', background: '#ffffff', cursor: '#ff0000' });
    for (const listener of terminalThemeMocks.listeners) listener();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'dormouse:themeColors',
      foreground: '#000000',
      background: '#ffffff',
      cursor: '#ff0000',
    });
  });

  it('posts external hyperlink open requests to the extension host', () => {
    const adapter = new VSCodeAdapter();

    adapter.openExternal('https://example.com/docs');

    expect(postMessage).toHaveBeenCalledWith({
      type: 'dormouse:openExternal',
      uri: 'https://example.com/docs',
    });
  });

  it('posts allowlisted VS Code workbench commands to the extension host', () => {
    const adapter = new VSCodeAdapter();

    adapter.runWorkbenchCommand('workbench.action.quickOpen');

    expect(postMessage).toHaveBeenCalledWith({
      type: 'dormouse:runWorkbenchCommand',
      command: 'workbench.action.quickOpen',
    });
  });

  it('parses replay buffers into semantic events and strips OSCs before forwarding', () => {
    const adapter = new VSCodeAdapter();
    const replays: Array<{ id: string; data: string }> = [];
    adapter.onPtyReplay((detail) => replays.push(detail));

    windowTarget.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'pty:replay',
        id: 'pane-1',
        data: 'hello\x1b]7;file://localhost/Users/me/project\x1b\\world',
      },
    }));

    // Visible data is stripped of the OSC 7 sequence.
    expect(replays).toEqual([{ id: 'pane-1', data: 'helloworld' }]);

    // Semantic CWD event was forwarded under the PTY id.
    expect(terminalStateStoreMocks.applyTerminalSemanticEventsByPtyId).toHaveBeenCalledTimes(1);
    const [forwardedId, forwardedEvents] = terminalStateStoreMocks.applyTerminalSemanticEventsByPtyId.mock.calls[0];
    expect(forwardedId).toBe('pane-1');
    expect(forwardedEvents).toHaveLength(1);
    expect(forwardedEvents[0]).toMatchObject({
      type: 'cwd',
      cwd: { path: '/Users/me/project', source: 'osc7' },
    });
  });

  it('forwards extension-host semantic events to the pane state store', () => {
    const adapter = new VSCodeAdapter();
    const events = [
      { type: 'cwd' as const, cwd: { path: '/repo', pathKind: 'posix' as const, isRemote: false, source: 'osc633' as const, updatedAt: 5 } },
      { type: 'promptStart' as const },
    ];

    windowTarget.dispatchEvent(new MessageEvent('message', {
      data: { type: 'terminal:semanticEvents', id: 'pane-1', events },
    }));
    void adapter;

    expect(terminalStateStoreMocks.applyTerminalSemanticEventsByPtyId).toHaveBeenCalledTimes(1);
    expect(terminalStateStoreMocks.applyTerminalSemanticEventsByPtyId).toHaveBeenCalledWith('pane-1', events);
  });

  it('round-trips host-parsed semantic events through JSON to the webview adapter', () => {
    // Simulate the extension host: run live PTY data through the same parser
    // that message-router.ts uses, collect semantic events, then ship them
    // over the postMessage wire as terminal:semanticEvents.
    const hostParser = new TerminalProtocolParser();
    const parsed = hostParser.process(
      'before\x1b]7;file://prod-box/srv/app\x1b\\\x1b]133;A\x07after',
    );
    const hostEvents = collectTerminalSemanticEvents(parsed.events);
    expect(hostEvents).toHaveLength(2);

    // postMessage forces structured-clone-equivalent serialization. JSON
    // round-trip is a sufficient stand-in: it would drop functions or
    // non-cloneable values, so passing this also documents that the wire
    // payload contains only plain data.
    const wirePayload = JSON.parse(JSON.stringify({
      type: 'terminal:semanticEvents',
      id: 'pane-1',
      events: hostEvents,
    }));

    new VSCodeAdapter();
    windowTarget.dispatchEvent(new MessageEvent('message', { data: wirePayload }));

    expect(terminalStateStoreMocks.applyTerminalSemanticEventsByPtyId).toHaveBeenCalledTimes(1);
    expect(terminalStateStoreMocks.applyTerminalSemanticEventsByPtyId).toHaveBeenCalledWith('pane-1', hostEvents);
  });

  it('forwards shell replacement requests from the extension host', () => {
    const requests: unknown[] = [];
    windowTarget.addEventListener('dormouse:new-terminal', (event) => {
      requests.push((event as CustomEvent).detail);
    });

    new VSCodeAdapter();
    windowTarget.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'dormouse:newTerminal',
        shell: '/bin/zsh',
        args: ['-l'],
        name: 'zsh',
        replaceUntouched: true,
        announce: true,
      },
    }));

    expect(requests).toEqual([{
      shell: '/bin/zsh',
      args: ['-l'],
      name: 'zsh',
      replaceUntouched: true,
      announce: true,
    }]);
  });
});
