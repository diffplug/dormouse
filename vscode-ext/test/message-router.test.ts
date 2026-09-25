/**
 * The in-window fan-out: one question to every webview of this window, settled
 * as soon as they have all answered. The cross-window tier is `peer-link`'s; the
 * Burrow service that asks is `burrow`'s. Both are stubbed here so what is
 * left is the accounting — who has answered, and what a late or duplicate answer
 * does to a snapshot that was already handed to the phone.
 */


import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionMessage, WebviewMessage } from '../src/message-types';
import type { AlertCommand } from '../../lib/src/host/alert-protocol';
import type { PeerLinkDeps } from '../src/peer-link';
import type { BurrowDeps } from '../src/burrow';
import type { WebviewChannel } from '../src/webview-messaging';

/** What `message-router.ts` hands the two modules it configures at load. */
const wiring = vi.hoisted(() => ({
  peer: null as PeerLinkDeps | null,
  burrow: null as BurrowDeps | null,
  /** Every `notifyDirectoryChanged()` the router made. */
  invalidations: 0,
  /** Every due push the router's alert host sent. */
  pushes: [] as Array<[string, string]>,
}));

vi.mock('../src/peer-link', () => ({
  configurePeerLink: (deps: PeerLinkDeps) => {
    wiring.peer = deps;
  },
  remoteNotifyPeerChange: () => {},
}));

/** The pty host, as far as a disposal is concerned. */
const ptys = vi.hoisted(() => ({
  callbacks: null as { onData(id: string, data: string): void; onExit(id: string, code: number): void } | null,
  cwd: null as string | null,
  cwdAsked: [] as string[],
  cwdWait: null as Promise<void> | null,
  buffered: new Map<string, { alive: boolean }>(),
  /** `'write'`, `'kill <id>'` and `'resize <id>'`, in the order they happened. */
  order: [] as string[],
  /** Called on each PTY write, as the pty host receives it. */
  onWrite: null as ((id: string, data: string) => void) | null,
}));

vi.mock('../src/pty-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/pty-manager')>()),
  addCallbacks: (callbacks: NonNullable<typeof ptys.callbacks>) => {
    ptys.callbacks = callbacks;
    return () => {};
  },
  spawn: (id: string) => { ptys.buffered.set(id, { alive: true }); },
  getBufferedPtys: () => new Map(ptys.buffered),
  getCwd: async (id: string) => {
    ptys.cwdAsked.push(id);
    await ptys.cwdWait;
    return ptys.cwd;
  },
  kill: (id: string) => {
    ptys.order.push(`kill ${id}`);
    ptys.buffered.delete(id);
  },
  write: (id: string, data: string) => ptys.onWrite?.(id, data),
  resize: (id: string) => void ptys.order.push(`resize ${id}`),
}));

vi.mock('../src/burrow', () => ({
  configureBurrow: (deps: BurrowDeps) => {
    wiring.burrow = deps;
  },
  deliverCommandResult: () => {},
  deliverUiEvent: () => {},
  dropForwardedCommands: () => {},
  greetPeerWindow: () => {},
  handleForwardedCommand: () => {},
  handleForwardedPush: () => {},
  handleBurrowCommand: () => {},
  pushAlert: (sessionId: string, title: string) => void wiring.pushes.push([sessionId, title]),
  notifyDirectoryChanged: () => {
    wiring.invalidations += 1;
  },
}));

type RouterModule = typeof import('../src/message-router');

/** A terminal report asking for the human, as `OSC 9` carries it. */
const REPORT = '\x1b]9;needs input\x07';

/** One webview: what it was sent, and a way to make it say something back. */
function fakeWebview() {
  const posted: ExtensionMessage[] = [];
  let receive: (message: WebviewMessage) => void = () => {};
  const channel: WebviewChannel = {
    post: (message) => {
      posted.push(message);
      return Promise.resolve(true) as never;
    },
    onDidReceiveMessage: ((listener: (message: WebviewMessage) => void) => {
      receive = listener;
      return { dispose: () => {} };
    }) as never,
  };
  return {
    channel,
    posted,
    send: (message: WebviewMessage) => receive(message),
    /** The id of the fan-out this webview was last asked to answer. */
    lastAskId(): string {
      const ask = [...posted].reverse().find((message) => message.type === 'peer:ask');
      if (!ask) throw new Error('this webview was never asked anything');
      return (ask as { requestId: string }).requestId;
    },
  };
}

let router: RouterModule;

/** One alert verb, as every adapter's shared client sends it. */
function alert(webview: ReturnType<typeof fakeWebview>, command: AlertCommand): void {
  webview.send({ type: 'alert:command', command });
}

beforeEach(async () => {
  vi.resetModules();
  wiring.peer = null;
  wiring.burrow = null;
  wiring.invalidations = 0;
  wiring.pushes = [];
  ptys.cwd = null;
  ptys.cwdAsked = [];
  ptys.cwdWait = null;
  ptys.buffered.clear();
  ptys.order = [];
  ptys.onWrite = null;
  router = (await import('../src/message-router')) as RouterModule;
});

afterEach(() => {
  vi.clearAllMocks();
});

it('reports rejected helper creation as an exited terminal', () => {
  const webview = fakeWebview();
  const disposable = router.attachRouter(webview.channel, {});
  try {
    webview.send({ type: 'pty:spawn', id: 'rejected-helper', options: { helper: { parentId: 'unowned-parent', command: 'git status' } } });
    expect(webview.posted).toContainEqual({ type: 'pty:exit', id: 'rejected-helper', exitCode: 1 });
  } finally { disposable.dispose(); }
});

// The Tool stores are the owning renderer's, so a parse's announcements, state
// reports and command-start resets reach it, in stream order (docs/specs/dor-tool.md).
it('forwards a parse\'s Tool events in stream order only to the PTY owner', () => {
  const owner = fakeWebview();
  const other = fakeWebview();
  const first = router.attachRouter(owner.channel, {});
  const second = router.attachRouter(other.channel, {});
  try {
    owner.send({ type: 'dormouse:init' });
    other.send({ type: 'dormouse:init' });
    owner.send({ type: 'pty:spawn', id: 'tool-epoch', options: { cwd: '/repo' } });
    ptys.callbacks!.onData('tool-epoch', '\x1b]367;state;{"v":1,"dirty":true}\x07\x1b]633;C\x07\x1b]367;serve;{"port":6007}\x07\x1b]633;D;0\x07');
    expect(owner.posted.filter(message => message.type === 'terminal:toolEvents')).toEqual([{
      type: 'terminal:toolEvents',
      id: 'tool-epoch',
      events: [
        { kind: 'toolState', state: { dirty: true } },
        { kind: 'semantic', event: { type: 'commandStart', source: 'osc633_boundaries' } },
        { kind: 'toolAnnounce', announce: { port: 6007, name: null, key: null, dehydrate: false, persist: null } },
      ],
    }]);
    expect(other.posted.filter(message => message.type === 'terminal:toolEvents')).toEqual([]);
  } finally {
    first.dispose();
    second.dispose();
  }
});

describe('session flush', () => {
  it('waits for ordered host writes after the webview acknowledges its flush', async () => {
    vi.useFakeTimers();
    const webview = fakeWebview();
    const finish: (() => void)[] = [];
    const save = vi.fn(() => new Promise<void>((resolve) => finish.push(resolve)));
    const disposable = router.attachRouter(webview.channel, { onSaveState: save });
    try {
      webview.send({ type: 'dormouse:init' });
      let flushed = false;
      const flushing = router.flushAllSessions().then(() => { flushed = true; });
      const request = webview.posted.find((message) => message.type === 'dormouse:flushSessionSave')!;
      webview.send({ type: 'dormouse:saveState', state: { revision: 1 } });
      webview.send({ type: 'dormouse:saveState', state: { revision: 2 } });
      webview.send({ type: 'dormouse:flushSessionSaveDone', requestId: request.requestId });
      await vi.advanceTimersByTimeAsync(0);
      expect(save.mock.calls).toEqual([[{ revision: 1 }]]);
      expect(flushed).toBe(false);

      finish[0]();
      await vi.advanceTimersByTimeAsync(0);
      expect(save.mock.calls).toEqual([[{ revision: 1 }], [{ revision: 2 }]]);
      expect(flushed).toBe(false);

      finish[1]();
      await flushing;
      expect(flushed).toBe(true);
    } finally {
      disposable.dispose();
      vi.useRealTimers();
    }
  });

  it('continues saving after a rejected host write', async () => {
    const webview = fakeWebview();
    const save = vi.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);
    const disposable = router.attachRouter(webview.channel, { onSaveState: save });
    try {
      webview.send({ type: 'dormouse:init' });
      const flushing = router.flushAllSessions();
      const request = webview.posted.find((message) => message.type === 'dormouse:flushSessionSave')!;
      webview.send({ type: 'dormouse:saveState', state: { revision: 1 } });
      webview.send({ type: 'dormouse:saveState', state: { revision: 2 } });
      webview.send({ type: 'dormouse:flushSessionSaveDone', requestId: request.requestId });
      await flushing;
      expect(save).toHaveBeenCalledTimes(2);
    } finally {
      disposable.dispose();
    }
  });

  it('keeps the shutdown deadline when an acknowledged host write stalls', async () => {
    vi.useFakeTimers();
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel, {
      onSaveState: () => new Promise<void>(() => {}),
    });
    try {
      webview.send({ type: 'dormouse:init' });
      const flushing = router.flushAllSessions(25);
      const request = webview.posted.find((message) => message.type === 'dormouse:flushSessionSave')!;
      webview.send({ type: 'dormouse:saveState', state: {} });
      webview.send({ type: 'dormouse:flushSessionSaveDone', requestId: request.requestId });
      await vi.advanceTimersByTimeAsync(25);
      await flushing;
    } finally {
      disposable.dispose();
      vi.useRealTimers();
    }
  });
});

describe('webview fan-out', () => {
  it('counts one answer per webview, however many times it answers', async () => {
    // A duplicate post, or a webview answering after the budget already
    // settled the request under an id that later repeated, would otherwise
    // contribute its panes to the directory twice over.
    const first = fakeWebview();
    const second = fakeWebview();
    const disposeFirst = router.attachRouter(first.channel);
    const disposeSecond = router.attachRouter(second.channel);
    try {
      const collecting = wiring.peer!.brokerRequest('directory', {});
      const requestId = first.lastAskId();

      first.send({ type: 'peer:answer', requestId, results: [{ surfaceId: 'a' }] } as never);
      first.send({ type: 'peer:answer', requestId, results: [{ surfaceId: 'a' }] } as never);
      second.send({ type: 'peer:answer', requestId, results: [{ surfaceId: 'b' }] } as never);

      expect(await collecting).toEqual([{ surfaceId: 'a' }, { surfaceId: 'b' }]);
    } finally {
      disposeFirst.dispose();
      disposeSecond.dispose();
    }
  });

  it('marks the directory stale when an answer arrives after its request settled', async () => {
    // The budget expired and the Burrow already rendered a snapshot without this
    // webview's panes. Nothing re-opens a settled request, so the repair has to
    // be the next collect — and an idle machine has no other reason to run one.
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    try {
      const collecting = wiring.peer!.brokerRequest('directory', {});
      const requestId = webview.lastAskId();
      webview.send({ type: 'peer:answer', requestId, results: [] } as never);
      expect(await collecting).toEqual([]);

      const before = wiring.invalidations;
      webview.send({ type: 'peer:answer', requestId, results: [{ surfaceId: 'late' }] } as never);
      expect(wiring.invalidations).toBe(before + 1);
    } finally {
      disposable.dispose();
    }
  });
});

/**
 * `dor await` parks in the shared alert host, which lives here rather than in
 * the webview (docs/specs/alert.md → Await); its own suite covers the
 * bookkeeping. What this side owns is the wiring: the outcome reaches the
 * webview that asked, and nothing is left holding a completion claim when that
 * webview goes away.
 */
describe('await requests', () => {
  /** Every await outcome this webview was sent, in order. */
  function outcomes(webview: ReturnType<typeof fakeWebview>) {
    return webview.posted
      .filter((message) => message.type === 'alert:awaitResult')
      .map((message) => message as { awaitId: string; outcome: unknown });
  }

  it('judges a report after the command boundary written before it', async () => {
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    try {
      ptys.callbacks!.onData('pty-ordered', '\x1b]633;E;./build.sh\x07\x1b]633;C\x07');
      alert(webview, { op: 'await', awaitId: 'await-ordered', id: 'pty-ordered', until: 'quiet', timeoutMs: 600_000 });

      // A precmd hook reports after the shell's finish, in the same read.
      ptys.callbacks!.onData('pty-ordered', '\x1b]633;D;0\x07\x1b]777;notify;Command completed;./build.sh\x1b\\');
      await Promise.resolve();

      expect(outcomes(webview)).toEqual([
        { type: 'alert:awaitResult', awaitId: 'await-ordered', outcome: expect.objectContaining({ kind: 'resolved', cause: 'exit' }) },
      ]);
    } finally {
      disposable.dispose();
    }
  });

  it('cancels what is still parked when the webview goes away', async () => {
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    alert(webview, { op: 'await', awaitId: 'await-2', id: 'pty-2', until: 'exit', timeoutMs: 600_000 });
    expect(router.getAlertStates().get('pty-2')?.awaited).toBe(true);

    // A webview that cannot deliver an outcome must not hold a claim open, so
    // the completion it was absorbing rings the human normally again.
    disposable.dispose();
    await Promise.resolve();

    expect(router.getAlertStates().get('pty-2')?.awaited).toBe(false);
  });

  it('still answers an await it cancels on the way out', async () => {
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    alert(webview, { op: 'await', awaitId: 'await-3', id: 'pty-3', until: 'quiet', timeoutMs: 600_000 });

    // `handle.cancel()`'s outcome lands a microtask later, after the router has
    // stopped posting — so dispose answers synchronously instead. Without that
    // the webview's promise never settles and the `dor` client blocks to its
    // own deadline (docs/specs/alert.md → Await).
    disposable.dispose();
    await Promise.resolve();

    expect(outcomes(webview)).toHaveLength(1);
    expect(outcomes(webview)[0]).toMatchObject({
      awaitId: 'await-3',
      outcome: { kind: 'cancelled' },
    });
  });
});

/**
 * Each webview is one engagement viewer of the shared alert manager
 * (docs/specs/alert.md → Engagement), so what one webview reports can never
 * disengage a Session another one is showing.
 */
describe('engagement viewers', () => {
  function status(id: string): string | undefined {
    return router.getAlertStates().get(id)?.status;
  }

  it('keeps one webview blurring from disengaging another', () => {
    const a = fakeWebview();
    const b = fakeWebview();
    const disposeA = router.attachRouter(a.channel);
    const disposeB = router.attachRouter(b.channel);
    try {
      alert(a, { op: 'engagement', state: { present: true, focusId: 'pty-a' } });
      alert(b, { op: 'engagement', state: { present: true, focusId: 'pty-b' } });
      alert(a, { op: 'engagement', state: { present: false, focusId: null }, lapse: 'leave' });

      ptys.callbacks!.onData('pty-b', REPORT);
      expect(status('pty-b')).not.toBe('ALERT_RINGING');
    } finally {
      disposeA.dispose();
      disposeB.dispose();
    }
  });

  it('acknowledges for the webview that sent it', () => {
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    try {
      ptys.callbacks!.onData('pty-ack', REPORT);
      expect(status('pty-ack')).toBe('ALERT_RINGING');
      alert(webview, { op: 'acknowledge', id: 'pty-ack' });
      expect(router.getAlertStates().get('pty-ack')).toMatchObject({ status: 'WATCHING_DISABLED', todo: true });
    } finally {
      disposable.dispose();
    }
  });

  it('acknowledges user input, echo window included, before writing it', () => {
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    try {
      ptys.callbacks!.onData('pty-typed', REPORT);
      const atWrite: Array<string | undefined> = [];
      ptys.onWrite = (id) => void atWrite.push(status(id));
      webview.send({ type: 'pty:input', id: 'pty-typed', data: '\x1b[I' });
      webview.send({ type: 'pty:input', id: 'pty-typed', data: 'y', userInput: true });
      expect(atWrite).toEqual(['ALERT_RINGING', 'WATCHING_DISABLED']);
      expect(router.getAlertStates().get('pty-typed')?.todo).toBe(false);
    } finally {
      disposable.dispose();
    }
  });

  // A remote Client's keystrokes reach the PTY through this window's own
  // Burrow or over the peer link from the broker's, never through a webview:
  // the host acknowledges them itself (docs/specs/alert.md → Engagement).
  it.each(['burrow', 'peer'] as const)('acknowledges a Client\'s input before writing it (%s)', (path) => {
    const deps = path === 'burrow' ? wiring.burrow! : wiring.peer!;
    ptys.callbacks!.onData('pty-remote', REPORT);
    const atWrite: Array<string | undefined> = [];
    ptys.onWrite = (id) => void atWrite.push(status(id));
    // A phone's scroll in tmux reaches the PTY, acknowledging nothing, as the desktop's does.
    deps.writePty('pty-remote', '\x1b[<64;10;5M');
    deps.writePty('pty-remote', 'y');
    expect(atWrite).toEqual(['ALERT_RINGING', 'WATCHING_DISABLED']);
    expect(router.getAlertStates().get('pty-remote')?.todo).toBe(false);
  });

  it('answers a sync with its own Sessions named and both stores, to that webview alone', () => {
    const asking = fakeWebview();
    const other = fakeWebview();
    const first = router.attachRouter(asking.channel);
    const second = router.attachRouter(other.channel);
    try {
      alert(asking, { op: 'initializeWatchedCommands', names: ['make'] });
      alert(asking, { op: 'initializeSettings', settings: {} as never });
      asking.send({ type: 'pty:spawn', id: 'pty-mine', options: { cwd: '/repo' } });
      other.send({ type: 'pty:spawn', id: 'pty-theirs', options: { cwd: '/repo' } });
      asking.posted.length = 0;
      other.posted.length = 0;

      alert(asking, { op: 'sync', ids: ['pty-mine', 'pty-theirs'] });
      expect(asking.posted.map((message) => [message.type, (message as { id?: string }).id])).toEqual([
        ['alert:state', 'pty-mine'],
        ['alert:watchedCommands', undefined],
        ['alert:settings', undefined],
      ]);
      expect(other.posted).toEqual([]);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('stops engaging anything once its webview is disposed', () => {
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    alert(webview, { op: 'engagement', state: { present: true, focusId: 'pty-gone' } });
    disposable.dispose();

    ptys.callbacks!.onData('pty-gone', REPORT);
    expect(status('pty-gone')).toBe('ALERT_RINGING');
  });

  it('treats recreated webview content as a new realm', async () => {
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    try {
      webview.send({ type: 'dormouse:init' });
      alert(webview, { op: 'engagement', state: { present: true, focusId: 'pty-init' } });
      alert(webview, { op: 'await', awaitId: 'await-init', id: 'pty-init', until: 'exit', timeoutMs: 600_000 });

      // The content was destroyed and rebuilt; the old one's engagement and
      // parked awaits went with it.
      webview.send({ type: 'dormouse:init' });
      await Promise.resolve();
      expect(webview.posted).toContainEqual(expect.objectContaining({
        type: 'alert:awaitResult', awaitId: 'await-init', outcome: expect.objectContaining({ kind: 'cancelled' }),
      }));
      ptys.callbacks!.onData('pty-init', REPORT);
      expect(status('pty-init')).toBe('ALERT_RINGING');
    } finally {
      disposable.dispose();
    }
  });
});

/**
 * The host decides when a ring is spoken or pushed (docs/specs/alert.md →
 * Alarm settings): speech to the connected webview showing the Session, a push
 * from here, held back while this VS Code window is in use.
 */
describe('alarm delivery', () => {
  const SESSIONS = { 'pty-1': { label: 'pnpm build', overrides: {} } };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('speaks a due alarm only in the connected webview that shows the Session', () => {
    const other = fakeWebview();
    const owner = fakeWebview();
    const first = router.attachRouter(other.channel);
    const second = router.attachRouter(owner.channel);
    try {
      other.send({ type: 'dormouse:init' });
      owner.send({ type: 'dormouse:init' });
      alert(owner, { op: 'initializeSettings', settings: { speakEnabled: true, speakDelayMs: 1_000 } as never });
      owner.send({ type: 'pty:spawn', id: 'pty-1', options: { cwd: '/repo' } });
      ptys.callbacks!.onData('pty-1', REPORT);
      vi.advanceTimersByTime(1_000);
      const episodeId = router.getAlertStates().get('pty-1')!.episode!.id;
      expect(owner.posted.filter((message) => message.type === 'alert:speak'))
        .toEqual([{ type: 'alert:speak', id: 'pty-1', episodeId }]);
      expect(other.posted.filter((message) => message.type === 'alert:speak')).toEqual([]);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('pushes from the host, titled by the label its view published, after the view is gone', () => {
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    alert(webview, { op: 'initializeSettings', settings: { pushEnabled: true, pushDelayMs: 1_000 } as never });
    webview.send({ type: 'pty:spawn', id: 'pty-1', options: { cwd: '/repo' } });
    alert(webview, { op: 'sessions', sessions: SESSIONS });
    // The view goes away; its PTYs live on.
    disposable.dispose();
    ptys.callbacks!.onData('pty-1', REPORT);
    vi.advanceTimersByTime(1_000);
    expect(wiring.pushes).toEqual([['pty-1', 'pnpm build']]);
  });

  it('holds a push back while this VS Code window is focused and active', () => {
    const moveWindow = (state: { focused: boolean; active?: boolean }) =>
      router.reportWindowPresence(state as never);
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    try {
      alert(webview, { op: 'initializeSettings', settings: { pushEnabled: true, pushDelayMs: 1_000 } as never });
      webview.send({ type: 'pty:spawn', id: 'pty-1', options: { cwd: '/repo' } });
      moveWindow({ focused: true, active: true });
      ptys.callbacks!.onData('pty-1', REPORT);
      vi.advanceTimersByTime(1_000);
      expect(wiring.pushes).toEqual([]);

      // Focus alone is not presence: an older VS Code reports no `active`.
      alert(webview, { op: 'dismiss', id: 'pty-1' });
      ptys.callbacks!.onData('pty-1', 'output');
      moveWindow({ focused: true });
      ptys.callbacks!.onData('pty-1', REPORT);
      vi.advanceTimersByTime(1_000);
      expect(wiring.pushes).toEqual([['pty-1', 'terminal']]);
    } finally {
      disposable.dispose();
    }
  });
});

/**
 * A Session's alert state follows its PTY here, whoever asked
 * (docs/specs/alert.md): started over, and seeded, at the spawn; given the
 * resize grace at the resize; removed at the kill.
 */
describe('alert state follows the PTY', () => {
  it('spawns a cold-restored pane with its persisted TODO, and tells its webview', () => {
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    try {
      webview.send({ type: 'dormouse:init' });
      ptys.callbacks!.onData('restored', '\x1b]9;last run\x07');
      webview.send({
        type: 'pty:spawn',
        id: 'restored',
        options: { cwd: '/repo', alert: { status: 'ALERT_RINGING', todo: true, notification: null } },
      });
      // The reminder, never the ring: the previous generation's state is gone.
      expect(router.getAlertStates().get('restored')).toMatchObject({ status: 'WATCHING_DISABLED', todo: true, notification: null });
      expect(webview.posted.filter((message) => message.type === 'alert:state').at(-1)).toMatchObject({ id: 'restored', todo: true });
    } finally {
      disposable.dispose();
    }
  });

  it('opens the resize grace before the PTY resizes', async () => {
    // The router's own instance: `resetModules` gave this test one registry.
    const { AlertManager } = await import('../../lib/src/lib/alert-manager');
    vi.spyOn(AlertManager.prototype, 'onResize').mockImplementation((id) => void ptys.order.push(`grace ${id}`));
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    try {
      webview.send({ type: 'pty:resize', id: 'pty-sized', cols: 100, rows: 30 });
      expect(ptys.order).toEqual(['grace pty-sized', 'resize pty-sized']);
    } finally {
      disposable.dispose();
    }
  });

  it('removes a killed Session\'s alert state', () => {
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    try {
      webview.send({ type: 'pty:spawn', id: 'pty-killed', options: { cwd: '/repo' } });
      ptys.callbacks!.onData('pty-killed', '\x1b]9;needs input\x07');
      webview.send({ type: 'pty:kill', id: 'pty-killed' });
      expect(router.getAlertStates().has('pty-killed')).toBe(false);
      expect(ptys.order).toContain('kill pty-killed');
    } finally {
      disposable.dispose();
    }
  });
});

// An editor panel's disposal kills its PTYs, and the webview that would have
// sent `pty:kill` for them is already gone: the host removes their entries.
it('removes the alert state of the PTYs a closing panel kills', async () => {
  const webview = fakeWebview();
  const disposable = router.attachRouter(webview.channel, { killOnDispose: true });
  webview.send({ type: 'pty:spawn', id: 'panel-pty', options: { cwd: '/repo' } });
  ptys.callbacks!.onData('panel-pty', '\x1b]9;needs input\x07');
  expect(router.getAlertStates().has('panel-pty')).toBe(true);

  disposable.dispose();
  await vi.waitFor(() => expect(ptys.order).toContain('kill panel-pty'));
  expect(router.getAlertStates().has('panel-pty')).toBe(false);
});
