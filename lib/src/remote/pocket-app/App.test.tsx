/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CAMERA_BOOTSTRAP_MESSAGE,
  HostsView,
  SCAN_LABEL,
  PairingCodeView,
  SetupOrSignin,
  pushNoticeState,
  type HostView,
  type PushConfigStatus,
} from './App';
import type { PushAvailability } from '../client/push-subscribe';
import { HOSTS, buttonNamed as buttonNamedIn, rowFor as rowForIn } from './app-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderHosts(
  overrides: {
    hosts?: HostView[];
    busy?: string | null;
    isPushSubscribed?: (hostId: string) => boolean;
    pushState?: PushAvailability | null;
    pushConfigStatus?: PushConfigStatus;
    onScan?: () => void;
    onConnect?: (host: HostView) => void;
    onForget?: (host: HostView) => void;
    onEnablePush?: () => void;
    onRetryPushConfig?: () => void;
  } = {},
) {
  act(() => {
    root.render(
      <StrictMode>
        <HostsView
          hosts={overrides.hosts ?? HOSTS}
          busy={overrides.busy ?? null}
          error={null}
          isPushSubscribed={overrides.isPushSubscribed ?? (() => false)}
          // Not `??`: an explicit null is "the browser has not been asked yet",
          // which is one of the states under test.
          pushState={overrides.pushState !== undefined ? overrides.pushState : 'ready'}
          pushConfigStatus={overrides.pushConfigStatus ?? 'ready'}
          onRefresh={() => undefined}
          onScan={overrides.onScan ?? (() => undefined)}
          onConnect={overrides.onConnect ?? (() => undefined)}
          onForget={overrides.onForget ?? (() => undefined)}
          onEnablePush={overrides.onEnablePush ?? (() => undefined)}
          onRetryPushConfig={overrides.onRetryPushConfig ?? (() => undefined)}
        />
      </StrictMode>,
    );
  });
}

/** Two Hosts, the second of which the laptop has forgotten. */
const NEEDS_PAIRING: HostView[] = [
  HOSTS[0]!,
  { ...HOSTS[1]!, needsPairing: true },
];

/**
 * One Host's row, found through that Host's label rather than by document
 * order — the assertions are about which Host owns which state, so they must
 * not silently pass if the rows are reordered.
 */
function rowFor(label: string): HTMLElement {
  return rowForIn(container, label);
}

/** The labels of a row's action buttons, in order. */
function actionsIn(row: HTMLElement): string[] {
  return [...row.querySelectorAll('button')].map((button) => button.textContent ?? '');
}

/**
 * The one push card, found by its title. Both titles are matched, so a card
 * that rendered the wrong one still fails on its body rather than on absence.
 */
function pushCard(): HTMLElement | null {
  return (
    [...container.querySelectorAll<HTMLElement>('div.rounded-lg')].find((el) =>
      /^(Turn on push notifications|Push notifications are off)$/.test(
        el.firstElementChild?.textContent ?? '',
      ),
    ) ?? null
  );
}

function renderAuth(
  overrides: {
    hasPriorUse?: boolean;
    arrivedByCamera?: boolean;
    passkeyAlreadyRegistered?: boolean;
    needsInstall?: boolean;
    busy?: string | null;
    error?: string | null;
    onScan?: () => void;
    onSignin?: () => void;
  } = {},
) {
  act(() => {
    root.render(
      <StrictMode>
        <SetupOrSignin
          busy={overrides.busy ?? null}
          error={overrides.error ?? null}
          hasPriorUse={overrides.hasPriorUse ?? false}
          arrivedByCamera={overrides.arrivedByCamera ?? false}
          passkeyAlreadyRegistered={overrides.passkeyAlreadyRegistered ?? false}
          needsInstall={overrides.needsInstall ?? false}
          onScan={overrides.onScan ?? (() => undefined)}
          onSignin={overrides.onSignin ?? (() => undefined)}
        />
      </StrictMode>,
    );
  });
}

function buttonNamed(label: string | RegExp): HTMLButtonElement | null {
  return buttonNamedIn(container, label);
}

/**
 * The install guidance block, found by its heading. Matched on containment
 * rather than the exact string so a reworded title cannot turn the negative
 * assertions below into vacuous passes.
 */
function installNotice(): HTMLElement | null {
  return (
    [...container.querySelectorAll<HTMLElement>('div')].find((el) =>
      /Home Screen/.test(el.firstElementChild?.textContent ?? ''),
    ) ?? null
  );
}

describe('SetupOrSignin: scanning versus signing in', () => {
  /**
   * There is no setup password and no typed credential left: pointing the
   * phone at the computer is both the account setup and the pairing, so a
   * browser holding nothing has exactly one thing it can do.
   */
  it('leads with the scanner when this browser holds no passkey material', () => {
    const onScan = vi.fn();
    renderAuth({ hasPriorUse: false, onScan });

    expect(container.textContent).toContain('Set up this phone');
    expect(container.textContent).not.toContain('Welcome back');
    expect(container.querySelector('input')).toBeNull();

    act(() => buttonNamed(SCAN_LABEL)!.click());
    expect(onScan).toHaveBeenCalledOnce();
  });

  it('keeps sign-in reachable on a first run, for a passkey that synced here', () => {
    const onSignin = vi.fn();
    renderAuth({ hasPriorUse: false, onSignin });

    act(() => buttonNamed('Sign in with passkey')!.click());

    expect(onSignin).toHaveBeenCalledOnce();
  });

  it('leads with sign-in on a return visit, and still offers the scanner', () => {
    const onScan = vi.fn();
    renderAuth({ hasPriorUse: true, onScan });

    expect(container.textContent).toContain('Welcome back');
    // A signed-in phone still scans — to pair a computer it has not met.
    act(() => buttonNamed(SCAN_LABEL)!.click());
    expect(onScan).toHaveBeenCalledOnce();
  });

  /**
   * `excludeCredentials` carries what the *Server* holds, so an authenticator
   * refusing over it is proof a sign-in from this device works — where an empty
   * store is merely unproven.
   */
  it('lets a registered passkey outrank an empty store', () => {
    renderAuth({ hasPriorUse: false, passkeyAlreadyRegistered: true });

    expect(container.textContent).toContain('Welcome back');
  });

  it('locks every action while a ceremony this screen started is running', () => {
    renderAuth({ busy: 'pair' });

    expect(buttonNamed(SCAN_LABEL)).toBeNull();
    expect(buttonNamed('…')!.disabled).toBe(true);
    expect(buttonNamed('Sign in with passkey')!.disabled).toBe(true);
  });
});

describe('SetupOrSignin after a native-camera arrival', () => {
  /**
   * The fragment is already erased and its token unspent, so the only thing
   * this run can do is say where the scan actually has to happen — on iOS the
   * installed app is a different storage partition from the tab a camera opens.
   */
  it('says to scan again from inside Pocket', () => {
    renderAuth({ arrivedByCamera: true });

    expect(container.textContent).toContain(CAMERA_BOOTSTRAP_MESSAGE);
    expect(buttonNamed(SCAN_LABEL)).not.toBeNull();
  });

  it('says it on a returning browser too, where sign-in still leads', () => {
    renderAuth({ arrivedByCamera: true, hasPriorUse: true });

    expect(container.textContent).toContain(CAMERA_BOOTSTRAP_MESSAGE);
    expect(container.textContent).toContain('Welcome back');
  });

  it('stays quiet on an ordinary visit', () => {
    renderAuth({ arrivedByCamera: false });

    expect(container.textContent).not.toContain(CAMERA_BOOTSTRAP_MESSAGE);
  });
});

describe('SetupOrSignin install guidance', () => {
  it('warns before the scan, not after it, when iOS needs the install first', () => {
    // The point of putting it here: the passkey a scan mints lands in whichever
    // partition creates it.
    renderAuth({ hasPriorUse: false, needsInstall: true });

    const notice = installNotice();
    const scan = buttonNamed(SCAN_LABEL);
    expect(notice).not.toBeNull();
    // Strictly before, not merely "not after": a notice that *contained* the
    // action would also satisfy FOLLOWING while saying nothing about order.
    expect(notice!.compareDocumentPosition(scan!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice!.contains(scan!)).toBe(false);
  });

  it('stays quiet on a return visit, which mints no passkey', () => {
    renderAuth({ hasPriorUse: true, needsInstall: true });

    expect(installNotice()).toBeNull();
  });

  it('stays advice rather than a gate — the scan is still offered', () => {
    const onScan = vi.fn();
    renderAuth({ hasPriorUse: false, needsInstall: true, onScan });

    const scan = buttonNamed(SCAN_LABEL)!;
    expect(scan.disabled).toBe(false);
    act(() => scan.click());
    expect(onScan).toHaveBeenCalledOnce();
  });

  it('says nothing when the app is installed', () => {
    renderAuth({ hasPriorUse: false, needsInstall: false });

    expect(installNotice()).toBeNull();
  });
});

describe('the two-digit waiting screen', () => {
  /**
   * The laptop's modal tells the user to cancel if the phone is showing no
   * code, so this screen is the one that has to be unmistakable.
   */
  it('shows the digits and what to do with them', () => {
    act(() => {
      root.render(
        <StrictMode>
          <PairingCodeView code="07" onCancel={() => undefined} />
        </StrictMode>,
      );
    });

    expect(container.textContent).toContain('07');
    expect(container.textContent).toContain('Type this code on the computer');
  });

  it('offers a way out while the outcome is still pending', () => {
    const onCancel = vi.fn();
    act(() => {
      root.render(
        <StrictMode>
          <PairingCodeView code="42" onCancel={onCancel} />
        </StrictMode>,
      );
    });

    act(() => buttonNamed('Cancel')!.click());

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('HostsView actions', () => {
  it('offers Connect on a paired row and Pair again where authorization is gone', () => {
    renderHosts({ hosts: NEEDS_PAIRING });

    expect(actionsIn(rowFor('First laptop'))).toEqual(['Connect', 'Remove']);
    expect(actionsIn(rowFor('Second laptop'))).toEqual(['Pair again', 'Remove']);
  });

  it('sends Pair again to the scanner, which is where pairing starts', () => {
    const onScan = vi.fn();
    const onConnect = vi.fn();
    renderHosts({ hosts: NEEDS_PAIRING, onScan, onConnect });

    act(() => rowFor('Second laptop').querySelector('button')!.click());

    expect(onScan).toHaveBeenCalledOnce();
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('routes Connect to the Host whose row it belongs to', () => {
    const onConnect = vi.fn();
    renderHosts({ onConnect });

    act(() => rowFor('Second laptop').querySelector('button')!.click());

    expect(onConnect).toHaveBeenCalledWith(HOSTS[1]);
  });

  it('removes a record locally, whatever the Host is doing', () => {
    const onForget = vi.fn();
    const offline: HostView[] = [{ ...HOSTS[0]!, online: false }];
    renderHosts({ hosts: offline, onForget });

    const remove = [...rowFor('First laptop').querySelectorAll('button')].at(-1)!;
    expect(remove.disabled).toBe(false);
    act(() => remove.click());

    expect(onForget).toHaveBeenCalledWith(offline[0]);
  });

  it('disables Connect on an offline Host but not Pair again', () => {
    // Pairing starts at the scanner and needs no relay socket: the code on the
    // computer's screen is what says whether it is there.
    const offline: HostView[] = [
      { ...HOSTS[0]!, online: false },
      { ...HOSTS[1]!, online: false, needsPairing: true },
    ];
    renderHosts({ hosts: offline });

    expect(rowFor('First laptop').querySelector('button')!.disabled).toBe(true);
    expect(rowFor('Second laptop').querySelector('button')!.disabled).toBe(false);
  });

  it('offers the scanner from the list, paired Hosts or none', () => {
    const onScan = vi.fn();
    renderHosts({ hosts: [], onScan });

    expect(container.textContent).toContain('No computers paired yet');
    act(() => buttonNamed(SCAN_LABEL)!.click());
    expect(onScan).toHaveBeenCalledOnce();
  });
});

describe('the one push card on the Hosts view', () => {
  it('offers once for the whole device, not once per Host', () => {
    // The permission prompt and the PushSubscription belong to the whole
    // service-worker scope, so asking per Host asks for the same thing twice.
    renderHosts();

    expect(
      [...container.querySelectorAll('button')].filter(
        (b) => b.textContent === 'Enable push notifications',
      ),
    ).toHaveLength(1);
  });

  it('registers every paired Host from the one tap', () => {
    const onEnablePush = vi.fn();
    renderHosts({ onEnablePush });

    act(() => buttonNamed('Enable push notifications')!.click());

    // No Host argument to get wrong: the handler reads the paired set itself.
    expect(onEnablePush).toHaveBeenCalledOnce();
    expect(onEnablePush).toHaveBeenCalledWith();
  });

  it('keeps offering while any paired Host still lacks a Server row', () => {
    // A PushSubscription is scope-wide, so a browser that can receive push says
    // nothing about which Hosts hold a row. The row marker is what names the
    // Host the card is still offering to register.
    renderHosts({ isPushSubscribed: (hostId) => hostId === 'host-1' });

    expect(buttonNamed('Enable push notifications')).not.toBeNull();
    expect(rowFor('First laptop').textContent).toContain('Push on');
    expect(rowFor('Second laptop').textContent).not.toContain('Push on');
  });

  it('settles to one line once every paired Host holds a row', () => {
    renderHosts({ isPushSubscribed: () => true });

    expect(container.textContent).toContain('Push notifications on.');
    expect(pushCard()).toBeNull();
    expect(buttonNamed('Enable push notifications')).toBeNull();
  });

  it('counts only paired Hosts, which are the only ones with a row to hold', () => {
    renderHosts({
      hosts: NEEDS_PAIRING,
      isPushSubscribed: (hostId) => hostId === 'host-1',
    });

    expect(container.textContent).toContain('Push notifications on.');
    expect(buttonNamed('Enable push notifications')).toBeNull();
  });

  it('says nothing at all until something is paired', () => {
    renderHosts({ hosts: NEEDS_PAIRING.map((h) => ({ ...h, needsPairing: true })) });

    expect(pushCard()).toBeNull();
    expect(container.textContent).not.toContain('Push notifications on.');
  });

  it('explains an unavailable reason instead of offering a tap that cannot work', () => {
    renderHosts({ pushState: 'denied' });

    expect(pushCard()!.textContent).toContain('blocked');
    expect(buttonNamed('Enable push notifications')).toBeNull();
  });

  it('reports a server with push disabled rather than the browser state', () => {
    renderHosts({ pushConfigStatus: 'disabled' });

    expect(pushCard()!.textContent).toContain('server has push notifications disabled');
    expect(buttonNamed('Enable push notifications')).toBeNull();
  });

  it('leaves needs-install to the install notice rather than doubling it', () => {
    // The card for that state would have said "see above" and nothing else.
    renderHosts({ pushState: 'needs-install' });

    expect(container.textContent).toContain('Add Dormouse to your Home Screen');
    expect(pushCard()).toBeNull();
  });

  it('does not advise installing when the server cannot push at all', () => {
    // The install ritual the notice describes would end at the same "push is
    // disabled" copy — advice and card must not contradict each other.
    renderHosts({ pushState: 'needs-install', pushConfigStatus: 'disabled' });

    expect(container.textContent).not.toContain('Add Dormouse to your Home Screen');
    expect(pushCard()!.textContent).toContain('server has push notifications disabled');
  });

  it('does not offer Enable until the VAPID key is cached', () => {
    renderHosts({ pushConfigStatus: 'loading' });

    expect(pushCard()!.textContent).toContain('Checking whether this server can send push');
    expect(buttonNamed('Enable push notifications')).toBeNull();
  });

  it('retries config separately from the permission-triggering Enable tap', () => {
    const onRetryPushConfig = vi.fn();
    renderHosts({ pushConfigStatus: 'error', onRetryPushConfig });

    expect(pushCard()!.textContent).toContain('Could not check');
    expect(buttonNamed('Enable push notifications')).toBeNull();
    act(() => buttonNamed('Retry')!.click());
    expect(onRetryPushConfig).toHaveBeenCalledOnce();
  });

  it('locks the tap while a subscribe is in flight', () => {
    renderHosts({ busy: 'push' });

    expect(buttonNamed('Enable push notifications')).toBeNull();
    expect(buttonNamed('…')!.disabled).toBe(true);
  });
});

/** `pushNoticeState`'s inputs, with an eligible unregistered device as the base. */
function noticeState(
  overrides: Partial<Parameters<typeof pushNoticeState>[0]> = {},
): ReturnType<typeof pushNoticeState> {
  return pushNoticeState({
    pairedHostIds: ['host-1'],
    isPushSubscribed: () => false,
    availability: 'ready',
    configStatus: 'ready',
    ...overrides,
  });
}

describe('pushNoticeState', () => {
  /**
   * The wall banner and the Host row used to restate the same availability and
   * config gate side by side, staying equal only by parallel edits — while the
   * spec claimed they matched exactly. One card reads one predicate; this is
   * the matrix that pins every cell of it.
   */
  it('offers only where a tap could reach the permission prompt', () => {
    const availabilities: (PushAvailability | null)[] = [
      'ready',
      'denied',
      'unsupported',
      'no-worker',
      'needs-install',
      null,
    ];
    for (const availability of availabilities) {
      for (const configStatus of ['ready', 'loading', 'disabled', 'error'] as const) {
        const offers = noticeState({ availability, configStatus })?.kind === 'offer';
        expect(offers).toBe(availability === 'ready' && configStatus === 'ready');

        // And the card renders exactly what the predicate decided.
        renderHosts({ pushState: availability, pushConfigStatus: configStatus });
        expect(buttonNamed('Enable push notifications') !== null).toBe(offers);
      }
    }
  });

  it('says nothing before the browser has been asked, in either direction', () => {
    // Unprobed is not "cannot", and it is not permission to ask either.
    expect(noticeState({ availability: null })).toBeNull();
    expect(noticeState({ availability: null, isPushSubscribed: () => true })).toBeNull();
  });

  it('lets a push-disabled server outrank a Server row this device still holds', () => {
    // The rows survive a server restarted without VAPID keys; the delivery does
    // not, so "Push notifications on." would be a lie.
    expect(noticeState({ configStatus: 'disabled', isPushSubscribed: () => true })).toEqual({
      kind: 'blocked',
      reason: 'This server has push notifications disabled.',
    });
  });

  it('settles only when every paired Host holds a row', () => {
    const isPushSubscribed = (hostId: string) => hostId === 'host-1';
    expect(noticeState({ isPushSubscribed })?.kind).toBe('on');
    expect(noticeState({ pairedHostIds: ['host-1', 'host-2'], isPushSubscribed })?.kind).toBe(
      'offer',
    );
  });
});
