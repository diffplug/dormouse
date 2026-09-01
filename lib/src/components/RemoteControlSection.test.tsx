/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { RemoteControlSection } from './RemoteControlSection';
import type { RemoteHostConsoleStatus } from '../host/remote/service-protocol';
import {
  enrolledStatus,
  OFFER_STATUS,
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

function text(): string {
  return container.textContent ?? '';
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
        failEnroll(new Error('host enroll failed (401)'));
        await Promise.resolve();
      });
      expect(text()).toContain('host enroll failed (401)');
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

  it('shows the server and paired-device count when enrolled', async () => {
    platform = { remoteHost: makeLink(async () => enrolled({ pairedClients: 2 })) };
    await render();
    expect(text()).toContain('https://laptop.tailnet.ts.net');
    expect(text()).toContain('2 paired devices');
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
