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

beforeEach(async () => {
  vi.resetModules();
  wiring.peer = null;
  wiring.invalidations = 0;
  router = (await import('../src/message-router')) as RouterModule;
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
});
