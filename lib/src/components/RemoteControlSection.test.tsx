/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The store reads `getPlatform().burrow`, so the link is the only seam the
 * whole section hangs off. Mutable so a test can present a build with no Burrow
 * service behind it, which is a rendering decision rather than an error.
 */
let platform: { burrow?: unknown; openExternal?: (url: string) => void } = {};

vi.mock('../lib/platform', () => ({
  IS_MAC: false,
  getPlatform: () => platform,
}));

/**
 * The encoder chunk, held back where a case says so ({@link holdQrChunk}): the
 * code suspends until it lands, as the lazy import does on a session's first
 * open. Otherwise it is the real encoder.
 */
const qrChunk = vi.hoisted(() => ({ pending: null as Promise<void> | null }));
vi.mock('./QrCode', async (importOriginal) => {
  const real = await importOriginal<typeof import('./QrCode')>();
  return {
    QrCode(props: Parameters<typeof real.QrCode>[0]) {
      if (qrChunk.pending) throw qrChunk.pending;
      return <real.QrCode {...props} />;
    },
  };
});

import { ONE_TIME_OUTCOME_LABEL, oneTimeEndedCopy } from './OneTimeConnection';
import {
  HOSTED_ENROLLMENT_CODE_LABEL,
  HOSTED_ENROLLMENT_ENDED_COPY,
  HOSTED_ENROLLMENT_REDEEMING_COPY,
  NOT_ENTITLED_COPY,
  PAIRING_OUTCOME_LABEL,
  RemoteControlSection,
  removedCopy,
} from './RemoteControlSection';
import { hostOf, pathRefusalSentence } from './remote-control-shared';
import { DEFAULT_RELAY_ORIGIN } from '../host/relay-origin';
import {
  isOneTimeState,
  type BurrowConsoleStatus,
  type HostedEnrollmentState,
  type SetupQrResult,
} from '../host/remote/service-protocol';
import {
  ANYWHERE_ON,
  enrolledStatus,
  LOCAL_ON,
  makeEventedBurrowLink,
  makeStubBurrowLink,
  OFFER_STATUS,
  oneTimeWaiting,
  SELF_HOST_RELAY_ORIGIN,
  SELF_HOST_UNENROLLED_STATUS as SELF_HOST_NOT_ENROLLED,
  setupQrResult,
  UNENROLLED_STATUS as NOT_ENROLLED,
} from '../host/remote/test-burrow-link';
import type { OneTimeEndReason, OneTimeState } from '../remote/burrow/one-time-runtime';
import { networkPolicyResult, type NetworkPolicy } from '../remote/network-policy';
import { refreshBurrowStatus } from '../remote/burrow/burrow-status-store';
import { getOneTimeSnapshot, subscribeToOneTime } from '../remote/burrow/one-time-store';
import { TEST_SETUP_PASSWORD } from '../remote/test-setup-password';
import { SETUP_BUTTON } from '../remote/setup-copy';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function makeLink(command: (cmd: string, params?: unknown) => Promise<unknown>) {
  return makeEventedBurrowLink(
    vi.fn(async (cmd: string, params?: unknown) => {
      const answer = await command(cmd, params);
      // Every service answers `oneTimeStatus`. A case about the Relay answers
      // every command with one status, so that reads as a machine with no
      // one-time connection rather than as a bridge answering nonsense.
      return cmd === 'oneTimeStatus' && !isOneTimeState(answer) ? { status: 'idle' } : answer;
    }),
  );
}

/** Frozen only where a setup code's countdown has to read the same every run. */
const NOW = Date.now();

/** A `setupQr` answer: the QR's secrets in the URL, plus the invitation's id. */
function qr(over: Partial<SetupQrResult> = {}): SetupQrResult {
  return {
    url: 'https://laptop.tailnet.ts.net/#pair?token=abc123&nonce=xyz789',
    inviteId: 'invite-1',
    expiresAt: NOW + 300_000,
    ...over,
  };
}

/** A Hosted enrollment waiting for approval, ten minutes out. */
function hostedWaiting(over: { accountFull?: boolean } = {}): HostedEnrollmentState {
  return {
    status: 'waiting',
    userCode: '23AB-YZ9K',
    verificationUrl: 'https://hosted.dormouse.sh/enroll#23AB-YZ9K',
    expiresAt: Date.now() + 10 * 60_000,
    accountFull: over.accountFull ?? false,
  };
}

/** The code a waiting Hosted enrollment shows, by its accessible name. */
function codeShown(): string | null {
  return container.querySelector(`[aria-label="${HOSTED_ENROLLMENT_CODE_LABEL}"]`)?.textContent ?? null;
}

/** The name-and-button form a Hosted build begins with, always mounted once unfolded. */
function hostedForm(): HTMLFormElement {
  const form = [...container.querySelectorAll('form')].find((candidate) =>
    candidate.textContent?.includes('Name for this Burrow'),
  );
  if (!form) throw new Error('the Hosted enroll form is not mounted');
  return form;
}

/** The shared fixture, keeping this file's own Relay/burrow values. */
const enrolled = (over: Partial<BurrowConsoleStatus> = {}) =>
  enrolledStatus({
    relayOrigin: 'https://laptop.tailnet.ts.net',
    burrowId: 'burrow-1',
    pairedClients: 1,
    ...over,
  });

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<RemoteControlSection />);
  });
}

/**
 * Let the lazily-imported `QrCode` land. The encoder rides its own chunk so
 * `uqr` stays out of the main bundle (`RemoteControlSection.tsx`), which puts
 * the code one `import()` behind the render that asks for it — resolved in a
 * microtask here only because {@link beforeAll} already made the module
 * resident, so this is a flush rather than a wait on a real module load.
 */
async function settleQrChunk() {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Keep the encoder chunk from landing until the returned call, as on the first
 * open of a session: the code's `Suspense` fallback is empty meanwhile, so the
 * panel is short of the QR's height.
 */
function holdQrChunk(): () => Promise<void> {
  let land: () => void = () => {};
  qrChunk.pending = new Promise<void>((resolve) => {
    land = resolve;
  });
  return async () => {
    qrChunk.pending = null;
    await act(async () => {
      land();
      await Promise.resolve();
    });
  };
}

/**
 * Stand in for `scrollIntoView`, recording whether a code was drawn at each
 * reveal; the returned call restores it.
 */
function watchReveals(): { drawnAtReveal: boolean[]; restore: () => void } {
  const drawnAtReveal: boolean[] = [];
  const had = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  Element.prototype.scrollIntoView = vi.fn((options?: boolean | ScrollIntoViewOptions) => {
    expect(options).toEqual({ block: 'nearest' });
    drawnAtReveal.push(container.querySelector('svg[role="img"]') !== null);
  });
  return {
    drawnAtReveal,
    restore: () => {
      if (had) Object.defineProperty(Element.prototype, 'scrollIntoView', had);
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    },
  };
}

/**
 * An enrolled machine with the panel open on a live code, handing back the link
 * so a case can drive invitation events against it. `status` answers every
 * other command, read at each call.
 */
async function openSetupPanel(
  status: () => unknown = () => enrolled(),
): Promise<ReturnType<typeof makeLink>> {
  const link = makeLink(async (cmd) => (cmd === 'setupQr' ? qr() : status()));
  platform = { burrow: link };
  await render();
  await act(async () => buttonLabelled('Set up a phone')!.click());
  await settleQrChunk();
  return link;
}

function text(): string {
  return container.textContent ?? '';
}

/**
 * The region that reports how a pairing ended, by the accessible name the
 * walkthrough waits on too (`PAIRING_OUTCOME_LABEL`).
 */
function outcomeRegion(): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `[role="status"][aria-label="${PAIRING_OUTCOME_LABEL}"]`,
  );
}

function buttonLabelled(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

/** The disclosure carries a `+`/`−` prefix, so match on its words rather than all of it. */
function disclosure(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Enroll with the setup password'),
  ) as HTMLButtonElement | undefined;
}

/**
 * The two-field form a self-host build shows, which is always mounted: folding
 * it away is the `hidden` attribute, so what is typed into it survives both the
 * disclosure and an offer appearing on disk underneath it.
 */
function typedForm(): HTMLFormElement {
  const form = [...container.querySelectorAll('form')].find((candidate) =>
    candidate.textContent?.includes('This Dormouse was built for this Relay:'),
  );
  if (!form) throw new Error('the typed enroll form is not mounted');
  return form;
}

/** Unfold Persistent Relay the way a user does; un-enrolled with no offer, it starts folded. */
async function openPersistent() {
  await act(async () => buttonLabelled('Persistent Relay')!.click());
}

/** The panel Persistent Relay unfolds, which is what `hidden` toggles. */
function persistentPanel(): HTMLElement {
  const panel = buttonLabelled('Persistent Relay')?.parentElement?.querySelector<HTMLElement>(
    ':scope > div.rounded',
  );
  if (!panel) throw new Error('the Persistent Relay panel is not mounted');
  return panel;
}

async function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`no input for ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeAll(async () => {
  // Load the lazy chunk once, up front. Otherwise the first test that renders a
  // code waits on a real module transform, and how long that takes is not
  // something a test should be timing.
  await import('./QrCode');
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  // Unmounting drops the store's last subscriber, which resets it — otherwise
  // one test's status would seed the next one's first paint.
  await act(async () => root.unmount());
  container.remove();
  platform = {};
  qrChunk.pending = null;
  vi.clearAllMocks();
});

describe('RemoteControlSection', () => {
  it('renders nothing on a build with no Burrow service', async () => {
    platform = {};
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('offers a stock build a one-time connection and a folded Persistent Relay with nothing to enroll', async () => {
    const openExternal = vi.fn();
    platform = { burrow: makeLink(async () => NOT_ENROLLED), openExternal };
    await render();
    expect(buttonLabelled('One-time connection')!.disabled).toBe(false);
    expect(text()).toContain(
      'Open a link on your phone for a one-off connection. Your phone must be on an allowed ' +
        'network. No account needed.',
    );
    expect(buttonLabelled('Persistent Relay')!.getAttribute('aria-expanded')).toBe('false');
    expect(persistentPanel().hidden).toBe(true);

    await openPersistent();
    expect(buttonLabelled('Persistent Relay')!.getAttribute('aria-expanded')).toBe('true');
    expect(persistentPanel().hidden).toBe(false);
    // Its one Relay is Hosted's (docs/specs/relay.md → "Relay origin"): no
    // password form, no offer card, and the self-host path named as a build.
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(buttonLabelled('Connect')).toBeUndefined();
    expect(text()).toContain('A self-hosted Relay takes a Dormouse built for its address.');
    await act(async () => buttonLabelled('self-hosted Relay')!.click());
    expect(openExternal).toHaveBeenCalledWith('https://dormouse.sh/self-host/');
  });

  it('begins a Hosted enrollment under the name typed for this machine', async () => {
    let status: BurrowConsoleStatus = NOT_ENROLLED;
    const link = makeLink(async (cmd) => {
      if (cmd === 'beginHostedEnrollment') {
        status = { ...NOT_ENROLLED, hostedEnrollment: hostedWaiting() };
        return status.hostedEnrollment;
      }
      return status;
    });
    platform = { burrow: link };
    await render();
    await openPersistent();
    expect(hostedForm().hidden).toBe(false);
    await type('input:not([type])', 'Work laptop');

    await act(async () => buttonLabelled('Enroll with hosted.dormouse.sh')!.click());

    expect(link.command).toHaveBeenCalledWith('beginHostedEnrollment', { label: 'Work laptop' });
    expect(codeShown()).toBe('23AB-YZ9K');
    // Hidden while the code waits, never unmounted: what was typed survives.
    expect(hostedForm().hidden).toBe(true);
  });

  it('shows the code waiting in large type, opens the account page the service composed, and cancels', async () => {
    const openExternal = vi.fn();
    const link = makeLink(async () => ({ ...NOT_ENROLLED, hostedEnrollment: hostedWaiting() }));
    platform = { burrow: link, openExternal };
    await render();

    // Unfolded from the start: the dialog reopened on a code waiting.
    expect(persistentPanel().hidden).toBe(false);
    expect(codeShown()).toBe('23AB-YZ9K');
    expect(text()).toContain('Expires in 10 min.');
    expect(text()).not.toContain('already has as many computers');
    await act(async () => buttonLabelled('Open hosted.dormouse.sh to approve')!.click());
    expect(openExternal).toHaveBeenCalledWith('https://hosted.dormouse.sh/enroll#23AB-YZ9K');

    await act(async () => buttonLabelled('Cancel')!.click());
    expect(link.command).toHaveBeenCalledWith('cancelHostedEnrollment');
  });

  it('says a full account enrolls on its own once a computer is removed there', async () => {
    const openExternal = vi.fn();
    platform = {
      burrow: makeLink(async () => ({ ...NOT_ENROLLED, hostedEnrollment: hostedWaiting({ accountFull: true }) })),
      openExternal,
    };
    await render();

    expect(text()).toContain('That account already has as many computers as it can enroll.');
    await act(async () => buttonLabelled('Remove one')!.click());
    expect(openExternal).toHaveBeenCalledWith('https://hosted.dormouse.sh/account');
  });

  it('says in fixed copy why an enrollment ended, and offers a new code or Done', async () => {
    let ended: HostedEnrollmentState = { status: 'ended', reason: 'not-entitled' };
    const link = makeLink(async () => ({ ...NOT_ENROLLED, hostedEnrollment: ended }));
    platform = { burrow: link };
    await render();
    expect(text()).toContain(HOSTED_ENROLLMENT_ENDED_COPY['not-entitled']);

    ended = { status: 'ended', reason: 'expired' };
    await act(async () => refreshBurrowStatus());
    expect(text()).toContain(HOSTED_ENROLLMENT_ENDED_COPY.expired);

    ended = { status: 'ended', reason: 'failed', message: 'keychain is locked' };
    await act(async () => refreshBurrowStatus());
    expect(text()).toContain(HOSTED_ENROLLMENT_ENDED_COPY.failed);
    expect(text()).toContain('keychain is locked');

    // A new code is just a begin, which the service answers with a fresh one.
    await act(async () => buttonLabelled('Get a new code')!.click());
    expect(link.command).toHaveBeenCalledWith('beginHostedEnrollment', { label: NOT_ENROLLED.suggestedLabel });
    await act(async () => buttonLabelled('Done')!.click());
    expect(link.command).toHaveBeenCalledWith('cancelHostedEnrollment');
  });

  it('disables Open once the code’s countdown reaches zero', async () => {
    const openExternal = vi.fn();
    platform = {
      burrow: makeLink(async () => ({
        ...NOT_ENROLLED,
        hostedEnrollment: { ...hostedWaiting(), expiresAt: Date.now() - 1 } as HostedEnrollmentState,
      })),
      openExternal,
    };
    await render();
    expect(text()).toContain('This code has expired.');
    expect(buttonLabelled('Open hosted.dormouse.sh to approve')!.disabled).toBe(true);
  });

  it('says a redeemed code is enrolling, with nothing to cancel or begin', async () => {
    platform = { burrow: makeLink(async () => ({ ...NOT_ENROLLED, hostedEnrollment: { status: 'redeeming' } })) };
    await render();
    expect(persistentPanel().hidden).toBe(false);
    expect(text()).toContain(HOSTED_ENROLLMENT_REDEEMING_COPY);
    expect(hostedForm().hidden).toBe(true);
    expect(buttonLabelled('Cancel')).toBeUndefined();
  });

  it('sends a lost answer to the account page to remove the Burrow it added, by name', async () => {
    const openExternal = vi.fn();
    platform = {
      burrow: makeLink(async () => ({
        ...NOT_ENROLLED,
        hostedEnrollment: { status: 'ended', reason: 'answer-lost', burrowId: 'T7lzkkrPT8nx4m9zf90V4h' },
      })),
      openExternal,
    };
    await render();
    expect(text()).toContain(HOSTED_ENROLLMENT_ENDED_COPY['answer-lost']);
    expect(text()).toContain('Remove Burrow T7lzkkrPT8nx4m9zf90V4h from your account');
    await act(async () => buttonLabelled('Manage computers at hosted.dormouse.sh')!.click());
    expect(openExternal).toHaveBeenCalledWith('https://hosted.dormouse.sh/account');
  });

  it('shows an enrolled machine why a second redemption could not be kept, until dismissed', async () => {
    const message = 'Your account holds Burrow T7lzkkrPT8nx4m9zf90V4h, which this computer could not keep.';
    const link = makeLink(async () =>
      enrolled({
        relayOrigin: DEFAULT_RELAY_ORIGIN,
        relayMode: 'hosted',
        accountOrigin: 'https://hosted.dormouse.sh',
        hostedEnrollment: { status: 'ended', reason: 'failed', message },
      }),
    );
    platform = { burrow: link };
    await render();
    expect(text()).toContain(message);
    await act(async () => buttonLabelled('Dismiss')!.click());
    expect(link.command).toHaveBeenCalledWith('cancelHostedEnrollment');
  });

  it('shows a refused begin where the button is', async () => {
    platform = {
      burrow: makeLink(async (cmd) => {
        if (cmd === 'beginHostedEnrollment') throw new Error('Settings → Network is set to Nothing');
        return NOT_ENROLLED;
      }),
    };
    await render();
    await openPersistent();
    await act(async () => buttonLabelled('Enroll with hosted.dormouse.sh')!.click());
    expect(text()).toContain('Settings → Network is set to Nothing');
  });

  it('links a Hosted enrollment to the account that manages it, and a self-host one to nothing', async () => {
    const openExternal = vi.fn();
    platform = {
      burrow: makeLink(async () =>
        enrolled({ relayOrigin: DEFAULT_RELAY_ORIGIN, relayMode: 'hosted', accountOrigin: 'https://hosted.dormouse.sh' }),
      ),
      openExternal,
    };
    await render();
    await act(async () => buttonLabelled('Manage computers at hosted.dormouse.sh')!.click());
    expect(openExternal).toHaveBeenCalledWith('https://hosted.dormouse.sh/account');
    await act(async () => root.unmount());

    // A dev Hosted build's account is where its waiting view sent the approval.
    root = createRoot(container);
    platform = {
      burrow: makeLink(async () =>
        enrolled({ relayOrigin: 'http://localhost:8787', relayMode: 'hosted', accountOrigin: 'http://localhost:5173' }),
      ),
      openExternal,
    };
    await render();
    await act(async () => buttonLabelled('Manage computers at localhost:5173')!.click());
    expect(openExternal).toHaveBeenLastCalledWith('http://localhost:5173/account');
    await act(async () => root.unmount());

    root = createRoot(container);
    platform = { burrow: makeLink(async () => enrolled()) };
    await render();
    expect(buttonLabelled('Manage computers at hosted.dormouse.sh')).toBeUndefined();
  });

  it('offers a self-host build its form under the origin it was built for, and no Hosted button', async () => {
    platform = { burrow: makeLink(async () => SELF_HOST_NOT_ENROLLED) };
    await render();
    await openPersistent();

    expect(typedForm().hidden).toBe(false);
    expect(typedForm().textContent).toContain(SELF_HOST_RELAY_ORIGIN);
    // The origin is named, never typed: no field for it.
    expect(container.querySelector('input[type="url"]')).toBeNull();
    expect(buttonLabelled('Enroll with hosted.dormouse.sh')).toBeUndefined();
    expect(buttonLabelled('Connect')).toBeTruthy();
  });

  it('keeps Persistent Relay folded until clicked, even with an offer waiting', async () => {
    platform = { burrow: makeLink(async () => OFFER_STATUS) };
    await render();
    expect(buttonLabelled('Persistent Relay')!.getAttribute('aria-expanded')).toBe('false');
    expect(persistentPanel().hidden).toBe(true);

    await openPersistent();
    expect(persistentPanel().hidden).toBe(false);
    expect(buttonLabelled('Enroll')).toBeTruthy();
  });

  it('shows the enrolled Relay without a click, still offering a one-time connection', async () => {
    platform = { burrow: makeLink(async () => enrolled()) };
    await render();
    expect(buttonLabelled('Persistent Relay')).toBeUndefined();
    expect(text()).toContain('Persistent Relay');
    expect(text()).not.toContain('Enroll this Dormouse');
    expect(buttonLabelled('Set up a phone')).toBeTruthy();
    expect(buttonLabelled('One-time connection')!.disabled).toBe(false);
  });

  it('keeps what was typed through folding Persistent Relay', async () => {
    platform = { burrow: makeLink(async () => SELF_HOST_NOT_ENROLLED) };
    await render();
    await openPersistent();
    await type('input[type="password"]', TEST_SETUP_PASSWORD);
    await openPersistent();
    expect(persistentPanel().hidden).toBe(true);
    await openPersistent();
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(
      TEST_SETUP_PASSWORD,
    );
  });

  it('folds Persistent Relay after a Disconnect', async () => {
    let status: unknown = enrolled();
    const link = makeLink(async (cmd) => {
      if (cmd === 'clearEnrollment') status = SELF_HOST_NOT_ENROLLED;
      return status;
    });
    platform = { burrow: link };
    await render();
    await act(async () => buttonLabelled('Disconnect')!.click());
    await act(async () => buttonLabelled('Disconnect')!.click());

    expect(buttonLabelled('Persistent Relay')!.getAttribute('aria-expanded')).toBe('false');
    expect(persistentPanel().hidden).toBe(true);
  });

  it('keeps Connect disabled until every field is filled', async () => {
    platform = { burrow: makeLink(async () => SELF_HOST_NOT_ENROLLED) };
    await render();
    await openPersistent();

    // The name arrives prefilled from the service's suggestion — the same one
    // the offer card uses, so the two paths cannot diverge on it.
    const name = 'input:not([type])';
    expect(container.querySelector<HTMLInputElement>(name)!.value).toBe('ned-mac');
    expect(buttonLabelled('Connect')!.disabled).toBe(true);
    await type('input[type="password"]', TEST_SETUP_PASSWORD);
    expect(buttonLabelled('Connect')!.disabled).toBe(false);
    // And it is still a required field, not a decoration.
    await type(name, '   ');
    expect(buttonLabelled('Connect')!.disabled).toBe(true);
  });

  it('enrolls with trimmed values and re-reads the status', async () => {
    let status: unknown = SELF_HOST_NOT_ENROLLED;
    const link = makeLink(async (cmd) => {
      if (cmd === 'enroll') {
        status = enrolled();
        return { burrowId: 'burrow-1' };
      }
      return status;
    });
    platform = { burrow: link };
    await render();
    await openPersistent();

    await type('input[type="password"]', TEST_SETUP_PASSWORD);
    await type('input:not([type])', '  Work laptop  ');
    await act(async () => buttonLabelled('Connect')!.click());

    // No origin: the service enrolls only at the build's own.
    expect(link.command).toHaveBeenCalledWith('enroll', {
      password: TEST_SETUP_PASSWORD,
      label: 'Work laptop',
    });
    // The status re-read after enrolling is what flips the view.
    expect(text()).toContain('https://laptop.tailnet.ts.net');
    expect(text()).toContain('Connected');
  });

  it('surfaces an enrollment refusal instead of silently failing', async () => {
    const refusal =
      `The Relay says its origin is https://ned-mac.local, but this build was made for ${SELF_HOST_RELAY_ORIGIN}.`;
    const link = makeLink(async (cmd) => {
      if (cmd === 'enroll') throw new Error(refusal);
      return SELF_HOST_NOT_ENROLLED;
    });
    platform = { burrow: link };
    await render();
    await openPersistent();

    await type('input[type="password"]', TEST_SETUP_PASSWORD);
    await type('input:not([type])', 'Work laptop');
    await act(async () => buttonLabelled('Connect')!.click());

    expect(text()).toContain(refusal);
    // Still on the form, with the password kept for a retry.
    expect(buttonLabelled('Connect')).toBeTruthy();
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(
      TEST_SETUP_PASSWORD,
    );
  });

  it('leads with the installer’s offer and folds the typed form away', async () => {
    platform = { burrow: makeLink(async () => OFFER_STATUS) };
    await render();
    await openPersistent();

    expect(text()).toContain('A Dormouse Relay is installed on this machine.');
    expect(text()).toContain('https://ned-mac.tail9c2f1.ts.net');
    expect(buttonLabelled('Enroll')).toBeTruthy();
    // The typed form is behind the disclosure, not beside the card —
    // hidden rather than unmounted, so a half-typed one survives the flip.
    expect(typedForm().hidden).toBe(true);
    expect(container.querySelector('input[type="password"]')).toBeTruthy();
    // Folded, and saying so before it is clicked.
    expect(disclosure()?.textContent).toContain('+');
  });

  it('enrolls from the offer with the name shown, which is editable', async () => {
    let status: unknown = OFFER_STATUS;
    const link = makeLink(async (cmd) => {
      if (cmd === 'enrollOffer') {
        status = enrolled();
        return { burrowId: 'burrow-1' };
      }
      return status;
    });
    platform = { burrow: link };
    await render();
    await openPersistent();

    // Prefilled from the service's suggestion, and the user overrode it.
    const input = container.querySelector<HTMLInputElement>('input:not([type])')!;
    expect(input.value).toBe('ned-mac');
    await type('input:not([type])', '  Work laptop  ');
    await act(async () => buttonLabelled('Enroll')!.click());

    // The name and nothing else: the service re-reads the token off the file.
    expect(link.command).toHaveBeenCalledWith('enrollOffer', { label: 'Work laptop' });
    expect(text()).toContain('https://laptop.tailnet.ts.net');
    expect(text()).toContain('Connected');
  });

  it('keeps a half-typed form when an offer appears underneath it', async () => {
    // The installer can run while this dialog is open, and the 2 s poll picks
    // the offer up. Folding the form away must not empty it.
    vi.useFakeTimers();
    try {
      let status: unknown = SELF_HOST_NOT_ENROLLED;
      platform = { burrow: makeLink(async () => status) };
      await render();
      await openPersistent();

      await type('input[type="password"]', TEST_SETUP_PASSWORD);
      status = OFFER_STATUS;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(text()).toContain('A Dormouse Relay is installed on this machine.');
      expect(typedForm().hidden).toBe(true);
      expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(
        TEST_SETUP_PASSWORD,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('still shows a failed enroll after the offer vanished under it', async () => {
    // Redeeming an offer unlinks it, so a poll can report no offer while the
    // enroll that spent it is still in flight. A card that went with the file
    // would leave a late refusal nowhere to render — silence, with a single-use
    // token already gone.
    vi.useFakeTimers();
    try {
      let status: unknown = OFFER_STATUS;
      let failEnroll: (error: Error) => void = () => {};
      const link = makeLink(async (cmd) => {
        if (cmd === 'enrollOffer') {
          status = SELF_HOST_NOT_ENROLLED;
          return new Promise<unknown>((_resolve, reject) => {
            failEnroll = reject;
          });
        }
        return status;
      });
      platform = { burrow: link };
      await render();
      await openPersistent();

      await act(async () => buttonLabelled('Enroll')!.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      // The card is still here, on the origin the user reviewed.
      expect(text()).toContain(SELF_HOST_RELAY_ORIGIN);

      await act(async () => {
        failEnroll(new Error('The Relay did not accept that setup password.'));
        await Promise.resolve();
      });
      expect(text()).toContain('The Relay did not accept that setup password.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a one-click refusal where the typed form renders its own', async () => {
    const refusal = 'This machine’s enrollment offer is no longer valid. Enroll with the setup password instead.';
    const link = makeLink(async (cmd) => {
      if (cmd === 'enrollOffer') throw new Error(refusal);
      return OFFER_STATUS;
    });
    platform = { burrow: link };
    await render();
    await openPersistent();

    await act(async () => buttonLabelled('Enroll')!.click());
    expect(text()).toContain(refusal);
    // Still on the card, and the typed form is still one click away.
    expect(buttonLabelled('Enroll')).toBeTruthy();
    expect(disclosure()).toBeTruthy();
  });

  it('unfolds the typed form behind the offer', async () => {
    platform = { burrow: makeLink(async () => OFFER_STATUS) };
    await render();
    await openPersistent();

    await act(async () => disclosure()!.click());
    expect(typedForm().hidden).toBe(false);
    expect(buttonLabelled('Connect')).toBeTruthy();
    expect(disclosure()?.textContent).toContain('−');
    // The offer stays offered — unfolding is not a rejection of it.
    expect(buttonLabelled('Enroll')).toBeTruthy();

    // And refolding hides what was typed rather than discarding it.
    await type('input[type="password"]', TEST_SETUP_PASSWORD);
    await act(async () => disclosure()!.click());
    expect(typedForm().hidden).toBe(true);
    await act(async () => disclosure()!.click());
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(
      TEST_SETUP_PASSWORD,
    );
  });

  it('runs only one enrollment across the offer and typed forms', async () => {
    let finishOffer: (value: unknown) => void = () => {};
    const link = makeLink(async (cmd) => {
      if (cmd === 'enrollOffer') {
        return new Promise((resolve) => {
          finishOffer = resolve;
        });
      }
      if (cmd === 'enroll') return { burrowId: 'wrong-racer' };
      return OFFER_STATUS;
    });
    platform = { burrow: link };
    await render();
    await openPersistent();

    await act(async () => disclosure()!.click());
    await type('input[type="password"]', TEST_SETUP_PASSWORD);

    await act(async () => {
      buttonLabelled('Enroll')!.click();
      // A submit event bypasses the button's next-render `disabled` state and
      // exercises the synchronous gate between the two handlers directly.
      typedForm().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    const enrollCommands = link.command.mock.calls.filter(([cmd]) =>
      ['enroll', 'enrollOffer'].includes(cmd),
    );
    expect(enrollCommands.map(([cmd]) => cmd)).toEqual(['enrollOffer']);
    expect(buttonLabelled('Connect')!.disabled).toBe(true);

    await act(async () => {
      finishOffer({ burrowId: 'burrow-1' });
      await Promise.resolve();
    });
  });

  it('shows the Relay and paired-device count when enrolled', async () => {
    platform = { burrow: makeLink(async () => enrolled({ pairedClients: 2 })) };
    await render();
    expect(text()).toContain('https://laptop.tailnet.ts.net');
    expect(text()).toContain('2 paired phones');
    expect(buttonLabelled('Reconnect')).toBeUndefined();
  });

  it('offers Reconnect only when the Burrow was displaced', async () => {
    const link = makeLink(async () => enrolled({ connection: 'displaced' }));
    platform = { burrow: link };
    await render();

    expect(text()).toContain('took this Relay’s slot');
    await act(async () => buttonLabelled('Reconnect')!.click());
    expect(link.command).toHaveBeenCalledWith('reconnect');
  });

  it('says a self-host Burrow was removed from its Relay, with Disconnect alone', async () => {
    platform = { burrow: makeLink(async () => enrolled({ connection: 'removed' })) };
    await render();
    expect(text()).toContain(removedCopy(enrolled()));
    expect(text()).toContain('removed from laptop.tailnet.ts.net');
    expect(buttonLabelled('Disconnect')).toBeTruthy();
    for (const absent of ['Reconnect', 'Enroll again', SETUP_BUTTON]) {
      expect(buttonLabelled(absent), absent).toBeUndefined();
    }
  });

  it('enrolls a removed Hosted Burrow again: the dead enrollment cleared, then a code begun', async () => {
    let enrolledNow = true;
    const hosted = {
      relayOrigin: DEFAULT_RELAY_ORIGIN,
      relayMode: 'hosted' as const,
      accountOrigin: 'https://hosted.dormouse.sh',
    };
    const link = makeLink(async (cmd) => {
      if (cmd === 'clearEnrollment') {
        enrolledNow = false;
        return {};
      }
      if (cmd === 'beginHostedEnrollment') return hostedWaiting();
      return enrolledNow
        ? enrolled({ ...hosted, connection: 'removed' })
        : { ...NOT_ENROLLED, hostedEnrollment: hostedWaiting() };
    });
    platform = { burrow: link };
    await render();
    expect(text()).toContain('This computer was removed from your account at hosted.dormouse.sh.');
    expect(buttonLabelled(SETUP_BUTTON)).toBeUndefined();
    expect(buttonLabelled('Reconnect')).toBeUndefined();
    expect(buttonLabelled('Disconnect')).toBeTruthy();

    await act(async () => buttonLabelled('Enroll again')!.click());
    const order = link.command.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd === 'clearEnrollment' || cmd === 'beginHostedEnrollment');
    expect(order).toEqual(['clearEnrollment', 'beginHostedEnrollment']);
    expect(link.command).toHaveBeenCalledWith('beginHostedEnrollment', { label: 'ned-mac' });
    // The code is in view, not folded behind Persistent Relay.
    expect(codeShown()).toBe('23AB-YZ9K');
  });

  it('shows a begin refused after Enroll again cleared the enrollment', async () => {
    let enrolledNow = true;
    const link = makeLink(async (cmd) => {
      if (cmd === 'clearEnrollment') {
        enrolledNow = false;
        return {};
      }
      if (cmd === 'beginHostedEnrollment') throw new Error('Couldn’t reach relay.dormouse.sh: the name doesn’t resolve.');
      return enrolledNow ? enrolled({ relayMode: 'hosted', connection: 'removed' }) : NOT_ENROLLED;
    });
    platform = { burrow: link };
    await render();
    await act(async () => buttonLabelled('Enroll again')!.click());
    expect(text()).toContain('Couldn’t reach relay.dormouse.sh: the name doesn’t resolve.');
    expect(hostedForm().hidden).toBe(false);
  });

  it('says a Hosted plan no longer includes remote control, with Reconnect and Disconnect', async () => {
    const link = makeLink(async () => enrolled({ relayMode: 'hosted', connection: 'not-entitled' }));
    platform = { burrow: link };
    await render();
    expect(text()).toContain(NOT_ENTITLED_COPY);
    expect(buttonLabelled(SETUP_BUTTON)).toBeUndefined();
    expect(buttonLabelled('Enroll again')).toBeUndefined();
    expect(buttonLabelled('Disconnect')).toBeTruthy();
    await act(async () => buttonLabelled('Reconnect')!.click());
    expect(link.command).toHaveBeenCalledWith('reconnect');
  });

  it('confirms before disconnecting, because paired phones must re-pair', async () => {
    const link = makeLink(async () => enrolled());
    platform = { burrow: link };
    await render();

    await act(async () => buttonLabelled('Disconnect')!.click());
    expect(link.command).not.toHaveBeenCalledWith('clearEnrollment');
    expect(text()).toContain('Paired phones will need to pair again');

    await act(async () => buttonLabelled('Disconnect')!.click());
    expect(link.command).toHaveBeenCalledWith('clearEnrollment');
  });

  it('follows the connection state, which fires no event', async () => {
    vi.useFakeTimers();
    try {
      let status: unknown = enrolled({ connection: 'connecting' });
      const link = makeLink(async () => status);
      platform = { burrow: link };
      await render();
      expect(text()).toContain('Connecting…');

      // `connecting -> connected` does not change `enrolled`, so the service
      // sends nothing. Only the poll notices.
      status = enrolled({ connection: 'connected' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(text()).toContain('Connected');
      expect(text()).not.toContain('Connecting…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an open setup code through a failed poll, and takes the next answer', async () => {
    let status: BurrowConsoleStatus | Error = enrolled();
    await openSetupPanel(() => {
      if (status instanceof Error) throw status;
      return status;
    });
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();

    status = new Error('bridge timed out');
    await act(async () => refreshBurrowStatus());
    expect(text()).not.toContain('Could not reach');
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();

    status = enrolled({ pairedClients: 2 });
    await act(async () => refreshBurrowStatus());
    expect(text()).toContain('2 paired phones.');
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();
  });

  it('stops polling once nothing is watching', async () => {
    vi.useFakeTimers();
    try {
      const link = makeLink(async () => enrolled());
      platform = { burrow: link };
      await render();
      await act(async () => root.unmount());

      const callsAtUnmount = link.command.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(link.command.mock.calls.length).toBe(callsAtUnmount);
      // Re-create the root so afterEach's unmount stays valid.
      root = createRoot(container);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a scannable setup code once the panel is opened', async () => {
    const link = makeLink(async (cmd) => (cmd === 'setupQr' ? qr() : enrolled()));
    platform = { burrow: link };
    await render();

    // Nothing is minted until someone asks: a code is a credential with a clock
    // on it, and one nobody is looking at is one nobody can scan.
    expect(link.command).not.toHaveBeenCalledWith('setupQr');
    await act(async () => buttonLabelled('Set up a phone')!.click());
    await settleQrChunk();

    expect(link.command).toHaveBeenCalledWith('setupQr');
    // What the code *is* belongs to `QrCode.test.tsx`; this is the section's
    // claim that a scannable one reached the panel with its clock.
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();
    expect(text()).toContain('Expires in 5 min');
  });

  it('renders a refused mint in the panel, leaving the view’s error slot alone', async () => {
    // The mint also fires on a timer, so it must not clear the enrolled view's
    // one error slot — where a Reconnect failure the user is reading lives.
    const link = makeLink(async (cmd) => {
      if (cmd === 'setupQr') throw new Error('could not mint a setup code (503)');
      if (cmd === 'reconnect') throw new Error('the relay refused this machine');
      return enrolled({ connection: 'displaced' });
    });
    platform = { burrow: link };
    await render();

    await act(async () => buttonLabelled('Reconnect')!.click());
    expect(text()).toContain('the relay refused this machine');

    await act(async () => buttonLabelled('Set up a phone')!.click());
    expect(text()).toContain('could not mint a setup code (503)');
    expect(text()).toContain('the relay refused this machine');
    // Still enrolled, still offering the retry.
    expect(buttonLabelled('New code')).toBeTruthy();
  });

  it('scrolls the setup code into view once it has drawn, not on every re-mint', async () => {
    const reveals = watchReveals();
    try {
      let mints = 0;
      const link = makeLink(async (cmd) => {
        if (cmd !== 'setupQr') return enrolled();
        mints += 1;
        return qr({ url: `https://laptop.tailnet.ts.net/#pair?token=code-${mints}`, inviteId: `invite-${mints}` });
      });
      platform = { burrow: link };
      await render();
      // The code is known before the encoder lands; revealing then would leave
      // the panel to grow back below the fold when the QR arrives.
      const land = holdQrChunk();
      await act(async () => buttonLabelled('Set up a phone')!.click());
      await settleQrChunk();
      expect(text()).toContain('Expires in');
      expect(reveals.drawnAtReveal).toEqual([]);
      await land();
      expect(reveals.drawnAtReveal).toEqual([true]);

      // A replacement code is a refresh, not something the person asked for.
      await act(async () => buttonLabelled('New code')!.click());
      await settleQrChunk();
      expect(mints).toBe(2);
      expect(reveals.drawnAtReveal).toEqual([true]);

      // A code where none showed — this one was spent — is a first one again.
      await act(async () => {
        link.emit('invitation', { name: 'invitation', inviteId: 'invite-2', state: 'reserved' });
      });
      expect(container.querySelector('svg[role="img"]')).toBeNull();
      await act(async () => buttonLabelled('New code')!.click());
      await settleQrChunk();
      expect(mints).toBe(3);
      expect(reveals.drawnAtReveal).toEqual([true, true]);
    } finally {
      reveals.restore();
    }
  });

  it('stops offering the invitation the phone used, and only that one', async () => {
    const link = await openSetupPanel();
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();

    // Another window's code was scanned. Every open panel hears the event, so
    // one that is showing a different invitation has to ignore it.
    await act(async () => {
      link.emit('invitation', {
        name: 'invitation',
        inviteId: 'someone-elses',
        state: 'reserved',
      });
    });
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();

    // The scan happens on the phone, so the Burrow's own invitation state is the
    // only way this panel can learn of it. `reserved` is the flip that matters:
    // a phone has completed the handshake against this code, so it is spent
    // whatever the person at the laptop decides next.
    await act(async () => {
      link.emit('invitation', { name: 'invitation', inviteId: 'invite-1', state: 'reserved' });
    });
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(text()).toContain('A phone scanned this code.');
  });

  it('does not call a dropped invitation a scan', async () => {
    // The Burrow discards every held invitation when its relay socket goes, so a
    // wifi blip must not tell the user to finish on a phone that never asked
    // (`docs/specs/remote-security-model.md` → Pairing).
    const link = await openSetupPanel();
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();

    await act(async () => {
      link.emit('invitation', { name: 'invitation', inviteId: 'invite-1', state: 'dropped' });
    });
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(text()).toContain('no longer valid');
    expect(text()).not.toContain('A phone scanned this code.');
    // And the way out is still one click away.
    expect(buttonLabelled('New code')).toBeTruthy();
  });

  it('stops sending the user to a phone once the request is answered', async () => {
    // The panel sits behind the pairing modal, so this is the frame the user is
    // left looking at after approving — and `reserved`'s sentence ("it will ask
    // to pair") is a lie by then. The Burrow publishes `consumed` for every
    // terminal outcome, which is why the subscription outlives the QR.
    const link = await openSetupPanel();

    await act(async () => {
      link.emit('invitation', { name: 'invitation', inviteId: 'invite-1', state: 'reserved' });
    });
    expect(text()).toContain('A phone scanned this code.');

    await act(async () => {
      link.emit('invitation', { name: 'invitation', inviteId: 'invite-1', state: 'consumed' });
    });
    expect(text()).toContain('This setup code is finished.');
    expect(text()).not.toContain('A phone scanned this code.');
    expect(buttonLabelled('New code')).toBeTruthy();
  });

  // Four states reach this panel and only one of them means a phone is waiting.
  // `expired` in particular — the refresh timer runs late whenever the window
  // is backgrounded or the laptop wakes from sleep — must not read as a scan
  // (`docs/specs/remote-security-model.md` → Pairing).
  it.each([
    ['reserved', 'A phone scanned this code.', 'nobody scanned it'],
    ['consumed', 'This setup code is finished.', 'nobody scanned it'],
    ['dropped', 'This code is no longer valid — nobody scanned it.', 'A phone scanned this code.'],
    ['expired', 'This code expired — nobody scanned it.', 'A phone scanned this code.'],
  ])('reads a %s invitation as the fact it is', async (state, expected, forbidden) => {
    const link = await openSetupPanel();

    await act(async () => {
      link.emit('invitation', { name: 'invitation', inviteId: 'invite-1', state });
    });
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(text()).toContain(expected);
    expect(text()).not.toContain(forbidden);
    // And the way out is always one click away.
    expect(buttonLabelled('New code')).toBeTruthy();
  });

  // The panel is behind the modal for the whole ceremony, so the sentence it is
  // left showing is the only report the person at this machine gets: the count
  // above it is absolute, and does not move when a mistyped code pairs nothing.
  it.each([
    ['paired', 'This phone is paired with this machine.'],
    ['code-mismatch', 'The two digits did not match, so nothing was paired.'],
    ['cancelled', 'You cancelled this request, so nothing was paired.'],
    ['expired', 'The request ran out of time, so nothing was paired.'],
    ['superseded', 'Another pairing request replaced this one, so nothing was paired.'],
    ['burrow-error', 'This machine could not finish pairing, so nothing was paired.'],
  ])('says a %s ceremony ended that way, in an announced region', async (outcome, expected) => {
    const link = await openSetupPanel();

    await act(async () => {
      link.emit('invitation', {
        name: 'invitation',
        inviteId: 'invite-1',
        state: 'consumed',
        outcome,
      });
    });

    expect(outcomeRegion()?.textContent).toContain(expected);
    // The code is gone and nothing on screen has replaced it, so every failure
    // ends by saying so. A pairing spent nothing the user has to replace.
    const spent = 'This setup code is spent';
    expect(outcomeRegion()?.textContent?.includes(spent)).toBe(outcome !== 'paired');
    // The sentence the Burrow used to leave behind for every one of these.
    expect(text()).not.toContain('This setup code is finished.');
    expect(buttonLabelled('New code')).toBeTruthy();
  });

  // The service is typed to send a member of the closed set, so these are a
  // bridge sending something else — and reporting a ceremony ended while saying
  // nothing about it would be worse than the old, vaguer sentence. `toString`
  // is the case an `in` check answers "yes" to: it is on every object's
  // prototype, and the copy table would hand back a function to render.
  it.each(['sideways', 'toString', 'constructor'])(
    'falls back to the state when the outcome is %s, which this build has no sentence for',
    async (outcome) => {
      const link = await openSetupPanel();

      await act(async () => {
        link.emit('invitation', {
          name: 'invitation',
          inviteId: 'invite-1',
          state: 'consumed',
          outcome,
        });
      });

      expect(outcomeRegion()).toBeNull();
      expect(text()).toContain('This setup code is finished.');
    },
  );

  // The same hole one field over: `TERMINAL_PHASE` is looked up with a state off
  // the same bridge, and a phase that is not one of the four used to leave the
  // panel saying "Getting a code…" about a code that is gone.
  it.each(['sideways', 'toString'])(
    'treats %s as a terminal state rather than a code still coming',
    async (state) => {
      const link = await openSetupPanel();

      await act(async () => {
        link.emit('invitation', { name: 'invitation', inviteId: 'invite-1', state });
      });

      expect(text()).toContain('This setup code is finished.');
      expect(text()).not.toContain('Getting a code');
      // The one sentence that must never be shown for a code nobody touched.
      expect(text()).not.toContain('A phone scanned this code');
    },
  );

  // The nine outcome stories drive the panel through `makeStubBurrowLink`'s
  // `setupOutcome`, and no test in this suite touches that path — Storybook's
  // play functions do not run in `pnpm test`, so a change to the stub would
  // break every one of them silently. These two are that path's unit test: one
  // per placement, mirroring `PairingOutcomeWithPanelClosed` and its siblings.
  it('drives the section report from the primed stub, panel shut', async () => {
    platform = {
      burrow: makeStubBurrowLink({
        status: enrolledStatus(),
        setupOutcome: 'code-mismatch',
      }),
    };
    await render();
    await settleQrChunk();

    expect(outcomeRegion()?.textContent).toContain('The two digits did not match');
    expect(outcomeRegion()?.textContent).toContain('This setup code is spent');
  });

  it('drives the panel report from the primed stub, panel open', async () => {
    platform = {
      burrow: makeStubBurrowLink({ status: enrolledStatus(), setupOutcome: 'paired' }),
    };
    await render();
    await act(async () => buttonLabelled('Set up a phone')!.click());
    await settleQrChunk();
    await settleQrChunk();

    expect(outcomeRegion()?.textContent).toContain('This phone is paired with this machine.');
    expect(text()).not.toContain('This setup code is finished.');
  });

  it('reports the outcome under the section when the panel was never opened', async () => {
    // The modal interrupts whatever is on screen, so the request can be
    // answered from a Settings dialog that never opened this panel.
    const link = makeLink(async () => enrolled({ pairedClients: 0 }));
    platform = { burrow: link };
    await render();

    await act(async () => {
      link.emit('invitation', {
        name: 'invitation',
        inviteId: 'someone-elses',
        state: 'consumed',
        outcome: 'code-mismatch',
      });
    });

    expect(outcomeRegion()?.textContent).toContain('The two digits did not match');
    expect(text()).toContain('No phone has paired with this machine yet.');
  });

  it('clears the last report when the user takes the new code it asked for', async () => {
    const link = await openSetupPanel();
    await act(async () => {
      link.emit('invitation', {
        name: 'invitation',
        inviteId: 'invite-1',
        state: 'consumed',
        outcome: 'code-mismatch',
      });
    });
    expect(outcomeRegion()).toBeTruthy();

    await act(async () => buttonLabelled('New code')!.click());
    await settleQrChunk();
    expect(outcomeRegion()).toBeNull();
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();
  });

  it('keeps the last report through the refresh the panel arms for itself', async () => {
    // The mint the timer runs is not the user taking a new code. Clearing the
    // report is an acknowledgement, and the panel replaces its own code
    // anywhere from 30 s to nearly the whole TTL later — so a shared clear
    // erased the sentence unread, leaving the absolute paired count, which does
    // not move for any failure, as the only thing that had said anything.
    vi.useFakeTimers();
    try {
      const link = mintingLink();
      platform = { burrow: link };
      await render();
      await act(async () => buttonLabelled('Set up a phone')!.click());
      expect(mintCount(link)).toBe(1);

      // An older ceremony, answered after this panel had moved on — the
      // placement that leaves the report beside a live code in the first place.
      await act(async () => {
        link.emit('invitation', {
          name: 'invitation',
          inviteId: 'a-code-this-panel-replaced',
          state: 'consumed',
          outcome: 'code-mismatch',
        });
      });
      expect(outcomeRegion()?.textContent).toContain('The two digits did not match');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(290_000);
      });
      expect(mintCount(link)).toBe(2);
      expect(outcomeRegion()?.textContent).toContain('The two digits did not match');

      // The same mint, asked for, still is an acknowledgement.
      await act(async () => buttonLabelled('New code')!.click());
      expect(mintCount(link)).toBe(3);
      expect(outcomeRegion()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the last report when the user closes the panel it was shown in', async () => {
    // Done is the user acknowledging it. Left set, the same sentence would move
    // to the section under a panel that is gone, with nothing but a fresh mint
    // able to clear it.
    const link = await openSetupPanel();
    await act(async () => {
      link.emit('invitation', {
        name: 'invitation',
        inviteId: 'invite-1',
        state: 'consumed',
        outcome: 'code-mismatch',
      });
    });
    expect(outcomeRegion()).toBeTruthy();

    await act(async () => buttonLabelled('Done')!.click());
    expect(outcomeRegion()).toBeNull();
    expect(text()).not.toContain('The two digits did not match');
  });

  it('reports an outcome that lands while the panel already shows a newer code', async () => {
    // The subscription takes an outcome from whichever invitation carries one,
    // because the modal can be answered after the panel has moved on — so the
    // report goes to the section rather than nowhere.
    const link = await openSetupPanel();

    await act(async () => {
      link.emit('invitation', {
        name: 'invitation',
        inviteId: 'a-code-this-panel-replaced',
        state: 'consumed',
        outcome: 'code-mismatch',
      });
    });

    expect(outcomeRegion()?.textContent).toContain('The two digits did not match');
    // Exactly one region: the panel is still drawing its own live code.
    expect(
      container.querySelectorAll(`[role="status"][aria-label="${PAIRING_OUTCOME_LABEL}"]`),
    ).toHaveLength(1);
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();
    // And it does not tell them to go and get the code they are looking at.
    expect(outcomeRegion()?.textContent).not.toContain('get a new one and try again');
  });

  it('drops the panel when the machine enrolls somewhere else under it', async () => {
    // A code belongs to the Relay that minted it. The console hook can swap
    // enrollments with this dialog open, and a QR left on screen would point a
    // camera at a machine this one no longer talks to.
    vi.useFakeTimers();
    try {
      let status: unknown = enrolled();
      const link = makeLink(async (cmd) => (cmd === 'setupQr' ? qr() : status));
      platform = { burrow: link };
      await render();

      await act(async () => buttonLabelled('Set up a phone')!.click());
      await settleQrChunk();
      expect(container.querySelector('svg[role="img"]')).toBeTruthy();

      status = enrolled({ burrowId: 'burrow-2', relayOrigin: 'https://other.tailnet.ts.net' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(container.querySelector('svg[role="img"]')).toBeNull();
      expect(buttonLabelled('Set up a phone')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  /** A link whose `setupQr` answers a code that always dies `ttlMs` out. */
  function mintingLink(ttlMs = 300_000) {
    let minted = 0;
    return makeLink(async (cmd) => {
      if (cmd === 'setupQr') {
        minted += 1;
        return qr({
          url: `https://x/#pair?token=t${minted}&nonce=n${minted}`,
          inviteId: `invite-${minted}`,
          expiresAt: Date.now() + ttlMs,
        });
      }
      return enrolled();
    });
  }

  const mintCount = (link: ReturnType<typeof makeLink>) =>
    link.command.mock.calls.filter(([cmd]) => cmd === 'setupQr').length;

  it('replaces the code once, shortly before it expires', async () => {
    vi.useFakeTimers();
    try {
      const link = mintingLink();
      platform = { burrow: link };
      await render();
      await act(async () => buttonLabelled('Set up a phone')!.click());
      expect(mintCount(link)).toBe(1);

      // The panel can sit open while someone goes to find their phone, so it
      // replaces the code rather than going quietly unscannable — and once the
      // lead is crossed, not once per tick from there on.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(290_000);
      });
      expect(mintCount(link)).toBe(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mintCount(link)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts down on the minute, since minutes are all it names', async () => {
    vi.useFakeTimers();
    try {
      platform = { burrow: mintingLink() };
      await render();
      await act(async () => buttonLabelled('Set up a phone')!.click());
      expect(text()).toContain('Expires in 5 min');

      // Half a minute in, there is nothing to repaint; the panel wakes on the
      // boundary where the number actually changes rather than once a second.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(text()).toContain('Expires in 5 min');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(text()).toContain('Expires in 4 min');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets New code disarm the refresh the old code armed', async () => {
    // Every mint spends a code on the Relay, so the timer armed against the
    // code being replaced must not fire on top of the replacement.
    vi.useFakeTimers();
    try {
      const link = mintingLink();
      platform = { burrow: link };
      await render();
      await act(async () => buttonLabelled('Set up a phone')!.click());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100_000);
      });
      await act(async () => buttonLabelled('New code')!.click());
      expect(mintCount(link)).toBe(2);

      // Past where the first code's refresh was armed for, and nothing fires:
      // that timer belongs to a code the panel no longer shows.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200_000);
      });
      expect(mintCount(link)).toBe(2);
      // The replacement armed its own, on its own expiry.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100_000);
      });
      expect(mintCount(link)).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never re-mints in a loop when the two clocks disagree', async () => {
    // `expiresAt` is the Relay's clock and the subtraction is against this
    // one's. A laptop minutes fast computes a delay at or below zero, and the
    // unclamped version re-minted several times a second — each one spending a
    // real single-use token.
    vi.useFakeTimers();
    try {
      const link = mintingLink(-600_000);
      platform = { burrow: link };
      await render();
      await act(async () => buttonLabelled('Set up a phone')!.click());
      expect(mintCount(link)).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_000);
      });
      expect(mintCount(link)).toBe(1);
      // One replacement on the floor, and the next not until the floor again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(mintCount(link)).toBe(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_000);
      });
      expect(mintCount(link)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes by the real TTL when the Relay clock is far ahead', async () => {
    // Ten minutes of negative webview skew makes a five-minute Relay token
    // look fifteen minutes long. It still needs replacement before its real
    // five-minute expiry, with the ordinary 20-second lead.
    vi.useFakeTimers();
    try {
      const link = mintingLink(900_000);
      platform = { burrow: link };
      await render();
      await act(async () => buttonLabelled('Set up a phone')!.click());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(279_000);
      });
      expect(mintCount(link)).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(mintCount(link)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the old code on screen while its replacement is on the wire', async () => {
    // The refresh lead exists so a camera mid-scan still has something live to
    // read; blanking to "Getting a code…" would defeat it.
    vi.useFakeTimers();
    try {
      let release: ((result: unknown) => void) | null = null;
      let minted = 0;
      const link = makeLink(async (cmd) => {
        if (cmd !== 'setupQr') return enrolled();
        minted += 1;
        if (minted === 1) return qr({ expiresAt: Date.now() + 300_000 });
        return new Promise<unknown>((resolve) => {
          release = resolve;
        });
      });
      platform = { burrow: link };
      await render();

      await act(async () => buttonLabelled('Set up a phone')!.click());
      await settleQrChunk();
      const first = container.querySelector('svg[role="img"]');
      expect(first).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(290_000);
      });
      expect(mintCount(link)).toBe(2);
      // Still the old code, still scannable, no spinner copy.
      expect(container.querySelector('svg[role="img"]')).toBe(first);
      expect(text()).not.toContain('Getting a code…');

      await act(async () => {
        release!(
          qr({
            url: 'https://x/#pair?token=t2&nonce=n2',
            inviteId: 'invite-2',
            expiresAt: Date.now() + 300_000,
          }),
        );
      });
      await settleQrChunk();
      expect(container.querySelector('svg[role="img"]')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('blanks only for the first mint, which has nothing to keep up', async () => {
    let release: (result: unknown) => void = () => {};
    const link = makeLink(async (cmd) => {
      if (cmd === 'setupQr') {
        return new Promise<unknown>((resolve) => {
          release = resolve;
        });
      }
      return enrolled();
    });
    platform = { burrow: link };
    await render();

    await act(async () => buttonLabelled('Set up a phone')!.click());
    expect(text()).toContain('Getting a code…');

    // And the token exists on the Relay either way; what must not happen is a
    // live code rendering into a panel the user already dismissed.
    await act(async () => buttonLabelled('Done')!.click());
    await act(async () => {
      release(qr({ url: 'https://x/#pair?token=late&nonce=late' }));
    });
    await settleQrChunk();

    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(text()).not.toContain('Getting a code…');
  });

  it('contains a code that cannot be drawn, instead of taking the window down', async () => {
    // Drawing throws two ways — a chunk fetch that fails, and a URL past the QR
    // format's capacity — and neither may reach the app-wide ErrorBoundary,
    // which takes every terminal with it. The oversized URL is the one a test
    // can produce; the boundary is the same one.
    let oversized = true;
    const link = makeLink(async (cmd) => {
      if (cmd !== 'setupQr') return enrolled();
      return oversized ? qr({ url: `https://x/#pair?token=${'A'.repeat(5000)}` }) : qr();
    });
    // React logs a caught render error; catching it is the point of the test.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      platform = { burrow: link };
      await render();
      await act(async () => buttonLabelled('Set up a phone')!.click());
      await settleQrChunk();

      expect(text()).toContain('Couldn’t display the code');
      // The panel is still a panel: only the code failed.
      expect(buttonLabelled('New code')).toBeTruthy();
      expect(buttonLabelled('Done')).toBeTruthy();

      // Retrying the same URL cannot help, and must not pretend to.
      await act(async () => buttonLabelled('Try again')!.click());
      await settleQrChunk();
      expect(text()).toContain('Couldn’t display the code');

      // A new code is the recovery, so a boundary that already caught has to
      // remount when the URL changes under it.
      oversized = false;
      await act(async () => buttonLabelled('New code')!.click());
      await settleQrChunk();
      expect(container.querySelector('svg[role="img"]')).toBeTruthy();
    } finally {
      errors.mockRestore();
    }
  });

  it('pins the story stub both panel states are driven from', async () => {
    // The `SetupPhoneQr` / `SetupPhoneRedeemed` stories drive the section
    // through `makeStubBurrowLink` and nothing else, so a fixture that
    // stopped answering `setupQr` — or stopped firing the invitation event —
    // would fail only in Chromatic. The states themselves are covered above, so
    // this pins the fixture rather than re-rendering them.
    const link = makeStubBurrowLink({
      status: enrolledStatus(),
      setupQr: setupQrResult({ expiresAt: NOW + 300_000 }),
    });
    expect(await link.command('setupQr')).toMatchObject({ expiresAt: NOW + 300_000 });

    // The used-up state has to name the invitation the stub's own `setupQr`
    // answered, and carry a state other than `live` — the panel ignores both a
    // stranger's id and a code that is still good.
    const used = setupQrResult();
    const events: unknown[] = [];
    makeStubBurrowLink({
      status: enrolledStatus(),
      setupQr: used,
      setupInvitation: 'reserved',
    }).on('invitation', (data) => void events.push(data));
    await Promise.resolve();
    expect(events).toEqual([
      { name: 'invitation', inviteId: used.inviteId, state: 'reserved' },
    ]);
  });

  it('re-reads the status when the service announces a change', async () => {
    let status: unknown = SELF_HOST_NOT_ENROLLED;
    const link = makeLink(async () => status);
    platform = { burrow: link };
    await render();
    await openPersistent();
    expect(text()).toContain('This Dormouse was built for this Relay:');

    // Another window enrolled: the event carries only `{ enrolled }`, so the
    // section must re-read rather than patch a field.
    status = enrolled();
    await act(async () => {
      link.emit('status', { name: 'status', enrolled: true });
    });
    expect(text()).toContain('https://laptop.tailnet.ts.net');
    expect(buttonLabelled('Persistent Relay')).toBeUndefined();
  });
});

/**
 * A link whose one-time half answers the way the service does
 * (`docs/specs/one-time.md` -> "Service and hosts"): `oneTimeOpen` moves
 * through `opening` to `waiting` and answers the settled state, `oneTimeEnd`
 * ends a live connection `user-ended` and returns an ended one to `idle`, and
 * every change is an event that arrives before the command's answer. With a
 * `policy`, `networkPolicy` answers it; without one, the panel reads no level.
 */
function oneTimeService(
  initial: OneTimeState = { status: 'idle' },
  {
    status = NOT_ENROLLED,
    openError,
    policy,
  }: { status?: BurrowConsoleStatus; openError?: string; policy?: NetworkPolicy } = {},
) {
  let state = initial;
  let links = 0;
  const service = {
    get state() {
      return state;
    },
    /** Move the connection as the runtime would, announcing it. */
    set(next: OneTimeState) {
      state = next;
      link.emit('one-time', { name: 'one-time', state });
    },
  };
  const link = makeLink(async (cmd) => {
    switch (cmd) {
      case 'oneTimeStatus':
        return state;
      case 'oneTimeOpen':
        if (openError) throw new Error(openError);
        service.set({ status: 'opening' });
        links += 1;
        service.set(oneTimeWaiting({ url: `https://relay.dormouse.sh/connect/#link-${links}` }));
        return state;
      case 'oneTimeEnd':
        if (state.status === 'ended') service.set({ status: 'idle' });
        else if (state.status !== 'idle' && state.status !== 'unavailable') {
          service.set({ status: 'ended', reason: 'user-ended' });
        }
        return {};
      case 'networkPolicy':
        return policy ? networkPolicyResult(policy, 'hosted', []) : status;
      default:
        return status;
    }
  });
  return Object.assign(service, { link });
}

/** Mount the section over `service` and let its one-time read land. */
async function renderOneTime(service: ReturnType<typeof oneTimeService>) {
  platform = { burrow: service.link };
  await render();
  await settleQrChunk();
}

function oneTimeCalls(link: ReturnType<typeof makeLink>, cmd: 'oneTimeOpen' | 'oneTimeEnd') {
  return link.command.mock.calls.filter(([name]) => name === cmd);
}

/** The region reporting how a one-time connection ended. */
function oneTimeOutcome(): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `[role="status"][aria-label="${ONE_TIME_OUTCOME_LABEL}"]`,
  );
}

function oneTimeCode(): Element | null {
  return container.querySelector('svg[role="img"][aria-label="One-time link for this machine"]');
}

describe('One-time connection', () => {
  it('opens a link from the button with no parameters, un-enrolled', async () => {
    const service = oneTimeService();
    await renderOneTime(service);

    await act(async () => buttonLabelled('One-time connection')!.click());
    await settleQrChunk();

    // The origin is this build's, never the webview's to name.
    expect(oneTimeCalls(service.link, 'oneTimeOpen')).toEqual([['oneTimeOpen']]);
    expect(oneTimeCode()).toBeTruthy();
    expect(text()).toContain('https://relay.dormouse.sh/connect/#link-1');
    expect(text()).toContain('Good for one phone. Expires in 5 min.');
    expect(buttonLabelled('Copy link')).toBeTruthy();
    expect(buttonLabelled('New link')).toBeTruthy();
    expect(buttonLabelled('Cancel')).toBeTruthy();
    expect(buttonLabelled('One-time connection')).toBeUndefined();
  });

  it('opens the same panel on an enrolled machine, beside Set up a phone', async () => {
    const service = oneTimeService({ status: 'idle' }, { status: enrolled() });
    await renderOneTime(service);
    expect(buttonLabelled('Set up a phone')).toBeTruthy();

    await act(async () => buttonLabelled('One-time connection')!.click());
    await settleQrChunk();
    expect(oneTimeCode()).toBeTruthy();
    expect(buttonLabelled('Set up a phone')).toBeTruthy();
  });

  it('shows a link another window opened, and keeps it when Settings closes', async () => {
    const service = oneTimeService(oneTimeWaiting());
    await renderOneTime(service);
    expect(oneTimeCode()).toBeTruthy();

    // Closing the dialog unmounts the section; the link lives in the service.
    await act(async () => root.unmount());
    expect(oneTimeCalls(service.link, 'oneTimeEnd')).toEqual([]);
    root = createRoot(container);
  });

  it('shows the open in flight before any event, and lets Cancel end it', async () => {
    // A VS Code window that must first become the broker hears nothing until
    // the service exists, so the panel cannot wait on an event to say so.
    let release: (state: OneTimeState) => void = () => {};
    const link = makeLink(async (cmd) => {
      if (cmd === 'oneTimeOpen') return new Promise((resolve) => (release = resolve));
      if (cmd === 'oneTimeStatus') return { status: 'idle' };
      return NOT_ENROLLED;
    });
    platform = { burrow: link };
    await render();

    await act(async () => buttonLabelled('One-time connection')!.click());
    expect(text()).toContain('Getting a link…');
    expect(buttonLabelled('Cancel')!.disabled).toBe(false);
    await act(async () => buttonLabelled('Cancel')!.click());
    expect(oneTimeCalls(link, 'oneTimeEnd')).toHaveLength(1);

    await act(async () => release({ status: 'ended', reason: 'user-ended' }));
    expect(buttonLabelled('One-time connection')).toBeTruthy();
  });

  it('renders a refused open inline, under the button', async () => {
    const service = oneTimeService(
      { status: 'idle' },
      { openError: 'A phone is already connected through a one-time link. End it before opening another.' },
    );
    await renderOneTime(service);

    await act(async () => buttonLabelled('One-time connection')!.click());
    expect(text()).toContain('A phone is already connected through a one-time link.');
    expect(buttonLabelled('One-time connection')!.disabled).toBe(false);
  });

  it('counts down on the minute and never opens another link on its own', async () => {
    vi.useFakeTimers();
    try {
      // Single-use: a replacement would be a second link nobody asked for, and
      // the service ends the first one `expired` on its own clock.
      const service = oneTimeService(oneTimeWaiting({ expiresAt: Date.now() + 300_000 }));
      await renderOneTime(service);
      expect(text()).toContain('Expires in 5 min.');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(text()).toContain('Expires in 4 min.');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600_000);
      });
      expect(text()).toContain('This link has expired — get a new one.');
      expect(oneTimeCalls(service.link, 'oneTimeOpen')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a waiting link only on New link', async () => {
    const service = oneTimeService(oneTimeWaiting({ url: 'https://relay.dormouse.sh/connect/#old' }));
    await renderOneTime(service);

    await act(async () => buttonLabelled('New link')!.click());
    await settleQrChunk();
    expect(oneTimeCalls(service.link, 'oneTimeOpen')).toHaveLength(1);
    expect(text()).toContain('https://relay.dormouse.sh/connect/#link-1');
    expect(text()).not.toContain('#old');
  });

  it('scrolls each new link into view once its code has drawn, and leaves the dialog alone otherwise', async () => {
    // Settings' Remote control choices sit at the bottom of a scrolling
    // dialog, so the QR arrives below the fold (seen in QC, 2026-09-29).
    const reveals = watchReveals();
    try {
      const service = oneTimeService();
      await renderOneTime(service);
      expect(reveals.drawnAtReveal).toEqual([]);

      // A session's first open: the link is there before the encoder chunk.
      const land = holdQrChunk();
      await act(async () => buttonLabelled('One-time connection')!.click());
      await settleQrChunk();
      expect(text()).toContain('#link-1');
      expect(reveals.drawnAtReveal).toEqual([]);
      await land();
      expect(reveals.drawnAtReveal).toEqual([true]);

      await act(async () => buttonLabelled('New link')!.click());
      await settleQrChunk();
      expect(text()).toContain('#link-2');
      expect(reveals.drawnAtReveal).toEqual([true, true]);
    } finally {
      reveals.restore();
    }
  });

  it('goes straight back to the button on Cancel, with nothing to report', async () => {
    const service = oneTimeService(oneTimeWaiting());
    await renderOneTime(service);

    await act(async () => buttonLabelled('Cancel')!.click());
    expect(oneTimeCalls(service.link, 'oneTimeEnd')).toHaveLength(1);
    expect(service.state).toEqual({ status: 'ended', reason: 'user-ended' });
    expect(oneTimeCode()).toBeNull();
    expect(oneTimeOutcome()).toBeNull();
    expect(buttonLabelled('One-time connection')!.disabled).toBe(false);
  });

  it('copies the link, and says when the clipboard refuses', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const waiting = oneTimeWaiting();
      await renderOneTime(oneTimeService(waiting));

      await act(async () => buttonLabelled('Copy link')!.click());
      expect(writeText).toHaveBeenCalledWith(waiting.url);
      expect(buttonLabelled('Copied')).toBeTruthy();

      writeText.mockRejectedValueOnce(new Error('denied'));
      await act(async () => buttonLabelled('Copied')!.click());
      expect(buttonLabelled('Couldn’t copy')).toBeTruthy();
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('follows the connection through the service’s events', async () => {
    const service = oneTimeService(oneTimeWaiting());
    await renderOneTime(service);

    await act(async () => service.set({ status: 'confirming', label: 'Pixel 9', expiresAt: NOW + 60_000 }));
    expect(text()).toContain('Type the two digits your phone shows into the dialog.');
    expect(oneTimeCode()).toBeNull();

    await act(async () => service.set({ status: 'connecting', label: 'Pixel 9' }));
    expect(text()).toContain('Connecting directly…');
    expect(buttonLabelled('Cancel')).toBeTruthy();

    await act(async () => service.set({ status: 'connected', label: 'Pixel 9', since: NOW }));
    expect(text()).toContain('Pixel 9 has full control of your terminals.');

    // A bridge relaying something else under the name is not a state.
    await act(async () => {
      service.link.emit('one-time', { name: 'one-time', state: { status: 'connected' } });
    });
    expect(text()).toContain('Pixel 9 has full control of your terminals.');
  });

  it('ends a live connection from End', async () => {
    const service = oneTimeService({ status: 'connected', label: 'Pixel 9', since: NOW });
    await renderOneTime(service);

    await act(async () => buttonLabelled('End')!.click());
    expect(oneTimeCalls(service.link, 'oneTimeEnd')).toHaveLength(1);
    expect(text()).not.toContain('has full control');
    expect(buttonLabelled('One-time connection')).toBeTruthy();
  });

  it('cancels a pending confirmation, which dismisses the modal with it', async () => {
    const service = oneTimeService({ status: 'confirming', label: 'Pixel 9', expiresAt: NOW + 60_000 });
    await renderOneTime(service);

    await act(async () => buttonLabelled('Cancel')!.click());
    expect(oneTimeCalls(service.link, 'oneTimeEnd')).toHaveLength(1);
    expect(buttonLabelled('One-time connection')).toBeTruthy();
  });

  it('reports every other ending in its own fixed sentence', async () => {
    const copy = oneTimeEndedCopy(hostOf(NOT_ENROLLED.relayOrigin), false);
    const reasons = Object.keys(copy) as Array<Exclude<OneTimeEndReason, 'user-ended'>>;
    expect(new Set(Object.values(copy)).size).toBe(reasons.length);
    for (const reason of reasons) {
      const service = oneTimeService({ status: 'ended', reason });
      await renderOneTime(service);
      expect(oneTimeOutcome()?.textContent).toBe(copy[reason]);
      expect(buttonLabelled('New link')).toBeTruthy();
      expect(buttonLabelled('Done')).toBeTruthy();
      await act(async () => root.unmount());
      root = createRoot(container);
    }
    // The failure this whole feature is most likely to hit names its fix.
    expect(copy['direct-failed']).toContain('allowed network');
  });

  it('names where the phone connected from when the path ended it, in the Network panel’s words', async () => {
    const refusal = { at: NOW, kind: 'path-refused', end: 'remote', address: '172.58.12.9', addressSource: 'observed' } as const;
    await renderOneTime(oneTimeService({ status: 'ended', reason: 'network-not-allowed', refusal }));
    expect(oneTimeOutcome()?.textContent).toBe(pathRefusalSentence(refusal, 'one-time'));
    expect(oneTimeOutcome()?.textContent).toContain('172.58.12.9');
  });

  it('names the rendezvous by this build’s relay host, a dev build’s included', async () => {
    const status = { ...NOT_ENROLLED, relayOrigin: 'http://localhost:8787' };
    for (const [reason, sentence] of [
      ['unreachable', 'Couldn’t reach localhost:8787 to make a link.'],
      ['rendezvous-lost', 'The connection to localhost:8787 dropped'],
    ] as const) {
      await renderOneTime(oneTimeService({ status: 'ended', reason }, { status }));
      expect(oneTimeOutcome()?.textContent).toContain(sentence);
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it.each<[string, NetworkPolicy, string, RegExp]>([
    ['Local networks', LOCAL_ON, 'Your phone must be on an allowed network.', /Make sure it is on an allowed network/],
    // Anywhere has no allowed network to name, so its fix is another network.
    ['Anywhere', ANYWHERE_ON, 'Your phone can be on any network.', /Try the phone on another network, such as cellular/],
  ])(
    'says where the phone may be under %s, and what to try when no direct path forms',
    async (_, policy, where, directFailed) => {
      const service = oneTimeService({ status: 'idle' }, { policy });
      await renderOneTime(service);
      expect(text()).toContain(`Open a link on your phone for a one-off connection. ${where} No account needed.`);

      await act(async () => buttonLabelled('One-time connection')!.click());
      await settleQrChunk();
      expect(text()).toContain(`open the link below on it. ${where}`);

      await act(async () => service.set({ status: 'ended', reason: 'direct-failed' }));
      expect(oneTimeOutcome()?.textContent).toMatch(directFailed);
    },
  );

  it('reads a policy it has not read as an allowed network', async () => {
    // Which levels mean any network is `phoneOnAnyNetwork`'s; the panel can
    // hold a state before the policy's answer lands.
    const service = oneTimeService({ status: 'ended', reason: 'direct-failed' });
    await renderOneTime(service);
    expect(oneTimeOutcome()?.textContent).toBe(oneTimeEndedCopy(hostOf(NOT_ENROLLED.relayOrigin), false)['direct-failed']);
    await act(async () => service.set({ status: 'idle' }));
    expect(text()).toContain('Your phone must be on an allowed network.');
  });

  it('falls back for a reason this build has no sentence for, prototype names included', async () => {
    for (const reason of ['a-newer-reason', 'toString']) {
      const service = oneTimeService({ status: 'ended', reason } as unknown as OneTimeState);
      await renderOneTime(service);
      expect(oneTimeOutcome()?.textContent).toBe('The one-time connection ended.');
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it('returns an ended connection to the button on Done', async () => {
    const service = oneTimeService({ status: 'ended', reason: 'direct-failed' });
    await renderOneTime(service);

    await act(async () => buttonLabelled('Done')!.click());
    expect(oneTimeCalls(service.link, 'oneTimeEnd')).toHaveLength(1);
    expect(service.state).toEqual({ status: 'idle' });
    expect(oneTimeOutcome()).toBeNull();
    expect(buttonLabelled('One-time connection')).toBeTruthy();
  });

  it('opens another link from an ended one', async () => {
    const service = oneTimeService({ status: 'ended', reason: 'phone-left' });
    await renderOneTime(service);

    await act(async () => buttonLabelled('New link')!.click());
    await settleQrChunk();
    expect(oneTimeCalls(service.link, 'oneTimeOpen')).toHaveLength(1);
    expect(oneTimeCode()).toBeTruthy();
  });

  it('disables the button in a self-host build, saying why', async () => {
    await renderOneTime(
      oneTimeService({ status: 'unavailable', reason: 'self-host' }, { status: SELF_HOST_NOT_ENROLLED }),
    );
    expect(buttonLabelled('One-time connection')!.disabled).toBe(true);
    // Its own origin is its Relay; links are made at the stock build's.
    expect(text()).toContain(
      `Not available in a self-host build: one-time links are made at ${hostOf(DEFAULT_RELAY_ORIGIN)}, which`,
    );
    expect(text()).not.toContain('Open a link on your phone');
  });

  it('renders a reason this build does not know with the fallback', async () => {
    // A newer VS Code broker in another window may name a reason this build lacks.
    await renderOneTime(oneTimeService({ status: 'unavailable', reason: 'a-newer-reason' } as never));
    expect(buttonLabelled('One-time connection')!.disabled).toBe(true);
    expect(text()).toContain('Not available in this build.');
    expect(text()).not.toContain('Open a link on your phone');
  });

  it('re-reads on open, past a first read the Baseboard is still holding', async () => {
    // The Baseboard's indicator keeps the store subscribed for the window's
    // life, so a read that failed at boot is still the store's answer when
    // Settings opens — unless the panel asks again.
    let booting = true;
    const link = makeLink(async (cmd) => {
      if (cmd === 'oneTimeStatus' && booting) throw new Error('the sidecar is not up yet');
      return NOT_ENROLLED;
    });
    platform = { burrow: link };
    const baseboard = subscribeToOneTime(() => {});
    try {
      await act(async () => {});
      expect(getOneTimeSnapshot().kind).toBe('error');

      booting = false;
      await render();
      expect(text()).not.toContain('the sidecar is not up yet');
      expect(buttonLabelled('One-time connection')!.disabled).toBe(false);
    } finally {
      baseboard();
    }
  });

  it('says so when the service will not report the connection', async () => {
    const link = makeLink(async (cmd) => {
      if (cmd === 'oneTimeStatus') throw new Error('unknown burrow command: oneTimeStatus');
      return NOT_ENROLLED;
    });
    platform = { burrow: link };
    await render();
    expect(text()).toContain(
      'Could not check this machine’s one-time connection: unknown burrow command: oneTimeStatus',
    );
  });
});
