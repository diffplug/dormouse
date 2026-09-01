/**
 * @vitest-environment jsdom
 *
 * The QR path through the whole `App`: a scanned code sets the phone up without
 * a password, its nonce rides every pairing for the rest of the run, and a code
 * the Server refuses hands the screen back to the setup password without
 * folding it away.
 *
 * `App.test.tsx` covers the auth screen's two layouts in isolation and
 * `setup-link.test.ts` the hash it is handed; neither can see the state machine
 * between them, which is what this file drives. The doubles stop at `App`'s own
 * module boundary, as in `App.push.test.tsx`.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupCredential } from 'server-lib-common';

import App, { type HostView } from './App';
import {
  SESSION_EXPIRED_MESSAGE,
  SETUP_CODE_DEAD_MESSAGE,
  SessionExpiredError,
  SetupTokenInvalidError,
} from '../client/pocket-client';
import { setNativeFieldValue } from '../../lib/dom';
import { HOSTS, alertText, buttonNamed, click, rowFor, settle } from './app-test-utils';

const SCANNED = { token: 'tok-from-the-qr', nonce: 'nonce-from-the-qr' };

const fake = vi.hoisted(() => ({
  setup: vi.fn<(credential: SetupCredential, label: string) => Promise<unknown>>(),
  signin: vi.fn<() => Promise<unknown>>(),
  listHosts: vi.fn<() => Promise<HostView[]>>(),
  pair: vi.fn<
    (hostId: string, label: string, nonce?: string | null) => Promise<{ approved: boolean }>
  >(),
  /** What `hasPriorUse` answers; the QR path has to lead with setup either way. */
  priorUse: false,
}));

vi.mock('../client/push-subscribe', () => ({
  getPushAvailability: () => Promise.resolve('unsupported'),
  hasCurrentPushSubscription: () => Promise.resolve(false),
  isInstalledWebApp: () => true,
  needsHomeScreenInstall: () => false,
  subscribeToPushInBrowser: () => Promise.reject(new Error('not under test')),
}));

// Only `PocketClient` is doubled: the error classes and their messages are the
// real ones, so a test asserting on what the screen says is asserting on what
// ships rather than on a string this file made up.
vi.mock('../client/pocket-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/pocket-client')>()),
  PocketClient: class {
    socketOpen = true;
    hasPriorUse = () => fake.priorUse;
    isPaired = () => false;
    registeredPushEndpoint = () => null;
    setOnHostGone = () => undefined;
    close = () => undefined;
    openSocket = async () => undefined;
    setup = (credential: SetupCredential, label: string) => fake.setup(credential, label);
    signin = () => fake.signin();
    listHosts = () => fake.listHosts();
    queryPaired = async () => false;
    pair = (hostId: string, label: string, nonce?: string | null) =>
      fake.pair(hostId, label, nonce);
    connect = async () => ({ allowed: true });
    hello = async () => ({});
    getPushConfig = async () => null;
    listPushSubscribedHosts = async () => [];
  },
}));

vi.mock('../client/remote-adapter', () => ({
  RemotePtyAdapter: class {
    init = async () => undefined;
    dispose = async () => undefined;
  },
}));

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

/** The label Pocket suggests from an installed app; see `deviceLabel`. */
const DEVICE_LABEL = 'Dormouse Pocket (Home Screen)';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fake.priorUse = false;
  fake.setup.mockReset().mockResolvedValue({});
  fake.signin.mockReset().mockResolvedValue({});
  fake.listHosts.mockReset().mockResolvedValue(HOSTS);
  fake.pair.mockReset().mockResolvedValue({ approved: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function boot(scanned: { token: string; nonce?: string } | null = SCANNED) {
  act(() => {
    root.render(
      <StrictMode>
        <App scanned={scanned} />
      </StrictMode>,
    );
  });
}

async function pairFrom(label: string) {
  act(() => rowFor(container, label).querySelector('button')!.click());
  await settle();
}

function passwordField(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('#pocket-setup-password');
}

describe('setting up from a scanned code', () => {
  it('registers with the token and signs in, with nothing typed', async () => {
    // The browser has been here before, and the scan still wins: this is the
    // screen the person pointing a camera at their laptop asked for.
    fake.priorUse = true;
    boot();

    expect(passwordField()).toBeNull();
    await click(container, 'Create passkey & sign in');

    expect(fake.setup).toHaveBeenCalledWith({ setupToken: SCANNED.token }, 'My Phone');
    expect(fake.signin).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('First laptop');
  });

  /**
   * Only the Host the code was shown on can spend the nonce, and only on a
   * pairing that verified against it — so pairing some *other* machine first
   * must not throw the proof away. Dropping it there destroyed the ceremony
   * silently: the machine on screen would fall back to a fingerprint compare.
   * A spent proof simply misses, so carrying it costs nothing.
   */
  it('carries the scanned nonce into every pairing this run', async () => {
    boot();
    await click(container, 'Create passkey & sign in');

    // The machine the phone was *not* pointed at, first.
    await pairFrom('First laptop');
    expect(fake.pair).toHaveBeenLastCalledWith('host-1', DEVICE_LABEL, SCANNED.nonce);

    await click(container, '‹ Hosts');
    await pairFrom('Second laptop');
    expect(fake.pair).toHaveBeenLastCalledWith('host-2', DEVICE_LABEL, SCANNED.nonce);
  });

  it('sends no proof when the code carried no nonce', async () => {
    boot({ token: SCANNED.token });
    await click(container, 'Create passkey & sign in');

    await pairFrom('First laptop');

    expect(fake.pair).toHaveBeenLastCalledWith('host-1', DEVICE_LABEL, null);
  });

  /**
   * The half-finished setup: the passkey registered, and the sign-in behind it
   * was cancelled. Its retry has to be sign-in — the registration spent the
   * code Server-side, so re-offering it would only earn a 401.
   */
  it('does not re-offer a code the registration already spent', async () => {
    fake.setup.mockImplementation(async () => {
      fake.priorUse = true;
      return {};
    });
    fake.signin.mockRejectedValueOnce(new Error('passkey prompt cancelled'));
    boot();

    await click(container, 'Create passkey & sign in');

    expect(container.textContent).toContain('Welcome back');
    expect(alertText(container)).toContain('cancelled');
  });

  it('takes the ordinary password path when no code was scanned', async () => {
    boot(null);

    expect(passwordField()).not.toBeNull();
    expect(fake.setup).not.toHaveBeenCalled();
  });

  /**
   * The other way out of setup. The token's whole job is to create the first
   * passkey, so a run that reached one through sign-in instead has spent it —
   * and a session that dies later must land on the ordinary "Welcome back",
   * not on a screen offering a second passkey registration.
   */
  it('drops the code when the run signs in rather than setting up', async () => {
    boot();
    fake.signin.mockImplementation(async () => {
      fake.priorUse = true;
      return {};
    });

    await click(container, 'Sign in with passkey');
    expect(container.textContent).toContain('First laptop');

    fake.listHosts.mockRejectedValueOnce(new SessionExpiredError());
    await click(container, 'Refresh');

    expect(alertText(container)).toBe(SESSION_EXPIRED_MESSAGE);
    expect(container.textContent).toContain('Welcome back');
    expect(passwordField()).toBeNull();
    expect(buttonNamed(container, /First-time setup/)).not.toBeNull();
  });
});

describe('a code the server refuses', () => {
  /**
   * Expired, spent, or minted by a since-revoked Host — all one answer to the
   * person holding the phone, and all recoverable without a re-scan: the setup
   * password still works, and so does a synced passkey.
   */
  it('says so and hands back the password field', async () => {
    fake.setup.mockRejectedValue(new SetupTokenInvalidError());
    boot();
    expect(passwordField()).toBeNull();

    await click(container, 'Create passkey & sign in');

    expect(alertText(container)).toBe(SETUP_CODE_DEAD_MESSAGE);
    expect(passwordField()).not.toBeNull();
    expect(fake.signin).not.toHaveBeenCalled();
  });

  /**
   * The returning browser is the case that broke: dropping the token there
   * collapsed `leadWithSetup` to `firstRun`, so the password field the refusal
   * had just promised folded behind the disclosure — and the remount that came
   * with it threw away whatever label had been typed.
   */
  it('keeps the field unfolded, and the typed label, on a browser that has been here', async () => {
    fake.priorUse = true;
    fake.setup.mockRejectedValueOnce(new SetupTokenInvalidError());
    boot();
    act(() =>
      setNativeFieldValue(
        container.querySelector<HTMLInputElement>('#pocket-setup-label')!,
        'Work phone',
      ),
    );

    await click(container, 'Create passkey & sign in');

    expect(alertText(container)).toBe(SETUP_CODE_DEAD_MESSAGE);
    expect(passwordField()).not.toBeNull();
    expect(buttonNamed(container, /First-time setup/)).toBeNull();
    expect(container.querySelector<HTMLInputElement>('#pocket-setup-label')!.value).toBe(
      'Work phone',
    );

    // And the retry carries that label, with the password now typed.
    act(() => setNativeFieldValue(passwordField()!, 'hunter2'));
    await click(container, 'Create passkey & sign in');
    expect(fake.setup).toHaveBeenLastCalledWith({ password: 'hunter2' }, 'Work phone');
  });

  it('leaves the retry an ordinary password setup', async () => {
    fake.setup.mockRejectedValueOnce(new SetupTokenInvalidError());
    boot();
    await click(container, 'Create passkey & sign in');

    act(() => setNativeFieldValue(passwordField()!, 'hunter2'));
    await click(container, 'Create passkey & sign in');

    expect(fake.setup).toHaveBeenLastCalledWith({ password: 'hunter2' }, 'My Phone');
  });

  /**
   * A rejected token is not a rejected session: the recovery is "type the
   * password", so the nonce that came with it is still the one this laptop
   * displayed and still worth proving at pairing.
   */
  it('keeps the scanned nonce for pairing', async () => {
    fake.setup.mockRejectedValueOnce(new SetupTokenInvalidError());
    boot();
    await click(container, 'Create passkey & sign in');
    fake.setup.mockResolvedValue({});
    await click(container, 'Sign in with passkey');

    await pairFrom('First laptop');

    expect(fake.pair).toHaveBeenLastCalledWith('host-1', DEVICE_LABEL, SCANNED.nonce);
  });
});

describe('a session that expires before the pairing', () => {
  /**
   * The expiry recovery tears the session down and drops to sign-in, which is
   * the one path back through `auth` that must *not* look like a fresh visit:
   * the nonce is this run's, not the session's, so the pairing after the
   * re-sign-in is still the one the laptop displayed a code for.
   */
  it('keeps the scanned nonce across the drop back to sign-in', async () => {
    boot();
    await click(container, 'Create passkey & sign in');
    expect(container.textContent).toContain('First laptop');

    fake.listHosts.mockRejectedValueOnce(new SessionExpiredError());
    await click(container, 'Refresh');
    expect(alertText(container)).toBe(SESSION_EXPIRED_MESSAGE);
    expect(buttonNamed(container, 'Refresh')).toBeNull();

    await click(container, 'Sign in with passkey');
    await pairFrom('First laptop');

    expect(fake.pair).toHaveBeenLastCalledWith('host-1', DEVICE_LABEL, SCANNED.nonce);
  });
});
