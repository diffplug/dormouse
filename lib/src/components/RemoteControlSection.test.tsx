/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The store reads `getPlatform().remoteHost`, so the link is the only seam the
 * whole section hangs off. Mutable so a test can present a build with no Host
 * service behind it, which is a rendering decision rather than an error.
 */
let platform: { remoteHost?: unknown } = {};

vi.mock('../lib/platform', () => ({
  IS_MAC: false,
  getPlatform: () => platform,
}));

import { PAIRING_OUTCOME_LABEL, RemoteControlSection } from './RemoteControlSection';
import type { RemoteHostConsoleStatus, SetupQrResult } from '../host/remote/service-protocol';
import {
  enrolledStatus,
  makeStubRemoteHostLink,
  OFFER_STATUS,
  setupQrResult,
  UNENROLLED_STATUS as NOT_ENROLLED,
} from '../host/remote/test-remote-host-link';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (data: unknown) => void;

function makeLink(command: (cmd: string, params?: unknown) => Promise<unknown>) {
  const listeners = new Map<string, Set<Handler>>();
  return {
    command: vi.fn(command),
    on: vi.fn((name: string, listener: Handler) => {
      const set = listeners.get(name) ?? new Set<Handler>();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    }),
    respond: vi.fn(),
    notify: vi.fn(),
    emit(name: string, data: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(data);
    },
  };
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

/** The shared fixture, keeping this file's own server/host values. */
const enrolled = (over: Partial<RemoteHostConsoleStatus> = {}) =>
  enrolledStatus({
    serverUrl: 'https://laptop.tailnet.ts.net',
    hostId: 'host-1',
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
 * An enrolled machine with the panel open on a live code, handing back the link
 * so a case can drive invitation events against it.
 */
async function openSetupPanel(): Promise<ReturnType<typeof makeLink>> {
  const link = makeLink(async (cmd) => (cmd === 'setupQr' ? qr() : enrolled()));
  platform = { remoteHost: link };
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
    button.textContent?.includes('Enroll with a different server'),
  ) as HTMLButtonElement | undefined;
}

/**
 * The three-field form, which is always mounted: folding it away is the
 * `hidden` attribute, so what is typed into it survives both the disclosure and
 * an offer appearing on disk underneath it.
 */
function typedForm(): HTMLFormElement {
  const form = [...container.querySelectorAll('form')].find((candidate) =>
    candidate.textContent?.includes('Connect this machine to a Dormouse server'),
  );
  if (!form) throw new Error('the typed enroll form is not mounted');
  return form;
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
  vi.clearAllMocks();
});

describe('RemoteControlSection', () => {
  it('renders nothing on a build with no Host service', async () => {
    platform = {};
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('offers the enroll form when the machine is not enrolled', async () => {
    platform = { remoteHost: makeLink(async () => NOT_ENROLLED) };
    await render();
    expect(text()).toContain('Connect this machine to a Dormouse server');
    expect(buttonLabelled('Connect')).toBeTruthy();
  });

  it('keeps Connect disabled until every field is filled', async () => {
    platform = { remoteHost: makeLink(async () => NOT_ENROLLED) };
    await render();

    // The name arrives prefilled from the service's suggestion — the same one
    // the offer card uses, so the two paths cannot diverge on it.
    const name = 'input:not([type="url"]):not([type="password"])';
    expect(container.querySelector<HTMLInputElement>(name)!.value).toBe('ned-mac');
    expect(buttonLabelled('Connect')!.disabled).toBe(true);
    await type('input[type="url"]', 'https://laptop.tailnet.ts.net');
    expect(buttonLabelled('Connect')!.disabled).toBe(true);
    await type('input[type="password"]', 'hunter2');
    expect(buttonLabelled('Connect')!.disabled).toBe(false);
    // And it is still a required field, not a decoration.
    await type(name, '   ');
    expect(buttonLabelled('Connect')!.disabled).toBe(true);
  });

  it('enrolls with trimmed values and re-reads the status', async () => {
    let status: unknown = NOT_ENROLLED;
    const link = makeLink(async (cmd) => {
      if (cmd === 'enroll') {
        status = enrolled();
        return { hostId: 'host-1', serverUrl: 'https://laptop.tailnet.ts.net' };
      }
      return status;
    });
    platform = { remoteHost: link };
    await render();

    await type('input[type="url"]', '  https://laptop.tailnet.ts.net  ');
    await type('input[type="password"]', 'hunter2');
    await type('input:not([type="url"]):not([type="password"])', '  Work laptop  ');
    await act(async () => buttonLabelled('Connect')!.click());

    expect(link.command).toHaveBeenCalledWith('enroll', {
      serverUrl: 'https://laptop.tailnet.ts.net',
      password: 'hunter2',
      label: 'Work laptop',
    });
    // The status re-read after enrolling is what flips the view.
    expect(text()).toContain('https://laptop.tailnet.ts.net');
    expect(text()).toContain('Connected');
  });

  it('surfaces an enrollment refusal instead of silently failing', async () => {
    const link = makeLink(async (cmd) => {
      if (cmd === 'enroll') throw new Error('server origin is not allowed by this build');
      return NOT_ENROLLED;
    });
    platform = { remoteHost: link };
    await render();

    await type('input[type="url"]', 'https://evil.example.com');
    await type('input[type="password"]', 'hunter2');
    await type('input:not([type="url"]):not([type="password"])', 'Work laptop');
    await act(async () => buttonLabelled('Connect')!.click());

    expect(text()).toContain('server origin is not allowed by this build');
    // Still on the form, so the user can correct the origin and retry.
    expect(buttonLabelled('Connect')).toBeTruthy();
  });

  it('leads with the installer’s offer and folds the typed form away', async () => {
    platform = { remoteHost: makeLink(async () => OFFER_STATUS) };
    await render();

    expect(text()).toContain('A Dormouse server is installed on this machine.');
    expect(text()).toContain('https://ned-mac.tail9c2f1.ts.net');
    expect(buttonLabelled('Enroll')).toBeTruthy();
    // The three-field form is behind the disclosure, not beside the card —
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
        return { hostId: 'host-1', serverUrl: 'https://laptop.tailnet.ts.net' };
      }
      return status;
    });
    platform = { remoteHost: link };
    await render();

    // Prefilled from the service's suggestion, and the user overrode it.
    const input = container.querySelector<HTMLInputElement>('input:not([type])')!;
    expect(input.value).toBe('ned-mac');
    await type('input:not([type])', '  Work laptop  ');
    await act(async () => buttonLabelled('Enroll')!.click());

    // The origin is an echo of what the card displayed, so the service can
    // refuse a file rewritten since; no token, and the origin enrolled against
    // is still the file's.
    expect(link.command).toHaveBeenCalledWith('enrollOffer', {
      origin: 'https://ned-mac.tail9c2f1.ts.net',
      label: 'Work laptop',
    });
    expect(text()).toContain('https://laptop.tailnet.ts.net');
    expect(text()).toContain('Connected');
  });

  it('keeps a half-typed form when an offer appears underneath it', async () => {
    // The installer can run while this dialog is open, and the 2 s poll picks
    // the offer up. Folding the form away must not empty it.
    vi.useFakeTimers();
    try {
      let status: unknown = NOT_ENROLLED;
      platform = { remoteHost: makeLink(async () => status) };
      await render();

      await type('input[type="url"]', 'https://elsewhere.example');
      status = OFFER_STATUS;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(text()).toContain('A Dormouse server is installed on this machine.');
      expect(typedForm().hidden).toBe(true);
      expect(container.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe(
        'https://elsewhere.example',
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
          status = NOT_ENROLLED;
          return new Promise<unknown>((_resolve, reject) => {
            failEnroll = reject;
          });
        }
        return status;
      });
      platform = { remoteHost: link };
      await render();

      await act(async () => buttonLabelled('Enroll')!.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      // The card is still here, on the origin the user reviewed.
      expect(text()).toContain('https://ned-mac.tail9c2f1.ts.net');

      await act(async () => {
        failEnroll(new Error('The server did not accept that setup password.'));
        await Promise.resolve();
      });
      expect(text()).toContain('The server did not accept that setup password.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a one-click refusal where the typed form renders its own', async () => {
    const link = makeLink(async (cmd) => {
      if (cmd === 'enrollOffer') throw new Error('server origin is not allowed by this build');
      return OFFER_STATUS;
    });
    platform = { remoteHost: link };
    await render();

    await act(async () => buttonLabelled('Enroll')!.click());
    expect(text()).toContain('server origin is not allowed by this build');
    // Still on the card, and the typed form is still one click away.
    expect(buttonLabelled('Enroll')).toBeTruthy();
    expect(disclosure()).toBeTruthy();
  });

  it('unfolds the typed form for a server that is somewhere else', async () => {
    platform = { remoteHost: makeLink(async () => OFFER_STATUS) };
    await render();

    await act(async () => disclosure()!.click());
    expect(typedForm().hidden).toBe(false);
    expect(buttonLabelled('Connect')).toBeTruthy();
    expect(disclosure()?.textContent).toContain('−');
    // The offer stays offered — unfolding is not a rejection of it.
    expect(buttonLabelled('Enroll')).toBeTruthy();

    // And refolding hides what was typed rather than discarding it.
    await type('input[type="url"]', 'https://elsewhere.example');
    await act(async () => disclosure()!.click());
    expect(typedForm().hidden).toBe(true);
    await act(async () => disclosure()!.click());
    expect(container.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe(
      'https://elsewhere.example',
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
      if (cmd === 'enroll') return { hostId: 'wrong-racer', serverUrl: 'https://elsewhere' };
      return OFFER_STATUS;
    });
    platform = { remoteHost: link };
    await render();

    await act(async () => disclosure()!.click());
    await type('input[type="url"]', 'https://elsewhere.example');
    await type('input[type="password"]', 'hunter2');

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
      finishOffer({ hostId: 'host-1', serverUrl: OFFER_STATUS.offer!.origin });
      await Promise.resolve();
    });
  });

  it('shows the server and paired-device count when enrolled', async () => {
    platform = { remoteHost: makeLink(async () => enrolled({ pairedClients: 2 })) };
    await render();
    expect(text()).toContain('https://laptop.tailnet.ts.net');
    expect(text()).toContain('2 paired phones');
    expect(buttonLabelled('Reconnect')).toBeUndefined();
  });

  it('offers Reconnect only when the Host was displaced', async () => {
    const link = makeLink(async () => enrolled({ connection: 'displaced' }));
    platform = { remoteHost: link };
    await render();

    expect(text()).toContain('took this server’s slot');
    await act(async () => buttonLabelled('Reconnect')!.click());
    expect(link.command).toHaveBeenCalledWith('reconnect');
  });

  it('confirms before disconnecting, because paired phones must re-pair', async () => {
    const link = makeLink(async () => enrolled());
    platform = { remoteHost: link };
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
      platform = { remoteHost: link };
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

  it('stops polling once nothing is watching', async () => {
    vi.useFakeTimers();
    try {
      const link = makeLink(async () => enrolled());
      platform = { remoteHost: link };
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
    platform = { remoteHost: link };
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
    platform = { remoteHost: link };
    await render();

    await act(async () => buttonLabelled('Reconnect')!.click());
    expect(text()).toContain('the relay refused this machine');

    await act(async () => buttonLabelled('Set up a phone')!.click());
    expect(text()).toContain('could not mint a setup code (503)');
    expect(text()).toContain('the relay refused this machine');
    // Still enrolled, still offering the retry.
    expect(buttonLabelled('New code')).toBeTruthy();
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

    // The scan happens on the phone, so the Host's own invitation state is the
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
    // The Host discards every held invitation when its relay socket goes, so a
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
    // to pair") is a lie by then. The Host publishes `consumed` for every
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
    ['expired', 'The request expired before it was answered, so nothing was paired.'],
    ['superseded', 'Another pairing request replaced this one, so nothing was paired.'],
    ['host-error', 'This machine could not finish pairing, so nothing was paired.'],
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
    // The sentence the Host used to leave behind for every one of these.
    expect(text()).not.toContain('This setup code is finished.');
    expect(buttonLabelled('New code')).toBeTruthy();
  });

  it('falls back to the state when the outcome is one this build has no sentence for', async () => {
    // The service is typed to send a member of the closed set, so this is a
    // bridge sending something else — and reporting a ceremony ended while
    // saying nothing about it would be worse than the old, vaguer sentence.
    const link = await openSetupPanel();

    await act(async () => {
      link.emit('invitation', {
        name: 'invitation',
        inviteId: 'invite-1',
        state: 'consumed',
        outcome: 'sideways',
      });
    });

    expect(outcomeRegion()).toBeNull();
    expect(text()).toContain('This setup code is finished.');
  });

  it('reports the outcome under the section when the panel was never opened', async () => {
    // The modal interrupts whatever is on screen, so the request can be
    // answered from a Settings dialog that never opened this panel.
    const link = makeLink(async () => enrolled({ pairedClients: 0 }));
    platform = { remoteHost: link };
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

  it('drops the panel when the machine enrolls somewhere else under it', async () => {
    // A code belongs to the server that minted it. The console hook can swap
    // enrollments with this dialog open, and a QR left on screen would point a
    // camera at a machine this one no longer talks to.
    vi.useFakeTimers();
    try {
      let status: unknown = enrolled();
      const link = makeLink(async (cmd) => (cmd === 'setupQr' ? qr() : status));
      platform = { remoteHost: link };
      await render();

      await act(async () => buttonLabelled('Set up a phone')!.click());
      await settleQrChunk();
      expect(container.querySelector('svg[role="img"]')).toBeTruthy();

      status = enrolled({ hostId: 'host-2', serverUrl: 'https://other.tailnet.ts.net' });
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
      platform = { remoteHost: link };
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
      platform = { remoteHost: mintingLink() };
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
    // Every mint spends a code on the Server, so the timer armed against the
    // code being replaced must not fire on top of the replacement.
    vi.useFakeTimers();
    try {
      const link = mintingLink();
      platform = { remoteHost: link };
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
    // `expiresAt` is the Server's clock and the subtraction is against this
    // one's. A laptop minutes fast computes a delay at or below zero, and the
    // unclamped version re-minted several times a second — each one spending a
    // real single-use token.
    vi.useFakeTimers();
    try {
      const link = mintingLink(-600_000);
      platform = { remoteHost: link };
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

  it('refreshes by the real TTL when the Server clock is far ahead', async () => {
    // Ten minutes of negative webview skew makes a five-minute Server token
    // look fifteen minutes long. It still needs replacement before its real
    // five-minute expiry, with the ordinary 20-second lead.
    vi.useFakeTimers();
    try {
      const link = mintingLink(900_000);
      platform = { remoteHost: link };
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
      platform = { remoteHost: link };
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
    platform = { remoteHost: link };
    await render();

    await act(async () => buttonLabelled('Set up a phone')!.click());
    expect(text()).toContain('Getting a code…');

    // And the token exists on the Server either way; what must not happen is a
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
      platform = { remoteHost: link };
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
    // through `makeStubRemoteHostLink` and nothing else, so a fixture that
    // stopped answering `setupQr` — or stopped firing the invitation event —
    // would fail only in Chromatic. The states themselves are covered above, so
    // this pins the fixture rather than re-rendering them.
    const link = makeStubRemoteHostLink({
      status: enrolledStatus(),
      setupQr: setupQrResult({ expiresAt: NOW + 300_000 }),
    });
    expect(await link.command('setupQr')).toMatchObject({ expiresAt: NOW + 300_000 });

    // The used-up state has to name the invitation the stub's own `setupQr`
    // answered, and carry a state other than `live` — the panel ignores both a
    // stranger's id and a code that is still good.
    const used = setupQrResult();
    const events: unknown[] = [];
    makeStubRemoteHostLink({
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
    let status: unknown = NOT_ENROLLED;
    const link = makeLink(async () => status);
    platform = { remoteHost: link };
    await render();
    expect(text()).toContain('Connect this machine to a Dormouse server');

    // Another window enrolled: the event carries only `{ enrolled }`, so the
    // section must re-read rather than patch a field.
    status = enrolled();
    await act(async () => {
      link.emit('status', { name: 'status', enrolled: true });
    });
    expect(text()).toContain('https://laptop.tailnet.ts.net');
  });
});
