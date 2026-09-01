/**
 * @vitest-environment jsdom
 *
 * The push flow through the whole `App`, which is where it actually lives: the
 * subscriptions read, the one Enable that registers every paired Host, and what
 * a denied permission leaves behind. `App.test.tsx` covers the presentational
 * pieces and the pure predicate in isolation; neither can see the state machine
 * between them, which is where the bugs here were.
 *
 * The doubles stop at `App`'s own module boundary — its client, its browser
 * push helpers, and the wall it renders — so the phases, effects, and error
 * bookkeeping under test are the real ones.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import type { PushAvailability } from '../client/push-subscribe';
import { HOSTS, alertText, buttonNamed, click, rowFor, settle } from './app-test-utils';

/**
 * Hoisted so the `vi.mock` factories — which run before this file's own
 * bindings are initialized — can close over them.
 */
const fake = vi.hoisted(() => ({
  /** What every availability probe answers; swapped per test, pending promise included. */
  availability: 'ready' as PushAvailability | Promise<PushAvailability>,
  subscribeInBrowser: vi.fn<(key: string, onReplaced: () => void) => Promise<unknown>>(),
  listPushSubscribedHosts: vi.fn<() => Promise<string[]>>(),
  subscribeToPush: vi.fn<(hostId: string, sub: unknown) => Promise<{ hostIds: string[] }>>(),
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
// a case that drives one is driving what ships (see `App.setup.test.tsx`).
vi.mock('../client/pocket-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/pocket-client')>()),
  PocketClient: class {
    socketOpen = true;
    hasPriorUse = () => true;
    isPaired = () => true;
    registeredPushEndpoint = () => null;
    setOnHostGone = () => undefined;
    close = () => undefined;
    openSocket = async () => undefined;
    signin = async () => ({});
    listHosts = async () => HOSTS;
    queryPaired = async () => true;
    connect = async () => ({ allowed: true });
    hello = async () => ({});
    getPushConfig = async () => 'vapid-key';
    listPushSubscribedHosts = () => fake.listPushSubscribedHosts();
    subscribeToPush = (hostId: string, sub: unknown) => fake.subscribeToPush(hostId, sub);
  },
}));

vi.mock('../client/remote-adapter', () => ({
  RemotePtyAdapter: class {
    init = async () => undefined;
    dispose = async () => undefined;
  },
}));

// The device key is the one dependency deliberately failed: `App` swallows that
// failure by design, and nothing under test reads the fingerprint it feeds.
vi.mock('../client/device-key', () => ({
  getOrCreateDeviceKey: () => Promise.reject(new Error('no device key in jsdom')),
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

/** What the fake Server has stored for this device, across a subscribe loop. */
const registered = new Set<string>();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fake.availability = 'ready';
  fake.subscribeInBrowser.mockReset();
  fake.listPushSubscribedHosts.mockReset().mockResolvedValue([]);
  fake.subscribeToPush
    .mockReset()
    .mockImplementation(async (hostId) => ({ hostIds: [...registered.add(hostId)] }));
  registered.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** One Host's row text, for the per-Host `Push on` marker. */
function rowText(label: string): string {
  return rowFor(container, label).textContent ?? '';
}

/** Sign in and land on the Hosts view, which is what runs the push load. */
async function signIn() {
  act(() => {
    root.render(
      <StrictMode>
        <App scanned={null} />
      </StrictMode>,
    );
  });
  await settle();
  await click(container, 'Sign in with passkey');
}

describe('the one Enable on the Hosts view', () => {
  /**
   * The permission prompt and the PushSubscription it mints belong to the whole
   * service-worker scope; only the Server rows are per (Host, device). So the
   * browser is asked once and the rows are filled in behind it — a per-Host
   * button would have made the user tap through the same grant twice.
   */
  it('subscribes the browser once and registers every paired Host', async () => {
    fake.subscribeInBrowser.mockResolvedValue({ endpoint: 'https://push.example/abc' });
    await signIn();

    await click(container, ENABLE);

    expect(fake.subscribeInBrowser).toHaveBeenCalledOnce();
    expect(fake.subscribeToPush.mock.calls.map(([hostId]) => hostId)).toEqual([
      'host-1',
      'host-2',
    ]);
    expect(container.textContent).toContain('Push notifications on.');
    expect(buttonNamed(container, ENABLE)).toBeNull();
  });

  /**
   * Each response is committed as it lands rather than after the loop, so a
   * registration that failed on the second Host does not throw away the first.
   */
  it('keeps what a partly-failed loop already registered', async () => {
    fake.subscribeInBrowser.mockResolvedValue({ endpoint: 'https://push.example/abc' });
    fake.subscribeToPush.mockImplementation(async (hostId) => {
      if (hostId === 'host-2') throw new Error('The host disconnected.');
      return { hostIds: [...registered.add(hostId)] };
    });
    await signIn();

    await click(container, ENABLE);

    expect(alertText(container)).toBe('The host disconnected.');
    // The first Host is on, so the card stays up for the second alone.
    expect(rowText('First laptop')).toContain('Push on');
    expect(rowText('Second laptop')).not.toContain('Push on');
    expect(buttonNamed(container, ENABLE)).not.toBeNull();
  });

  /**
   * The read is the only thing that says which Hosts hold a row. A read that
   * threw learned nothing — and empty is not nothing — so the card re-offers
   * its idempotent Enable rather than claiming push is on.
   */
  it('offers Enable after a subscriptions read that failed', async () => {
    fake.listPushSubscribedHosts.mockRejectedValue(new Error('offline'));
    await signIn();

    expect(buttonNamed(container, ENABLE)).not.toBeNull();
    expect(container.textContent).not.toContain('Push notifications on.');
  });
});

describe('a permission the user denies', () => {
  /**
   * Availability is otherwise probed only on entering Hosts, so the card sat
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
   * device's whole Host set, so the only question is which is newer. The
   * registration takes the load's run token, dropping every one of its
   * continuations at once rather than each carrying its own guard.
   */
  it('supersedes a subscriptions read still in flight', async () => {
    let answerRead!: (hostIds: string[]) => void;
    fake.listPushSubscribedHosts.mockReturnValue(
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
