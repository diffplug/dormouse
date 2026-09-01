/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HostsView,
  SetupOrSignin,
  pushNoticeState,
  refinePairState,
  type HostPairState,
  type HostView,
  type PushConfigStatus,
} from './App';
import type { SetupCredential } from 'server-lib-common';
import type { PushAvailability } from '../client/push-subscribe';
import { setNativeFieldValue } from '../../lib/dom';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HOSTS: HostView[] = [
  { hostId: 'host-1', label: 'First laptop', online: true },
  { hostId: 'host-2', label: 'Second laptop', online: true },
];

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
    pairState?: (hostId: string) => HostPairState;
    isPushSubscribed?: (hostId: string) => boolean;
    pushState?: PushAvailability | null;
    pushConfigStatus?: PushConfigStatus;
    onPair?: (host: HostView) => void;
    onConnect?: (host: HostView) => void;
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
          pairState={overrides.pairState ?? (() => 'paired')}
          isPushSubscribed={overrides.isPushSubscribed ?? (() => false)}
          // Not `??`: an explicit null is "the browser has not been asked yet",
          // which is one of the states under test.
          pushState={overrides.pushState !== undefined ? overrides.pushState : 'ready'}
          pushConfigStatus={overrides.pushConfigStatus ?? 'ready'}
          onRefresh={() => undefined}
          onPair={overrides.onPair ?? (() => undefined)}
          onConnect={overrides.onConnect ?? (() => undefined)}
          onEnablePush={overrides.onEnablePush ?? (() => undefined)}
          onRetryPushConfig={overrides.onRetryPushConfig ?? (() => undefined)}
        />
      </StrictMode>,
    );
  });
}

/**
 * One Host's row, found through that Host's label rather than by document
 * order — the assertions are about which Host owns which state, so they must
 * not silently pass if the rows are reordered.
 */
function rowFor(label: string): HTMLElement {
  const title = [...container.querySelectorAll('div')].find((el) => el.textContent === label);
  const row = title?.closest('div.rounded-lg');
  if (!(row instanceof HTMLElement)) throw new Error(`no host row for ${label}`);
  return row;
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
    firstRun?: boolean;
    setupToken?: string | null;
    needsInstall?: boolean;
    busy?: string | null;
    error?: string | null;
    onSignin?: () => void;
    onSetup?: (credential: SetupCredential, label: string) => void;
  } = {},
) {
  act(() => {
    root.render(
      <StrictMode>
        <SetupOrSignin
          busy={overrides.busy ?? null}
          error={overrides.error ?? null}
          firstRun={overrides.firstRun ?? true}
          setupToken={overrides.setupToken ?? null}
          needsInstall={overrides.needsInstall ?? false}
          onSignin={overrides.onSignin ?? (() => undefined)}
          onSetup={overrides.onSetup ?? (() => undefined)}
        />
      </StrictMode>,
    );
  });
}

/** The setup password field, which is present only when setup is on screen. */
function setupPasswordField(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('#pocket-setup-password');
}

function buttonNamed(label: string | RegExp): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((button) =>
      typeof label === 'string' ? button.textContent === label : label.test(button.textContent ?? ''),
    ) ?? null
  );
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

/** The setup `<form>`; the only one on the screen, password field or not. */
function setupForm(): HTMLFormElement {
  const form = container.querySelector('form');
  if (!form) throw new Error('the setup fields are not on screen');
  return form;
}

/**
 * Submit the form the way the phone keyboard's Go key does. jsdom implements no
 * implicit submission, so the event is dispatched directly — which exercises
 * the handler, the half a `type="button"` did not have at all.
 */
function submitSetupForm() {
  act(() => {
    setupForm().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** Type into a controlled input the way a user would — React listens for `input`. */
function typeInto(input: HTMLInputElement, value: string) {
  act(() => setNativeFieldValue(input, value));
}

describe('SetupOrSignin first run vs return visit', () => {
  it('leads with setup when this browser holds no passkey material', () => {
    // Nothing stored means nothing to sign in with by default, so the fields
    // the visit actually needs must not be behind a disclosure tap.
    renderAuth({ firstRun: true });

    expect(setupPasswordField()).not.toBeNull();
    expect(container.textContent).not.toContain('Welcome back');
    expect(buttonNamed('Create passkey & sign in')).not.toBeNull();
    expect(buttonNamed(/First-time setup/)).toBeNull();
  });

  it('keeps sign-in reachable on a first run, for a passkey that synced here', () => {
    const onSignin = vi.fn();
    renderAuth({ firstRun: true, onSignin });

    act(() => buttonNamed('Sign in with passkey')!.click());

    expect(onSignin).toHaveBeenCalledOnce();
  });

  it('leads with sign-in and keeps setup behind the disclosure on a return visit', () => {
    renderAuth({ firstRun: false });

    expect(container.textContent).toContain('Welcome back');
    expect(buttonNamed('Sign in with passkey')).not.toBeNull();
    expect(setupPasswordField()).toBeNull();

    act(() => buttonNamed(/First-time setup/)!.click());

    expect(setupPasswordField()).not.toBeNull();
  });

  /**
   * The Go key is the primary submit on a phone, and on the now-leading
   * first-run screen these fields *are* the path — so the form has to own the
   * submission rather than a lone `type="button"` click handler.
   */
  it('submits the typed values when the form is submitted, not only on a tap', () => {
    const onSetup = vi.fn();
    renderAuth({ firstRun: true, onSetup });

    typeInto(setupPasswordField()!, 'hunter2');
    typeInto(container.querySelector<HTMLInputElement>('#pocket-setup-label')!, 'Work phone');
    submitSetupForm();

    expect(onSetup).toHaveBeenCalledWith({ password: 'hunter2' }, 'Work phone');
  });

  it('refuses a submit with no password, the same condition that disables the button', () => {
    const onSetup = vi.fn();
    renderAuth({ firstRun: true, onSetup });

    expect(buttonNamed('Create passkey & sign in')!.disabled).toBe(true);
    submitSetupForm();

    expect(onSetup).not.toHaveBeenCalled();
  });
});

describe('SetupOrSignin with a scanned code', () => {
  it('leads with setup and drops the password field, whatever this browser holds', () => {
    // `firstRun: false` is the harder half: someone who just pointed a camera
    // at their laptop is asking for setup, and that intent outranks the stored
    // passkey material that would otherwise say "Welcome back".
    renderAuth({ firstRun: false, setupToken: 'scanned-token' });

    expect(container.textContent).toContain('Set up this phone');
    expect(container.textContent).not.toContain('Welcome back');
    expect(setupPasswordField()).toBeNull();
    expect(container.textContent).toContain('the code you scanned');
    expect(buttonNamed(/First-time setup/)).toBeNull();
  });

  it('submits the token as the credential, with the typed label', () => {
    const onSetup = vi.fn();
    renderAuth({ setupToken: 'scanned-token', onSetup });

    typeInto(container.querySelector<HTMLInputElement>('#pocket-setup-label')!, 'Work phone');
    submitSetupForm();

    expect(onSetup).toHaveBeenCalledWith({ setupToken: 'scanned-token' }, 'Work phone');
  });

  it('submits with nothing typed — there is no password to withhold', () => {
    const onSetup = vi.fn();
    renderAuth({ setupToken: 'scanned-token', onSetup });

    expect(buttonNamed('Create passkey & sign in')!.disabled).toBe(false);
    submitSetupForm();

    expect(onSetup).toHaveBeenCalledWith({ setupToken: 'scanned-token' }, 'My Phone');
  });

  it('keeps sign-in offered — a synced passkey is the better path for some phones', () => {
    const onSignin = vi.fn();
    renderAuth({ firstRun: false, setupToken: 'scanned-token', onSignin });

    act(() => buttonNamed('Sign in with passkey')!.click());

    expect(onSignin).toHaveBeenCalledOnce();
  });

  /**
   * Scanning in an iOS tab and installing afterwards is a different storage
   * partition, so the advice this screen exists to give is no less true for
   * having arrived by camera.
   */
  it('still gives the install-first advice, above the fields', () => {
    renderAuth({ firstRun: false, setupToken: 'scanned-token', needsInstall: true });

    const notice = installNotice();
    const label = container.querySelector<HTMLInputElement>('#pocket-setup-label');
    expect(notice).not.toBeNull();
    expect(
      notice!.compareDocumentPosition(label!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('SetupOrSignin install guidance', () => {
  it('warns before setup, not after it, when iOS needs the install first', () => {
    // The point of moving it here: the device key and passkey this screen
    // mints land in whichever partition creates them.
    renderAuth({ firstRun: true, needsInstall: true });

    const notice = installNotice();
    const password = setupPasswordField();
    expect(notice).not.toBeNull();
    // Strictly before, not merely "not after": a notice that *contained* the
    // field would also satisfy FOLLOWING while saying nothing about order.
    expect(
      notice!.compareDocumentPosition(password!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(notice!.contains(password!)).toBe(false);
  });

  /**
   * Under "Welcome back" the copy ("set up from there", "a passkey made here
   * has to be made all over again") only makes sense next to the fields, so it
   * rides with the disclosure rather than the screen.
   */
  it('stays quiet on a return visit until setup is actually opened', () => {
    renderAuth({ firstRun: false, needsInstall: true });

    expect(installNotice()).toBeNull();

    act(() => buttonNamed(/First-time setup/)!.click());

    const notice = installNotice();
    const password = setupPasswordField();
    expect(notice).not.toBeNull();
    expect(
      notice!.compareDocumentPosition(password!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(notice!.contains(password!)).toBe(false);
  });

  it('stays advice rather than a gate — setup in the tab still submits', () => {
    const onSetup = vi.fn();
    renderAuth({ firstRun: true, needsInstall: true, onSetup });

    typeInto(setupPasswordField()!, 'hunter2');
    const submit = buttonNamed('Create passkey & sign in')!;
    expect(submit.disabled).toBe(false);
    act(() => submit.click());

    expect(onSetup).toHaveBeenCalledWith({ password: 'hunter2' }, 'My Phone');
  });

  it('says nothing when the app is installed, or when push is unavailable for other reasons', () => {
    // `needsInstall` is the iOS-tab signal alone: an unsupported browser or a
    // blocked permission is a different problem, explained on the push rows.
    renderAuth({ firstRun: true, needsInstall: false });

    expect(installNotice()).toBeNull();
  });
});

describe('HostsView pair/connect actions', () => {
  it('offers Pair alone where the Host holds no record for this Client', () => {
    // The whole point of asking the Host: a primary Connect on an unpaired
    // Host is an action that can only fail.
    renderHosts({ pairState: () => 'unpaired' });

    expect(actionsIn(rowFor('First laptop'))).toEqual(['Pair']);
  });

  it('offers Connect alone once the Host recognizes this Client', () => {
    renderHosts({ pairState: () => 'paired' });

    expect(actionsIn(rowFor('Second laptop'))).toEqual(['Connect']);
  });

  it('renames the action to Pair again after an ACL-miss denial', () => {
    renderHosts({ pairState: (hostId) => (hostId === 'host-1' ? 'stale' : 'unpaired') });

    // Still one action, and still Pair — the label is what says the last
    // attempt was denied, so the row explains itself without adding a button.
    expect(actionsIn(rowFor('First laptop'))).toEqual(['Pair again']);
    expect(actionsIn(rowFor('Second laptop'))).toEqual(['Pair']);
  });

  it('keeps one disabled action on an offline host', () => {
    const offline: HostView[] = [
      { hostId: 'host-1', label: 'First laptop', online: false },
      { hostId: 'host-2', label: 'Second laptop', online: false },
    ];
    // Offline means the Host cannot be asked, so the cached marker picks the
    // action — but neither can be taken until it is back.
    renderHosts({
      hosts: offline,
      pairState: (hostId) => (hostId === 'host-1' ? 'paired' : 'unpaired'),
    });

    const paired = rowFor('First laptop');
    expect(actionsIn(paired)).toEqual(['Connect']);
    expect(paired.querySelector('button')!.disabled).toBe(true);
    expect(actionsIn(rowFor('Second laptop'))).toEqual(['Pair']);
    expect(rowFor('Second laptop').querySelector('button')!.disabled).toBe(true);
  });

  it('routes the action to the Host whose row it belongs to', () => {
    const onPair = vi.fn();
    const onConnect = vi.fn();
    renderHosts({
      pairState: (hostId) => (hostId === 'host-1' ? 'paired' : 'unpaired'),
      onPair,
      onConnect,
    });

    act(() => rowFor('First laptop').querySelector('button')!.click());
    act(() => rowFor('Second laptop').querySelector('button')!.click());

    expect(onConnect).toHaveBeenCalledWith(HOSTS[0]);
    expect(onPair).toHaveBeenCalledWith(HOSTS[1]);
  });
});

describe('refinePairState', () => {
  /**
   * The sweep re-runs right after a denial (its `busy` dep flips back to
   * null), and the Host's answer for a lost pairing is plain `unpaired` — so
   * without the one-way refinement, "Pair again" would survive exactly one
   * relay round trip before decaying to "Pair".
   */
  it('keeps stale through a sweep answer; only a pairing clears it', () => {
    expect(refinePairState('stale', 'unpaired')).toBe('stale');
    expect(refinePairState('stale', 'paired')).toBe('paired');
    expect(refinePairState('unpaired', 'unpaired')).toBe('unpaired');
    expect(refinePairState(undefined, 'unpaired')).toBe('unpaired');
    expect(refinePairState('paired', 'stale')).toBe('stale');
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
    expect(actionsIn(rowFor('First laptop'))).toEqual(['Connect']);
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
      pairState: (hostId) => (hostId === 'host-1' ? 'paired' : 'unpaired'),
      isPushSubscribed: (hostId) => hostId === 'host-1',
    });

    expect(container.textContent).toContain('Push notifications on.');
    expect(buttonNamed('Enable push notifications')).toBeNull();
  });

  it('says nothing at all until something is paired', () => {
    renderHosts({ pairState: () => 'unpaired' });

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
