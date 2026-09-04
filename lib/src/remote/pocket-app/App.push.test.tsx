/**
 * @vitest-environment jsdom
 *
 * The push flow through the whole `App`, which is where it actually lives: the
 * possession-based readback, the one Enable that registers every paired Burrow,
 * the owed deletions that retry in front of it, and what a denied permission
 * leaves behind. `App.test.tsx` covers the presentational pieces and the pure
 * predicate in isolation; neither can see the state machine between them, which
 * is where the bugs here were.
 *
 * The doubles stop at `App`'s own module boundary — its client, its browser
 * push helpers, and the wall it renders — so the phases, effects, and error
 * bookkeeping under test are the real ones.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from 'remote-lib-common';

import App from './App';
import type { KnownBurrowV1 } from '../client/pocket-db';
import type { PushAvailability } from '../client/push-subscribe';
import { alertText, buttonNamed, click, rowFor, settle } from './app-test-utils';

/**
 * Hoisted so the `vi.mock` factories — which run before this file's own
 * bindings are initialized — can close over them.
 */
const fake = vi.hoisted(() => ({
  /** What every availability probe answers; swapped per test, pending promise included. */
  availability: 'ready' as PushAvailability | Promise<PushAvailability>,
  subscribeInBrowser: vi.fn<(key: string, onReplaced: () => void) => Promise<unknown>>(),
  listPushSubscribedBurrows: vi.fn<() => Promise<string[]>>(),
  subscribeToPush: vi.fn<(burrowId: string, sub: unknown) => Promise<{ burrowIds: string[] }>>(),
  retirePendingDeletions: vi.fn<() => Promise<void>>(),
  /** Every client call, in order, so "before" can be asserted rather than assumed. */
  order: [] as string[],
}));

vi.mock('remote-lib-common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('remote-lib-common')>()),
  probeNoiseSupport: () => Promise.resolve(true),
}));

vi.mock('../client/push-subscribe', () => ({
  getPushAvailability: () => Promise.resolve(fake.availability),
  hasCurrentPushSubscription: () => Promise.resolve(false),
  isInstalledWebApp: () => true,
  needsHomeScreenInstall: () => false,
  subscribeToPushInBrowser: (key: string, onReplaced: () => void) =>
    fake.subscribeInBrowser(key, onReplaced),
}));

// Only `PocketClient` is doubled — the error classes stay the real exports, so
// a case that drives one is driving what ships (see `App.scan.test.tsx`).
vi.mock('../client/pocket-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/pocket-client')>()),
  PocketClient: class {
    socketOpen = true;
    sessionToken: string | null = 'tok';
    hasPriorUse = () => true;
    registeredPushEndpoint = () => null;
    setOnBurrowGone = () => undefined;
    close = () => undefined;
    openSocket = async () => undefined;
    signin = async () => ({});
    listKnownBurrows = async () => KNOWN;
    listBurrows = async () => KNOWN.map((record) => ({
      burrowId: record.burrowId,
      label: record.label,
      online: true,
    }));
    retirePendingDeletions = () => {
      fake.order.push('retire');
      return fake.retirePendingDeletions();
    };
    connect = async () => ({ ok: true, burrowLabel: 'First laptop' });
    hello = async () => ({});
    getPushConfig = async () => 'vapid-key';
    listPushSubscribedBurrows = () => fake.listPushSubscribedBurrows();
    subscribeToPush = (burrowId: string, sub: unknown) => {
      fake.order.push(`subscribe:${burrowId}`);
      return fake.subscribeToPush(burrowId, sub);
    };
  },
}));

vi.mock('../client/remote-adapter', () => ({
  RemotePtyAdapter: class {
    init = async () => undefined;
    dispose = async () => undefined;
  },
}));

vi.mock('../client/webauthn', () => ({ browserWebAuthn: {} }));
vi.mock('./PocketWall', () => ({ PocketWall: () => null }));
vi.mock('../../lib/platform', () => ({ setPlatform: () => undefined }));
vi.mock('../../lib/terminal-registry', () => ({
  disposeAllSessions: () => undefined,
  initAlertStateReceiver: () => undefined,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ENABLE = 'Enable push notifications';

/** Two paired records; the labels are what the rows say. */
const KNOWN: KnownBurrowV1[] = ['burrow-1', 'burrow-2'].map((burrowId, index) => ({
  burrowId,
  accountId: 'owner',
  label: index === 0 ? 'First laptop' : 'Second laptop',
  burrowStaticPublicKey: toBase64Url(Uint8Array.from({ length: 32 }, () => index + 1)),
  clientStaticKeyPair: {
    privateKey: { kind: 'private' } as unknown as CryptoKey,
    publicKeyRaw: toBase64Url(Uint8Array.from({ length: 32 }, () => index + 2)),
  },
  passkeyCredentialId: 'cred-1',
  passkeyPublicKeyHash: 'hash-1',
  authorization: { state: 'paired', deliveryId: `delivery-${burrowId}`, approvedAt: 1 },
}));

/** What the fake Relay has stored for this device, across a subscribe loop. */
const registered = new Set<string>();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fake.availability = 'ready';
  fake.order = [];
  fake.subscribeInBrowser.mockReset();
  fake.retirePendingDeletions.mockReset().mockResolvedValue(undefined);
  fake.listPushSubscribedBurrows.mockReset().mockResolvedValue([]);
  fake.subscribeToPush
    .mockReset()
    .mockImplementation(async (burrowId) => ({ burrowIds: [...registered.add(burrowId)] }));
  registered.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** One Burrow's row text, for the per-Burrow `Push on` marker. */
function rowText(label: string): string {
  return rowFor(container, label).textContent ?? '';
}

/** Sign in and land on the Burrows view, which is what runs the push load. */
async function signIn() {
  act(() => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
  await settle();
  await click(container, 'Sign in with passkey');
}

describe('the one Enable on the Burrows view', () => {
  /**
   * The permission prompt and the PushSubscription it mints belong to the whole
   * service-worker scope; only the Relay rows are per (Burrow, device). So the
   * browser is asked once and the rows are filled in behind it — a per-Burrow
   * button would have made the user tap through the same grant twice.
   */
  it('subscribes the browser once and registers every paired Burrow', async () => {
    fake.subscribeInBrowser.mockResolvedValue({ endpoint: 'https://push.example/abc' });
    await signIn();

    await click(container, ENABLE);

    expect(fake.subscribeInBrowser).toHaveBeenCalledOnce();
    expect(fake.subscribeToPush.mock.calls.map(([burrowId]) => burrowId)).toEqual([
      'burrow-1',
      'burrow-2',
    ]);
    expect(container.textContent).toContain('Push notifications on.');
    expect(buttonNamed(container, ENABLE)).toBeNull();
  });

  /**
   * A replacement registered while a superseded delivery row is still on the
   * Relay would leave that row reachable, so the queue drains first.
   */
  it('retires owed deletions before registering a replacement', async () => {
    fake.subscribeInBrowser.mockResolvedValue({ endpoint: 'https://push.example/abc' });
    await signIn();
    fake.order = [];

    await click(container, ENABLE);

    expect(fake.order[0]).toBe('retire');
    expect(fake.order.slice(1)).toEqual(['subscribe:burrow-1', 'subscribe:burrow-2']);
  });

  /**
   * Each response is committed as it lands rather than after the loop, so a
   * registration that failed on the second Burrow does not throw away the first.
   */
  it('keeps what a partly-failed loop already registered', async () => {
    fake.subscribeInBrowser.mockResolvedValue({ endpoint: 'https://push.example/abc' });
    fake.subscribeToPush.mockImplementation(async (burrowId) => {
      if (burrowId === 'burrow-2') throw new Error('The Relay refused the registration.');
      return { burrowIds: [...registered.add(burrowId)] };
    });
    await signIn();

    await click(container, ENABLE);

    expect(alertText(container)).toBe('The Relay refused the registration.');
    // The first Burrow is on, so the card stays up for the second alone.
    expect(rowText('First laptop')).toContain('Push on');
    expect(rowText('Second laptop')).not.toContain('Push on');
    expect(buttonNamed(container, ENABLE)).not.toBeNull();
  });

  /**
   * The readback is the only thing that says which Burrows hold a row. A read
   * that threw learned nothing — and empty is not nothing — so the card
   * re-offers its idempotent Enable rather than claiming push is on.
   */
  it('offers Enable after a subscriptions read that failed', async () => {
    fake.listPushSubscribedBurrows.mockRejectedValue(new Error('offline'));
    await signIn();

    expect(buttonNamed(container, ENABLE)).not.toBeNull();
    expect(container.textContent).not.toContain('Push notifications on.');
  });

  it('reads the registrations back on entering the list', async () => {
    fake.listPushSubscribedBurrows.mockResolvedValue(['burrow-1', 'burrow-2']);
    await signIn();

    expect(container.textContent).not.toContain('Push notifications on.');
    // Both halves are required: the Relay row *and* a browser subscription
    // that still matches it, which `hasCurrentPushSubscription` denies here.
    expect(buttonNamed(container, ENABLE)).not.toBeNull();
  });
});

describe('a permission the user denies', () => {
  /**
   * Availability is otherwise probed only on entering Burrows, so the card sat
   * there offering an Enable that could do nothing but throw again. The probe
   * is fired after the error is raised rather than instead of it — hence the
   * deferred answer here, which pins that the failure gets its showing first.
   */
  it('shows the failure, then replaces the offer with the reason', async () => {
    fake.subscribeInBrowser.mockRejectedValue(new Error('Notifications are blocked.'));
    await signIn();

    let denyProbe!: (state: PushAvailability) => void;
    fake.availability = new Promise<PushAvailability>((resolve) => {
      denyProbe = resolve;
    });

    await click(container, ENABLE);
    // Still up, still explaining itself, while the re-probe is outstanding.
    expect(alertText(container)).toBe('Notifications are blocked.');
    expect(buttonNamed(container, ENABLE)).not.toBeNull();

    fake.availability = 'denied';
    denyProbe('denied');
    await settle();

    expect(buttonNamed(container, ENABLE)).toBeNull();
    expect(container.textContent).toContain('Notifications are blocked for this site');
  });
});

describe('a completed registration', () => {
  /**
   * Both the subscribe response and the subscriptions read answer with this
   * device's whole Burrow set, so the only question is which is newer. The
   * registration takes the load's run token, dropping every one of its
   * continuations at once rather than each carrying its own guard.
   */
  it('supersedes a subscriptions read still in flight', async () => {
    let answerRead!: (burrowIds: string[]) => void;
    fake.listPushSubscribedBurrows.mockReturnValue(
      new Promise<string[]>((resolve) => {
        answerRead = resolve;
      }),
    );
    fake.subscribeInBrowser.mockResolvedValue({ endpoint: 'https://push.example/abc' });
    await signIn();

    await click(container, ENABLE);
    expect(container.textContent).toContain('Push notifications on.');

    // The read finally lands, saying this device is registered nowhere. It was
    // overtaken, so it must not undo the registration that just completed.
    answerRead([]);
    await settle();

    expect(container.textContent).toContain('Push notifications on.');
  });
});
