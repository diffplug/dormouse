/**
 * The in-window fan-out: one question to every webview of this window, settled
 * as soon as they have all answered. The cross-window tier is `peer-link`'s; the
 * Host service that asks is `remote-host`'s. Both are stubbed here so what is
 * left is the accounting — who has answered, and what a late or duplicate answer
 * does to a snapshot that was already handed to the phone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionMessage, WebviewMessage } from '../src/message-types';
import type { PeerLinkDeps } from '../src/peer-link';
import type { WebviewChannel } from '../src/webview-messaging';

/** What `message-router.ts` hands the two modules it configures at load. */
const wiring = vi.hoisted(() => ({
  peer: null as PeerLinkDeps | null,
  /** Every `notifyDirectoryChanged()` the router made. */
  invalidations: 0,
}));

vi.mock('../src/peer-link', () => ({
  configurePeerLink: (deps: PeerLinkDeps) => {
    wiring.peer = deps;
  },
  remoteNotifyPeerChange: () => {},
}));

/** The pty host, as far as a disposal is concerned: what it was asked, what it
 *  answered, and the order the archive write and the kills happened in. */
const ptys = vi.hoisted(() => ({
  cwd: null as string | null,
  cwdAsked: [] as string[],
  /** `'write'` and `'kill <id>'`, in the order they happened. */
  order: [] as string[],
}));

vi.mock('../src/pty-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/pty-manager')>()),
  spawn: () => {},
  getCwd: async (id: string) => {
    ptys.cwdAsked.push(id);
    return ptys.cwd;
  },
  kill: (id: string) => {
    ptys.order.push(`kill ${id}`);
  },
}));

vi.mock('../src/remote-host', () => ({
  configureRemoteHost: () => {},
  deliverCommandResult: () => {},
  deliverUiEvent: () => {},
  dropForwardedCommands: () => {},
  greetPeerWindow: () => {},
  handleForwardedCommand: () => {},
  handleRemoteHostCommand: () => {},
  notifyDirectoryChanged: () => {
    wiring.invalidations += 1;
  },
}));

type RouterModule = typeof import('../src/message-router');
type MirrorModule = typeof import('../src/notepad-volatile');

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
let mirror: MirrorModule;

beforeEach(async () => {
  vi.resetModules();
  wiring.peer = null;
  wiring.invalidations = 0;
  ptys.cwd = null;
  ptys.cwdAsked = [];
  ptys.order = [];
  router = (await import('../src/message-router')) as RouterModule;
  // The same instance the router holds — `resetModules` gave this test its own
  // extension host, and both imports land in that one registry.
  mirror = (await import('../src/notepad-volatile')) as MirrorModule;
});

afterEach(() => {
  vi.clearAllMocks();
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
    // The budget expired and the Host already rendered a snapshot without this
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
 * The notepad archive lives in `globalState`, which only the extension host can
 * reach (docs/specs/notepad.md). What this side owns is the request/response
 * plumbing and the disposal rule: an editor panel closing archives its mirrored
 * notes, the bottom-panel view's disposal does not — its PTYs stay alive.
 */
describe('notepad archive requests', () => {
  function fakeContext() {
    const store = new Map<string, unknown>();
    const context = {
      globalState: {
        get: (key: string) => store.get(key),
        update: async (key: string, value: unknown) => {
          ptys.order.push('write');
          if (value === undefined) store.delete(key);
          else store.set(key, value);
        },
      },
    };
    return { context: context as never, store };
  }

  /** Every archive reply this webview was sent, in order. */
  function results(webview: ReturnType<typeof fakeWebview>) {
    return webview.posted
      .filter((message) => message.type === 'notepad:result')
      .map((message) => message as { requestId: string; ok: boolean; result?: unknown; error?: string });
  }

  const mirrored = {
    surfaceId: 'pane-1',
    surfaceTitle: 'zsh',
    surfaceKind: 'terminal',
    cwd: null,
    notes: [{ id: 'n1', createdAt: 1, content: { kind: 'plain', text: 'remember this' } }],
  };

  it('round-trips a save and a load through globalState', async () => {
    const webview = fakeWebview();
    const { context } = fakeContext();
    const disposable = router.attachRouter(webview.channel, { context });
    try {
      webview.send({ type: 'notepad:load', requestId: 'np-1' } as never);
      await vi.waitFor(() => expect(results(webview)).toHaveLength(1));
      // Nothing archived yet, and `null` is the base revision that says so.
      expect(results(webview)[0]).toEqual({ type: 'notepad:result', requestId: 'np-1', ok: true, result: null });

      const state = JSON.stringify({ version: 1, batches: [] });
      webview.send({ type: 'notepad:save', requestId: 'np-2', state, baseRevision: null } as never);
      await vi.waitFor(() => expect(results(webview)).toHaveLength(2));
      expect(results(webview)[1]).toMatchObject({ requestId: 'np-2', ok: true, result: 'ok' });

      webview.send({ type: 'notepad:load', requestId: 'np-3' } as never);
      await vi.waitFor(() => expect(results(webview)).toHaveLength(3));
      expect(results(webview)[2].result).toMatchObject({ raw: state });
    } finally {
      disposable.dispose();
    }
  });

  it('answers a failed archive write rather than leaving the webview waiting', async () => {
    // The port has no deadline of its own, and an archive that cannot be written
    // has to become the closure error path, never a Surface that never closes.
    const webview = fakeWebview();
    const context = {
      globalState: {
        get: () => { throw new Error('globalState is gone'); },
        update: async () => {},
      },
    } as never;
    const disposable = router.attachRouter(webview.channel, { context });
    try {
      webview.send({ type: 'notepad:load', requestId: 'np-1' } as never);
      await vi.waitFor(() => expect(results(webview)).toHaveLength(1));
      expect(results(webview)[0]).toMatchObject({ ok: false, error: 'globalState is gone' });
    } finally {
      disposable.dispose();
    }
  });

  it('archives an editor panel\'s mirrored notes when its router is killed on dispose', async () => {
    const webview = fakeWebview();
    const { context, store } = fakeContext();
    const disposable = router.attachRouter(webview.channel, { context, killOnDispose: true });

    webview.send({ type: 'notepad:volatile', snapshot: { surfaces: [mirrored], stagedDeletions: {} } } as never);
    // Closing the tab is a deliberate ending, and the webview is already gone —
    // so nothing but the host can archive what it was holding.
    disposable.dispose();

    await vi.waitFor(() => expect(store.get('dormouse.notepadArchive.v1')).toBeDefined());
    const archive = JSON.parse(store.get('dormouse.notepadArchive.v1') as string);
    expect(archive.batches).toHaveLength(1);
    expect(archive.batches[0]).toMatchObject({ surfaceTitle: 'zsh', notes: [{ id: 'n1' }] });
  });

  it('refreshes the mirrored cwd from the live PTY, then kills it', async () => {
    // The mirror holds whatever the webview last reported, which for a shell
    // with no CWD escapes is nothing — but the PTY is alive right up to here.
    const webview = fakeWebview();
    const { context, store } = fakeContext();
    const disposable = router.attachRouter(webview.channel, { context, killOnDispose: true });
    ptys.cwd = '/Users/me/project';

    webview.send({ type: 'pty:spawn', id: 'pty-1', options: { cwd: '/tmp' } } as never);
    webview.send({
      type: 'notepad:volatile',
      snapshot: { surfaces: [{ ...mirrored, terminalId: 'pty-1' }], stagedDeletions: {} },
    } as never);
    disposable.dispose();

    await vi.waitFor(() => expect(store.get('dormouse.notepadArchive.v1')).toBeDefined());
    const archive = JSON.parse(store.get('dormouse.notepadArchive.v1') as string);
    expect(archive.batches[0].cwd).toMatchObject({ path: '/Users/me/project', source: 'process' });
    expect(ptys.cwdAsked).toEqual(['pty-1']);
    // The kill waits for the write: a dead PTY could not have answered.
    await vi.waitFor(() => expect(ptys.order).toEqual(['write', 'kill pty-1']));
  });

  it('kills the PTYs even when the archive write fails', async () => {
    const webview = fakeWebview();
    const context = {
      globalState: {
        get: () => { throw new Error('globalState is gone'); },
        update: async () => {},
      },
    } as never;
    const disposable = router.attachRouter(webview.channel, { context, killOnDispose: true });

    webview.send({ type: 'pty:spawn', id: 'pty-1', options: { cwd: '/tmp' } } as never);
    webview.send({
      type: 'notepad:volatile',
      snapshot: { surfaces: [{ ...mirrored, terminalId: 'pty-1' }], stagedDeletions: {} },
    } as never);
    disposable.dispose();

    await vi.waitFor(() => expect(ptys.order).toEqual(['kill pty-1']));
  });

  it('keeps the mirror when the bottom-panel view is disposed, so the next resolve hydrates it', async () => {
    const webview = fakeWebview();
    const { context, store } = fakeContext();
    // No `killOnDispose`: the `WebviewView`'s disposal leaves its PTYs alive, so
    // it is not a closure and the notes are not archived.
    const disposable = router.attachRouter(webview.channel, { context });

    webview.send({ type: 'notepad:volatile', snapshot: { surfaces: [mirrored], stagedDeletions: {} } } as never);
    disposable.dispose();
    await Promise.resolve();

    expect(store.get('dormouse.notepadArchive.v1')).toBeUndefined();
    expect(mirror.snapshotForLiveResume(['pane-1'])?.surfaces).toEqual([mirrored]);
  });

  it('commits staged archive deletions on a disposal that is not a closure', async () => {
    // A `WebviewView` moved between containers is disposed and re-resolved. Left
    // staged, the deletions would show as still pending in the new view — with
    // an Undo — and then be committed hours later by `deactivate()`. The Archive
    // view promised they were irreversible once this window closed.
    const webview = fakeWebview();
    const { context, store } = fakeContext();
    store.set('dormouse.notepadArchive.v1', JSON.stringify({
      version: 1,
      batches: [
        { id: 'b1', closedAt: 1, surfaceTitle: 'zsh', surfaceKind: 'terminal', cwd: null, notes: [{ id: 'n1', createdAt: 1, content: { kind: 'plain', text: 'gone' } }] },
        { id: 'b2', closedAt: 2, surfaceTitle: 'zsh', surfaceKind: 'terminal', cwd: null, notes: [{ id: 'n2', createdAt: 2, content: { kind: 'plain', text: 'kept' } }] },
      ],
    }));
    const disposable = router.attachRouter(webview.channel, { context });

    webview.send({
      type: 'notepad:volatile',
      snapshot: { surfaces: [mirrored], stagedDeletions: { deleteBatchIds: ['b1'], deleteNotes: [] } },
    } as never);
    disposable.dispose();

    await vi.waitFor(() => {
      const archive = JSON.parse(store.get('dormouse.notepadArchive.v1') as string);
      expect(archive.batches.map((b: { id: string }) => b.id)).toEqual(['b2']);
    });
    // The notes are not a closure, so they stay — and nothing is left pending.
    const resumed = mirror.snapshotForLiveResume(['pane-1']);
    expect(resumed?.surfaces).toEqual([mirrored]);
    expect(resumed?.stagedDeletions).toEqual({ deleteBatchIds: [], deleteNotes: [] });
  });
});

/**
 * `dor await` parks in the shared alert manager, which lives here rather than in
 * the webview (docs/specs/alert.md → Await). What this side owns is the
 * requestId bookkeeping: one outcome message per request, and nothing left
 * holding a completion claim when the webview goes away.
 */
describe('await requests', () => {
  /** Every await outcome this webview was sent, in order. */
  function outcomes(webview: ReturnType<typeof fakeWebview>) {
    return webview.posted
      .filter((message) => message.type === 'alert:awaitResult')
      .map((message) => message as { requestId: string; outcome: unknown });
  }

  it('answers a cancelled await once, with the host outcome', async () => {
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    try {
      webview.send({ type: 'alert:await', requestId: 'await-1', id: 'pty-1', until: 'quiet', timeoutMs: 600_000 });
      expect(outcomes(webview)).toEqual([]);

      webview.send({ type: 'alert:awaitCancel', requestId: 'await-1' });
      await Promise.resolve();

      // Real timers here, so `waitedMs` is whatever the clock says; the
      // measurement itself is the alert manager's own test.
      expect(outcomes(webview)).toHaveLength(1);
      expect(outcomes(webview)[0]).toMatchObject({
        requestId: 'await-1',
        outcome: { kind: 'cancelled' },
      });

      // The request is gone, so a repeat cancel finds nothing to answer twice.
      webview.send({ type: 'alert:awaitCancel', requestId: 'await-1' });
      await Promise.resolve();
      expect(outcomes(webview)).toHaveLength(1);
    } finally {
      disposable.dispose();
    }
  });

  it('cancels what is still parked when the webview goes away', async () => {
    const webview = fakeWebview();
    const disposable = router.attachRouter(webview.channel);
    webview.send({ type: 'alert:await', requestId: 'await-2', id: 'pty-2', until: 'exit', timeoutMs: 600_000 });
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
    webview.send({ type: 'alert:await', requestId: 'await-3', id: 'pty-3', until: 'quiet', timeoutMs: 600_000 });

    // `handle.cancel()`'s outcome lands a microtask later, after the router has
    // stopped posting — so dispose answers synchronously instead. Without that
    // the webview's promise never settles and the `dor` client blocks to its
    // own deadline (docs/specs/alert.md → Await).
    disposable.dispose();
    await Promise.resolve();

    expect(outcomes(webview)).toHaveLength(1);
    expect(outcomes(webview)[0]).toMatchObject({
      requestId: 'await-3',
      outcome: { kind: 'cancelled' },
    });
  });
});
