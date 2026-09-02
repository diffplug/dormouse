/**
 * @vitest-environment jsdom
 *
 * The scan path through the whole `App`: the capability gate in front of it,
 * the parse, whether the token is spent on a registration or retired, the
 * two-digit waiting screen, and the connect a successful pairing continues
 * into.
 *
 * `App.test.tsx` covers the screens in isolation and `ScanInvitation.test.tsx`
 * the reader; neither can see the state machine between them, which is what
 * this file drives. The doubles stop at `App`'s own module boundary.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateNoiseKeyPair, toBase64Url, type PairingInvitation } from 'server-lib-common';

import App, { UNSUPPORTED_BROWSER_TITLE } from './App';
import type { ConnectResult, PairingResult } from '../client/pocket-client';
import { SETUP_CODE_DEAD_MESSAGE, SetupTokenInvalidError } from '../client/pocket-client';
import type { KnownHostV1 } from '../client/pocket-db';
import {
  alertText,
  buttonNamed,
  click,
  invitationUrl as sharedInvitationUrl,
  rowFor,
  settle,
} from './app-test-utils';
import { setNativeFieldValue } from '../../lib/dom';

const fake = vi.hoisted(() => ({
  noiseSupported: true as boolean,
  hasPriorUse: false,
  sessionToken: null as string | null,
  setup: vi.fn<(credential: { setupToken: string }, label: string) => Promise<unknown>>(),
  signin: vi.fn<() => Promise<unknown>>(),
  retireSetupToken: vi.fn<(token: string) => Promise<void>>(),
  retirePendingDeletions: vi.fn<() => Promise<void>>(),
  listKnownHosts: vi.fn<() => Promise<KnownHostV1[]>>(),
  listHosts: vi.fn<() => Promise<Array<{ hostId: string; label: string; online: boolean }>>>(),
  pair: vi.fn<
    (
      invitation: PairingInvitation,
      label: string,
      onCode?: (code: string) => void,
    ) => Promise<PairingResult>
  >(),
  connect: vi.fn<(hostId: string) => Promise<ConnectResult>>(),
  forgetHost: vi.fn<(hostId: string) => Promise<void>>(),
}));

// The one shared module that is doubled, and only for its probe: the gate has
// to be driven both ways, and nothing else in `server-lib-common` may change.
vi.mock('server-lib-common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('server-lib-common')>()),
  probeNoiseSupport: () => Promise.resolve(fake.noiseSupported),
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
    get sessionToken() {
      return fake.sessionToken;
    }
    hasPriorUse = () => fake.hasPriorUse;
    registeredPushEndpoint = () => null;
    setOnHostGone = () => undefined;
    close = () => undefined;
    openSocket = async () => undefined;
    setup = (credential: { setupToken: string }, label: string) => fake.setup(credential, label);
    signin = () => fake.signin();
    retireSetupToken = (token: string) => fake.retireSetupToken(token);
    retirePendingDeletions = () => fake.retirePendingDeletions();
    listKnownHosts = () => fake.listKnownHosts();
    listHosts = () => fake.listHosts();
    forgetHost = (hostId: string) => fake.forgetHost(hostId);
    pair = (
      invitation: PairingInvitation,
      label: string,
      onCode?: (code: string) => void,
    ) => fake.pair(invitation, label, onCode);
    connect = (hostId: string) => fake.connect(hostId);
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

vi.mock('../client/webauthn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/webauthn')>()),
  browserWebAuthn: {},
}));
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

/** A record as a successful pairing writes one. */
async function knownHost(hostId: string, label = 'First laptop'): Promise<KnownHostV1> {
  const clientStatic = await generateNoiseKeyPair();
  return {
    hostId,
    accountId: 'owner',
    label,
    hostStaticPublicKey: toBase64Url((await generateNoiseKeyPair()).publicKey),
    clientStaticKeyPair: {
      privateKey: clientStatic.privateKey as CryptoKey,
      publicKeyRaw: toBase64Url(clientStatic.publicKey),
    },
    passkeyCredentialId: 'cred-1',
    passkeyPublicKeyHash: 'hash-1',
    authorization: { state: 'paired', deliveryId: `delivery-${hostId}`, approvedAt: 1 },
  };
}

/** A real pairing URL for the origin this app is served from. */
const invitationUrl = () => sharedInvitationUrl(location.origin);

beforeEach(() => {
  fake.noiseSupported = true;
  fake.hasPriorUse = false;
  fake.sessionToken = null;
  fake.setup.mockReset().mockImplementation(async () => {
    fake.hasPriorUse = true;
    return {};
  });
  fake.signin.mockReset().mockImplementation(async () => {
    fake.sessionToken = 'tok';
    return {};
  });
  fake.retireSetupToken.mockReset().mockResolvedValue(undefined);
  fake.retirePendingDeletions.mockReset().mockResolvedValue(undefined);
  fake.listKnownHosts.mockReset().mockResolvedValue([]);
  fake.listHosts.mockReset().mockResolvedValue([]);
  fake.pair.mockReset();
  fake.connect.mockReset().mockResolvedValue({ ok: true, hostLabel: 'First laptop' });
  fake.forgetHost.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function boot(props: Partial<Parameters<typeof App>[0]> = {}): Promise<void> {
  act(() => {
    root.render(
      <StrictMode>
        <App {...props} />
      </StrictMode>,
    );
  });
  // The capability probe settles before anything is on screen.
  await settle();
}

/** Open the scanner and paste one code into it, as a user without a camera would. */
async function pasteCode(url: string): Promise<void> {
  await click(container, 'Scan a Host QR');
  const input = container.querySelector<HTMLInputElement>('#pocket-paste-code')!;
  act(() => setNativeFieldValue(input, url));
  act(() => {
    container.querySelector('form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

describe('the capability gate', () => {
  /**
   * Runtimes are gated, not degraded: every ceremony needs X25519, so a browser
   * without it gets a fixed upgrade requirement and performs no remote
   * operation at all.
   */
  it('shows a fixed upgrade requirement and asks the Server nothing', async () => {
    fake.noiseSupported = false;

    await boot();

    expect(container.textContent).toContain(UNSUPPORTED_BROWSER_TITLE);
    expect(buttonNamed(container, 'Sign in with passkey')).toBeNull();
    expect(buttonNamed(container, 'Scan a Host QR')).toBeNull();
    expect(fake.signin).not.toHaveBeenCalled();
    expect(fake.listHosts).not.toHaveBeenCalled();
  });

  it('lets a capable runtime through to the auth screen', async () => {
    await boot();

    expect(container.textContent).not.toContain(UNSUPPORTED_BROWSER_TITLE);
    expect(buttonNamed(container, 'Scan a Host QR')).not.toBeNull();
  });
});

describe('a first run, from the scan to the terminal', () => {
  it('registers with the scanned token, pairs, shows the code, and connects', async () => {
    const { url, invitation } = await invitationUrl();
    let releasePair!: (result: PairingResult) => void;
    fake.pair.mockImplementation((_invitation, _label, onCode) => {
      onCode?.('07');
      return new Promise<PairingResult>((resolve) => {
        releasePair = resolve;
      });
    });
    await boot();

    await pasteCode(url);

    // The token created the passkey, so there is nothing left to retire.
    expect(fake.setup).toHaveBeenCalledWith({ setupToken: invitation.setupToken }, DEVICE_LABEL);
    expect(fake.signin).toHaveBeenCalledOnce();
    expect(fake.retireSetupToken).not.toHaveBeenCalled();
    // The invitation reached `pair` as the parser produced it.
    expect(fake.pair.mock.calls[0]![0].inviteId).toBe(invitation.inviteId);

    // The digits are on screen while the outcome is pending.
    expect(container.textContent).toContain('07');
    expect(container.textContent).toContain('Type this code on the computer');

    const record = await knownHost(invitation.hostId);
    releasePair({ ok: true, record });
    await settle();

    expect(fake.connect).toHaveBeenCalledWith(invitation.hostId);
    // Approving on the laptop lands the phone in a terminal, not back on a list.
    expect(buttonNamed(container, '‹ Hosts')).not.toBeNull();
  });

  it('reports a pairing the laptop refused, and lands on the Hosts list', async () => {
    const { url } = await invitationUrl();
    fake.pair.mockResolvedValue({ ok: false, message: 'The pairing was refused on the computer.' });
    await boot();

    await pasteCode(url);

    expect(alertText(container)).toBe('The pairing was refused on the computer.');
    expect(fake.connect).not.toHaveBeenCalled();
    expect(buttonNamed(container, 'Refresh')).not.toBeNull();
  });

  /**
   * `pair` reports denials as a result but *throws* for a Host-static mismatch,
   * a dismissed authenticator prompt, and a lost passkey cache. The two-digit
   * waiting screen renders no error, so a throw that left the user there would
   * hide the one sentence that path exists to deliver.
   */
  it('leaves the waiting screen for a throw, where the message can be read', async () => {
    const { url } = await invitationUrl();
    fake.pair.mockRejectedValue(
      new Error('This computer is presenting a different identity than the one this phone paired with.'),
    );
    await boot();

    await pasteCode(url);

    expect(alertText(container)).toBe(
      'This computer is presenting a different identity than the one this phone paired with.',
    );
    // The Hosts list, not the pairing screen: `Refresh` exists only there.
    expect(buttonNamed(container, 'Refresh')).not.toBeNull();
    expect(buttonNamed(container, 'Cancel')).toBeNull();
  });

  /**
   * The connect that follows an approved pairing runs with the two-digit screen
   * still up, so a Host that refuses it — busy, protocol-rejected — or a
   * dismissed biometric inside `connect` has the same nowhere-to-show problem
   * the pairing half had.
   */
  it('leaves the waiting screen when the connect after a pairing is refused', async () => {
    const { url, invitation } = await invitationUrl();
    fake.pair.mockResolvedValue({ ok: true, record: await knownHost(invitation.hostId) });
    fake.connect.mockResolvedValue({
      ok: false,
      message: 'The computer is already handling as many phones as it can. Try again shortly.',
      pairingRequired: false,
    });
    await boot();

    await pasteCode(url);

    expect(alertText(container)).toBe(
      'The computer is already handling as many phones as it can. Try again shortly.',
    );
    expect(buttonNamed(container, 'Refresh')).not.toBeNull();
  });
});

describe('a phone that is already signed in', () => {
  it('retires the scanned token rather than registering a second passkey', async () => {
    const { url, invitation } = await invitationUrl();
    fake.hasPriorUse = true;
    fake.pair.mockResolvedValue({
      ok: true,
      record: await knownHost(invitation.hostId),
    });
    await boot();

    // Sign in first, as a returning browser does.
    await click(container, 'Sign in with passkey');
    await pasteCode(url);

    expect(fake.setup).not.toHaveBeenCalled();
    expect(fake.retireSetupToken).toHaveBeenCalledWith(invitation.setupToken);
  });

  /**
   * A code the Server refuses is dead: pairing with it would fail at the Host
   * anyway, and the only recovery is a fresh one from the computer.
   */
  it('aborts on a refused retirement and says to scan a new code', async () => {
    const { url } = await invitationUrl();
    fake.hasPriorUse = true;
    fake.retireSetupToken.mockRejectedValue(new SetupTokenInvalidError());
    await boot();

    await click(container, 'Sign in with passkey');
    await pasteCode(url);

    expect(alertText(container)).toBe(SETUP_CODE_DEAD_MESSAGE);
    expect(fake.pair).not.toHaveBeenCalled();
  });

  it('signs in first when the browser holds a passkey but no session', async () => {
    const { url, invitation } = await invitationUrl();
    fake.hasPriorUse = true;
    fake.pair.mockResolvedValue({ ok: true, record: await knownHost(invitation.hostId) });
    await boot();

    await pasteCode(url);

    expect(fake.signin).toHaveBeenCalledOnce();
    expect(fake.setup).not.toHaveBeenCalled();
    expect(fake.retireSetupToken).toHaveBeenCalledWith(invitation.setupToken);
  });
});

describe('the Hosts list', () => {
  it('shows the pinned records, labeled locally, with the Server’s online state', async () => {
    fake.hasPriorUse = true;
    fake.listKnownHosts.mockResolvedValue([
      await knownHost('host-1', 'First laptop'),
      await knownHost('host-2', 'Second laptop'),
    ]);
    fake.listHosts.mockResolvedValue([
      { hostId: 'host-1', label: 'a name the Server holds', online: true },
      // Enrolled, but this phone has no record for it: not a row.
      { hostId: 'host-3', label: 'Someone else’s', online: true },
    ]);
    await boot();

    await click(container, 'Sign in with passkey');

    expect(container.textContent).toContain('First laptop');
    expect(container.textContent).not.toContain('a name the Server holds');
    expect(container.textContent).not.toContain('Someone else’s');
    // No `GET /api/hosts` row means offline, not absent.
    expect(rowFor(container, 'Second laptop').textContent).toContain('Offline');
  });

  /**
   * An authenticated `pairing-required` removes local authorization without
   * discarding the pin, so the row offers *Pair again* — which starts at the
   * scanner, the only place a pairing can start.
   */
  it('turns a pairing-required denial into Pair again', async () => {
    fake.hasPriorUse = true;
    const paired = await knownHost('host-1');
    fake.listKnownHosts.mockResolvedValueOnce([paired]).mockResolvedValue([
      { ...paired, authorization: { state: 'pairing-required' } },
    ]);
    fake.listHosts.mockResolvedValue([{ hostId: 'host-1', label: '', online: true }]);
    fake.connect.mockResolvedValue({
      ok: false,
      message: 'This computer no longer recognizes this phone. Scan a new code to pair again.',
      pairingRequired: true,
    });
    await boot();
    await click(container, 'Sign in with passkey');

    await click(container, 'Connect');

    expect(alertText(container)).toContain('no longer recognizes this phone');
    expect(buttonNamed(container, 'Pair again')).not.toBeNull();
    await click(container, 'Pair again');
    expect(container.querySelector('#pocket-paste-code')).not.toBeNull();
  });

  it('removes a record and re-reads the list', async () => {
    fake.hasPriorUse = true;
    fake.listKnownHosts.mockResolvedValueOnce([await knownHost('host-1')]).mockResolvedValue([]);
    fake.listHosts.mockResolvedValue([{ hostId: 'host-1', label: '', online: true }]);
    await boot();
    await click(container, 'Sign in with passkey');

    await click(container, 'Remove');

    expect(fake.forgetHost).toHaveBeenCalledWith('host-1');
    expect(container.textContent).toContain('No computers paired yet');
  });

  it('retries owed deletions on every visit to the list', async () => {
    fake.hasPriorUse = true;
    await boot();

    await click(container, 'Sign in with passkey');

    expect(fake.retirePendingDeletions).toHaveBeenCalled();
  });
});

describe('leaving the scanner', () => {
  it('returns a signed-out phone to the auth screen', async () => {
    await boot();

    await click(container, 'Scan a Host QR');
    expect(container.querySelector('#pocket-paste-code')).not.toBeNull();

    await click(container, 'Cancel');

    expect(buttonNamed(container, 'Scan a Host QR')).not.toBeNull();
    expect(container.querySelector('#pocket-paste-code')).toBeNull();
  });

  it('returns a signed-in phone to its Hosts list', async () => {
    fake.hasPriorUse = true;
    await boot();
    await click(container, 'Sign in with passkey');

    await click(container, 'Scan a Host QR');
    await click(container, 'Cancel');

    expect(buttonNamed(container, 'Refresh')).not.toBeNull();
  });

  /**
   * Cancelling the wait is not a failure to report at the user: the ceremony
   * they abandoned has nothing left to say to them.
   */
  it('reads the list on the way back, since the scan may have signed in', async () => {
    // `onScanned` signs in and only reads the Hosts list on a path that reaches
    // pairing, so a scan that failed after sign-in has a session and no list.
    // Cancelling into an empty "No computers paired yet" would be a lie.
    const { url } = await invitationUrl();
    fake.setup.mockRejectedValue(new Error('That pairing code has expired.'));
    fake.listKnownHosts.mockResolvedValue([await knownHost('host-1')]);
    fake.listHosts.mockResolvedValue([{ hostId: 'host-1', label: '', online: true }]);
    await boot();
    await click(container, 'Scan a Host QR');
    const input = container.querySelector<HTMLInputElement>('#pocket-paste-code')!;
    act(() => setNativeFieldValue(input, url));
    act(() => {
      container.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    // Setup failed but sign-in did not run; give the phone a session anyway,
    // as a scan that got past setup and failed later would have.
    fake.sessionToken = 'tok';

    await click(container, 'Cancel');

    expect(container.textContent).toContain('First laptop');
    expect(container.textContent).not.toContain('No computers paired yet');
  });

  it('leaves no error behind when the waiting screen is cancelled', async () => {
    const { url } = await invitationUrl();
    let releasePair!: (result: PairingResult) => void;
    fake.pair.mockImplementation((_invitation, _label, onCode) => {
      onCode?.('42');
      return new Promise<PairingResult>((resolve) => {
        releasePair = resolve;
      });
    });
    await boot();
    await pasteCode(url);
    expect(container.textContent).toContain('42');

    await click(container, 'Cancel');
    releasePair({ ok: false, message: 'The computer did not answer.' });
    await settle();

    expect(alertText(container)).toBeNull();
    expect(buttonNamed(container, 'Refresh')).not.toBeNull();
  });
});

it('never opens a camera on a screen that is gone', async () => {
  // The scanner's own teardown is `ScanInvitation.test.tsx`'s; this is the one
  // thing only the app can prove — that leaving the screen unmounts it.
  const stopped: number[] = [];
  const startScan = async (video: HTMLVideoElement) => {
    (video as unknown as { srcObject: unknown }).srcObject = {
      getTracks: () => [{ stop: () => stopped.push(1) }],
    };
    return { stop: () => stopped.push(1) };
  };
  await boot({ startScan });

  await click(container, 'Scan a Host QR');
  await click(container, 'Cancel');

  expect(stopped.length).toBeGreaterThan(0);
});

it('leads with the camera-bootstrap copy when the fragment brought us here', async () => {
  await boot({ arrivedByCamera: true });

  expect(container.textContent).toContain('scan this Host QR in Pocket');
  // Nothing was spent: the run has no token, and no Server call was made.
  expect(fake.setup).not.toHaveBeenCalled();
  expect(fake.retireSetupToken).not.toHaveBeenCalled();
});
