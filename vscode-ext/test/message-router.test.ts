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
