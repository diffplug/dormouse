/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HostsView,
  SetupOrSignin,
  refinePairState,
  type HostPairState,
  type HostView,
  type PushConfigStatus,
} from './App';
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
    pairState?: (hostId: string) => HostPairState;
    isPushSubscribed?: (hostId: string) => boolean;
    pushState?: PushAvailability | null;
    pushConfigStatus?: PushConfigStatus;
    onPair?: (host: HostView) => void;
    onConnect?: (host: HostView) => void;
    onEnablePush?: (host: HostView) => void;
    onRetryPushConfig?: () => void;
  } = {},
) {
  act(() => {
    root.render(
      <StrictMode>
        <HostsView
          hosts={overrides.hosts ?? HOSTS}
          busy={null}
          error={null}
          pairState={overrides.pairState ?? (() => 'paired')}
          isPushSubscribed={overrides.isPushSubscribed ?? (() => false)}
          pushState={overrides.pushState ?? 'ready'}
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
 * A Host's whole card (host row + push row), found through that Host's label
 * rather than by document order — the assertions are about which Host owns
 * which state, so they must not silently pass if the rows are reordered.
 */
function cardFor(label: string): Element {
  const title = [...container.querySelectorAll('div')].find((el) => el.textContent === label);
  const card = title?.closest('div.flex.flex-col');
  if (!card) throw new Error(`no host card for ${label}`);
  return card;
}

/** The host row itself (not its push row). */
function rowFor(label: string): HTMLElement {
  const row = cardFor(label).firstElementChild;
  if (!(row instanceof HTMLElement)) throw new Error(`no host row for ${label}`);
  return row;
}

/** The labels of a row's action buttons, in order. */
function actionsIn(row: HTMLElement): string[] {
  return [...row.querySelectorAll('button')].map((button) => button.textContent ?? '');
}

/** The push row belonging to one Host. */
function pushRowFor(label: string): HTMLElement {
  const row = cardFor(label).lastElementChild;
  if (!(row instanceof HTMLElement)) throw new Error(`no push row for ${label}`);
  return row;
}

function enableButtonIn(row: HTMLElement): HTMLButtonElement | null {
  return [...row.querySelectorAll('button')].find((b) => b.textContent === 'Enable alerts') ?? null;
}

function retryButtonIn(row: HTMLElement): HTMLButtonElement | null {
  return [...row.querySelectorAll('button')].find((b) => b.textContent === 'Retry') ?? null;
}

function renderAuth(
  overrides: {
    firstRun?: boolean;
    needsInstall?: boolean;
    busy?: string | null;
    error?: string | null;
    onSignin?: () => void;
    onSetup?: (password: string, label: string) => void;
  } = {},
) {
  act(() => {
    root.render(
      <StrictMode>
        <SetupOrSignin
          busy={overrides.busy ?? null}
          error={overrides.error ?? null}
          firstRun={overrides.firstRun ?? true}
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

/** The setup `<form>`, reached through the field it owns. */
function setupForm(): HTMLFormElement {
  const form = setupPasswordField()?.closest('form');
  if (!form) throw new Error('setup fields are not inside a form');
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

    expect(onSetup).toHaveBeenCalledWith('hunter2', 'Work phone');
  });

  it('refuses a submit with no password, the same condition that disables the button', () => {
    const onSetup = vi.fn();
    renderAuth({ firstRun: true, onSetup });

    expect(buttonNamed('Create passkey & sign in')!.disabled).toBe(true);
    submitSetupForm();

    expect(onSetup).not.toHaveBeenCalled();
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

    expect(onSetup).toHaveBeenCalledWith('hunter2', 'My Phone');
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

describe('HostsView push registration', () => {
  it('shows Alerts on only for the Host whose server registration succeeded', () => {
    // A PushSubscription is scope-wide, so a browser that can receive push says
    // nothing about which Hosts hold a server row. Only the registered Host may
    // claim alerts are on; the other must still offer the button.
    renderHosts({ isPushSubscribed: (hostId) => hostId === 'host-1' });

    const first = pushRowFor('First laptop');
    const second = pushRowFor('Second laptop');

    expect(first.textContent).toContain('Alerts on.');
    expect(enableButtonIn(first)).toBeNull();

    expect(second.textContent).not.toContain('Alerts on.');
    expect(enableButtonIn(second)).not.toBeNull();
  });

  it('offers the button for every Host when none has registered', () => {
    renderHosts();

    for (const label of ['First laptop', 'Second laptop']) {
      expect(enableButtonIn(pushRowFor(label))).not.toBeNull();
    }
  });

  it('enables push for the Host whose button was clicked', () => {
    const onEnablePush = vi.fn();
    renderHosts({ onEnablePush });

    act(() => {
      enableButtonIn(pushRowFor('Second laptop'))!.click();
    });

    expect(onEnablePush).toHaveBeenCalledWith(HOSTS[1]);
  });

  it('explains an unavailable reason instead of offering a button that cannot work', () => {
    renderHosts({ pushState: 'denied' });

    const row = pushRowFor('First laptop');
    expect(row.textContent).toContain('blocked');
    expect(enableButtonIn(row)).toBeNull();
  });

  it('reports a server with push disabled rather than the browser state', () => {
    renderHosts({ pushConfigStatus: 'disabled' });

    const row = pushRowFor('First laptop');
    expect(row.textContent).toContain('server has push notifications disabled');
    expect(enableButtonIn(row)).toBeNull();
  });

  it('does not advise installing when the server cannot push at all', () => {
    // The install ritual the notice describes would end at the same "push is
    // disabled" copy the rows already show — advice and rows must not contradict.
    renderHosts({ pushState: 'needs-install', pushConfigStatus: 'disabled' });

    expect(container.textContent).not.toContain('Add Dormouse to your Home Screen');
    expect(pushRowFor('First laptop').textContent).toContain(
      'server has push notifications disabled',
    );
  });

  it('does not offer Enable alerts until the VAPID key is cached', () => {
    renderHosts({ pushConfigStatus: 'loading' });

    const row = pushRowFor('First laptop');
    expect(row.textContent).toContain('Checking whether this server can send alerts');
    expect(enableButtonIn(row)).toBeNull();
  });

  it('retries config separately from the permission-triggering Enable tap', () => {
    const onRetryPushConfig = vi.fn();
    renderHosts({ pushConfigStatus: 'error', onRetryPushConfig });

    const row = pushRowFor('First laptop');
    expect(row.textContent).toContain('Could not check');
    expect(enableButtonIn(row)).toBeNull();
    act(() => retryButtonIn(row)!.click());
    expect(onRetryPushConfig).toHaveBeenCalledOnce();
  });
});
