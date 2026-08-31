/**
 * @vitest-environment jsdom
 *
 * The push flow through the whole `App`, which is where it actually lives: the
 * tri-state subscriptions read, the wall's banner, and what a failure leaves
 * behind on the way back to the Hosts view. `App.test.tsx` covers the
 * presentational pieces and the pure predicates in isolation; none of them can
 * see the state machine between them, which is where the bugs here were.
 *
 * The doubles stop at `App`'s own module boundary — its client, its browser
 * push helpers, and the wall it renders — so the phases, effects, and error
 * bookkeeping under test are the real ones.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App, { type HostView } from './App';
import type { PushAvailability } from '../client/push-subscribe';

const HOSTS: HostView[] = [{ hostId: 'host-1', label: 'First laptop', online: true }];

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

vi.mock('../client/pocket-client', () => ({
  SessionExpiredError: class SessionExpiredError extends Error {},
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fake.availability = 'ready';
  fake.subscribeInBrowser.mockReset();
  fake.listPushSubscribedHosts.mockReset().mockResolvedValue([]);
  fake.subscribeToPush.mockReset().mockResolvedValue({ hostIds: ['host-1'] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Let every pending promise chain land and React commit what they produced. */
async function settle() {
  for (let pass = 0; pass < 3; pass++) {
    await act(async () => {
      for (let tick = 0; tick < 12; tick++) await Promise.resolve();
    });
  }
}

function buttonNamed(label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === label) ?? null;
}

function alertText(): string | null {
  return container.querySelector('[role="alert"]')?.textContent ?? null;
}

async function click(label: string) {
  act(() => buttonNamed(label)!.click());
  await settle();
}

/** Sign in and land on the Hosts view, which is what runs the push load. */
async function signIn() {
  act(() => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
  await settle();
  await click('Sign in with passkey');
}

/** Sign in, then connect to the one Host — the moment the banner is decided. */
async function connectToWall() {
  await signIn();
  await click('Connect');
  // The wall really is on screen, so a missing Enable below means the banner
  // stood down rather than the navigation having failed.
  expect(buttonNamed('‹ Hosts')).not.toBeNull();
}

describe('the subscriptions read the wall banner waits on', () => {
  /**
   * The tri-state's whole reason to exist: an answered "off" is the only thing
   * that may put a full-width banner over someone's terminal, and a read that
   * threw answered nothing. Settling it at empty showed the banner to people
   * who were already subscribed — the case the third state exists to prevent.
   */
  it('leaves the banner down when the read failed', async () => {
    fake.listPushSubscribedHosts.mockRejectedValue(new Error('offline'));
    await connectToWall();

    expect(buttonNamed(ENABLE)).toBeNull();
  });

  it('raises the banner when the read answered, and answered empty', async () => {
    fake.listPushSubscribedHosts.mockResolvedValue([]);
    await connectToWall();

    expect(buttonNamed(ENABLE)).not.toBeNull();
  });

  /**
   * The other half of the tri-state, and why staying unknown costs nothing:
   * the row's Enable is idempotent, so it re-offers rather than waits.
   */
  it('still offers the idempotent Enable on the Host row after a failed read', async () => {
    fake.listPushSubscribedHosts.mockRejectedValue(new Error('offline'));
    await signIn();

    expect(buttonNamed(ENABLE)).not.toBeNull();
  });
});

describe('a push failure raised from the wall banner', () => {
  async function failAnEnable() {
    fake.subscribeInBrowser.mockRejectedValue(new Error('Notifications are blocked.'));
    await connectToWall();
    await click(ENABLE);
    expect(alertText()).toBe('Notifications are blocked.');
  }

  /**
   * The error state is keyed by operation, but `HostsView` owns its whole
   * viewport and reports whatever it holds — so a failure the user had already
   * put away reappeared, context-free, over the host list. Both exits from the
   * banner clear it.
   */
  it('does not follow the user to the Hosts view after Not now', async () => {
    await failAnEnable();

    await click('Not now');
    await click('‹ Hosts');

    expect(container.textContent).not.toContain('Notifications are blocked.');
  });

  it('does not follow the user to the Hosts view when the wall is simply left', async () => {
    await failAnEnable();

    await click('‹ Hosts');

    expect(container.textContent).not.toContain('Notifications are blocked.');
  });
});

describe('a permission the user denies at the banner', () => {
  /**
   * Availability is otherwise probed only on entering Hosts, so the banner sat
   * there offering an Enable that could do nothing but throw again. The probe
   * is fired after the error is raised rather than instead of it — hence the
   * deferred answer here, which pins that the failure gets its showing first.
   */
  it('shows the failure, then stands the banner down and blocks the row', async () => {
    fake.subscribeInBrowser.mockRejectedValue(new Error('Notifications are blocked.'));
    await connectToWall();

    let denyProbe!: (state: PushAvailability) => void;
    fake.availability = new Promise<PushAvailability>((resolve) => {
      denyProbe = resolve;
    });

    await click(ENABLE);
    // Still up, still explaining itself, while the re-probe is outstanding.
    expect(alertText()).toBe('Notifications are blocked.');
    expect(buttonNamed('Not now')).not.toBeNull();

    fake.availability = 'denied';
    denyProbe('denied');
    await settle();

    expect(buttonNamed(ENABLE)).toBeNull();
    expect(buttonNamed('Not now')).toBeNull();

    // And the two surfaces agree: the row that would have offered Enable names
    // the reason instead.
    await click('‹ Hosts');

    expect(buttonNamed(ENABLE)).toBeNull();
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

    await click(ENABLE);
    expect(container.textContent).toContain('Push notifications on.');

    // The read finally lands, saying this device is registered nowhere. It was
    // overtaken, so it must not undo the registration that just completed.
    answerRead([]);
    await settle();

    expect(container.textContent).toContain('Push notifications on.');
  });
});
