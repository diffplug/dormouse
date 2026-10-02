/**
 * @vitest-environment jsdom
 *
 * The one-time page through its whole state machine
 * (`docs/specs/one-time.md` -> "Phone page"): the gate, the link it took, the
 * tap before any socket, the digits, the direct wait, the wall, and every
 * ending. The client is the real `OneTimeClient` where the case is about what
 * it opens, and a double where the case scripts what it answers.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ONE_TIME_DEVICE_LABELS,
  ONE_TIME_ROOM_PARAM,
  ONE_TIME_WS_ROUTES,
  formatOneTimeLinkUrl,
  generateNoiseKeyPair,
  toBase64Url,
  type OneTimeLink,
} from 'remote-lib-common';

import {
  ONE_TIME_CONNECTING_TITLE,
  ONE_TIME_CONNECT_LABEL,
  ONE_TIME_END_LABEL,
  ONE_TIME_INVALID_TITLE,
  ONE_TIME_NOT_CONNECTED_TITLE,
  ONE_TIME_READY_TITLE,
  ONE_TIME_UNSUPPORTED_TITLE,
  OneTimeApp,
  expiresInText,
  oneTimeDeviceLabel,
  type OneTimePageClient,
} from './OneTimeApp';
import { reloadOnNewLink, takeOneTimeLinkUrl } from './take-link';
import {
  ONE_TIME_DIRECT_FAILED_MESSAGE,
  ONE_TIME_ENDED_MESSAGE,
  ONE_TIME_LINK_EXPIRED_MESSAGE,
  ONE_TIME_LINK_USED_MESSAGE,
  type OneTimeResult,
} from '../client/one-time-client';
import { applyPocketTheme } from '../pocket-app/pocket-theme';
import { buttonNamed, click, pairingCode } from '../pocket-app/app-test-utils';
import { testRoutingId } from '../test-e2e-client';

const fake = vi.hoisted(() => ({
  noiseSupported: true as boolean,
  mount: vi.fn<(client: unknown) => Promise<unknown>>(),
  disposeAllSessions: vi.fn<() => void>(),
  /** The props the last wall rendered with. */
  wall: null as null | { restoreTheme?: () => void; onError?: (error: unknown) => void },
}));

// The one shared export doubled, and only for its probe: the gate has to be
// driven both ways.
vi.mock('remote-lib-common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('remote-lib-common')>()),
  probeNoiseSupport: () => Promise.resolve(fake.noiseSupported),
}));
// Pocket's label would name an installed app; the page must never use it.
vi.mock('../client/install-state', () => ({ isInstalledWebApp: () => true }));
vi.mock('../pocket-app/remote-wall', () => ({
  mountRemoteWall: (client: unknown) => fake.mount(client),
}));
vi.mock('../pocket-app/PocketWall', () => ({
  PocketWall: (props: { restoreTheme?: () => void; onError?: (error: unknown) => void }) => {
    fake.wall = props;
    return <div data-testid="wall" />;
  },
}));
vi.mock('../../lib/terminal-registry', () => ({
  disposeAllSessions: () => fake.disposeAllSessions(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The label jsdom's navigator gets; see `oneTimeDeviceLabel`. */
const DEVICE_LABEL = 'Phone browser';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fake.noiseSupported = true;
  fake.mount.mockReset();
  fake.disposeAllSessions.mockReset();
  fake.wall = null;
  // jsdom has no WebRTC; the page requires it, so every case but the one
  // proving that requirement gets a stand-in.
  vi.stubGlobal('RTCPeerConnection', class {});
  localStorage.clear();
  history.replaceState(null, '', '/connect/');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A link for this page's own origin, live for five minutes unless `expiry` says otherwise. */
async function linkUrl(
  expiry = Math.floor(Date.now() / 1000) + 300,
): Promise<{ url: string; link: OneTimeLink }> {
  const { publicKey } = await generateNoiseKeyPair();
  const link: OneTimeLink = {
    roomId: testRoutingId(),
    expiry,
    ephPub: publicKey,
    ephPubBase64Url: toBase64Url(publicKey),
  };
  return { url: formatOneTimeLinkUrl(location.origin, link), link };
}

/** Let WebCrypto and React both catch up until `done` holds. */
async function waitFor(done: () => boolean, what = 'the page'): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

const text = () => container.textContent ?? '';
const shows = (copy: string) => () => text().includes(copy);

function render(url: string | null, createClient?: () => OneTimePageClient): void {
  act(() => {
    root.render(
      <StrictMode>
        <OneTimeApp linkUrl={url} createClient={createClient} />
      </StrictMode>,
    );
  });
}

/** A client whose ceremony each case answers by hand. */
function scriptedClient() {
  let resolve!: (result: OneTimeResult) => void;
  const calls: Array<{
    link: OneTimeLink;
    label: string;
    onCode: (code: string) => void;
    onConfirmed?: () => void;
  }> = [];
  let onEnded: ((message: string) => void) | null = null;
  /** Whether `setOnEnded` was registered before `connectOnce` ran. */
  let endedBeforeConnect = false;
  const client = {
    connectOnce: vi.fn(
      (link: OneTimeLink, label: string, onCode: (code: string) => void, onConfirmed?: () => void) => {
        endedBeforeConnect = onEnded !== null;
        calls.push({ link, label, onCode, onConfirmed });
        return new Promise<OneTimeResult>((r) => {
          resolve = r;
        });
      },
    ),
    setOnEnded: vi.fn((callback: ((message: string) => void) | null) => {
      onEnded = callback;
    }),
    close: vi.fn(),
    hello: vi.fn(),
    watchDirectory: vi.fn(),
    attach: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    detach: vi.fn(),
    unsubscribe: vi.fn(),
  };
  const created = vi.fn(() => client as unknown as OneTimePageClient);
  return {
    client,
    created,
    calls,
    resolve: (result: OneTimeResult) => act(() => resolve(result)),
    ended: (message: string) => act(() => onEnded?.(message)),
    endedBeforeConnect: () => endedBeforeConnect,
  };
}

/** A page on a live link, tapped: the scripted client is mid-ceremony. */
async function tapped() {
  const { url, link } = await linkUrl();
  const scripted = scriptedClient();
  render(url, scripted.created);
  await waitFor(shows(ONE_TIME_READY_TITLE));
  await click(container, ONE_TIME_CONNECT_LABEL);
  expect(scripted.calls).toHaveLength(1);
  return { ...scripted, link };
}

/** A page whose session is up, on a wall the adapter double carries. */
async function onTheWall() {
  const scripted = await tapped();
  const adapter = { dispose: vi.fn(async () => undefined) };
  fake.mount.mockResolvedValue(adapter);
  await act(async () => {
    scripted.calls[0]!.onCode('42');
    scripted.calls[0]!.onConfirmed?.();
  });
  scripted.resolve({ ok: true, burrowLabel: 'Studio iMac' });
  await waitFor(() => container.querySelector('[data-testid="wall"]') !== null, 'the wall');
  return { ...scripted, adapter };
}

describe('the fragment', () => {
  it('is taken whole and erased before anything renders', () => {
    history.replaceState(null, '', '/connect/#1.abc');
    const replaceState = vi.spyOn(history, 'replaceState');
    const pushState = vi.spyOn(history, 'pushState');

    expect(takeOneTimeLinkUrl()).toBe(`${location.origin}/connect/#1.abc`);

    expect(location.hash).toBe('');
    expect(location.pathname).toBe('/connect/');
    expect(replaceState).toHaveBeenCalledOnce();
    expect(pushState).not.toHaveBeenCalled();
  });

  it('answers null for a page with none, and leaves the address alone', () => {
    const replaceState = vi.spyOn(history, 'replaceState');
    expect(takeOneTimeLinkUrl()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('reloads for a new link opened in the same tab, but not for its own erase', () => {
    const reload = vi.fn();
    reloadOnNewLink(reload);
    history.replaceState(null, '', '/connect/#1.abc');
    takeOneTimeLinkUrl();
    expect(reload).not.toHaveBeenCalled();
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('the gate', () => {
  it('turns away a browser without WebRTC, and builds no client', async () => {
    vi.unstubAllGlobals();
    const { url } = await linkUrl();
    const scripted = scriptedClient();
    render(url, scripted.created);
    await waitFor(shows(ONE_TIME_UNSUPPORTED_TITLE));
    expect(buttonNamed(container, ONE_TIME_CONNECT_LABEL)).toBeNull();
    expect(scripted.created).not.toHaveBeenCalled();
  });

  it('turns away a browser without X25519', async () => {
    fake.noiseSupported = false;
    const { url } = await linkUrl();
    render(url, scriptedClient().created);
    await waitFor(shows(ONE_TIME_UNSUPPORTED_TITLE));
  });

  it('says a missing, malformed, or foreign link does not work', async () => {
    const { url } = await linkUrl();
    for (const candidate of [
      null,
      `${location.origin}/connect/#1.not-a-link`,
      url.replace(location.origin, 'https://relay.dormouse.sh'),
      url.replace('/connect/', '/connect/x/'),
    ]) {
      act(() => root.unmount());
      root = createRoot(container);
      render(candidate, scriptedClient().created);
      await waitFor(shows(ONE_TIME_INVALID_TITLE), String(candidate));
      expect(buttonNamed(container, ONE_TIME_CONNECT_LABEL), String(candidate)).toBeNull();
    }
  });

  it('says an expired link expired, and builds no client', async () => {
    const { url } = await linkUrl(Math.floor(Date.now() / 1000) - 1);
    const scripted = scriptedClient();
    render(url, scripted.created);
    await waitFor(shows(ONE_TIME_LINK_EXPIRED_MESSAGE));
    expect(text()).toContain(ONE_TIME_NOT_CONNECTED_TITLE);
    expect(scripted.created).not.toHaveBeenCalled();
  });

  it('counts a live link down, to the minute and then the second', () => {
    expect(expiresInText(300_000)).toBe('Expires in 5 min.');
    expect(expiresInText(61_000)).toBe('Expires in 2 min.');
    expect(expiresInText(60_000)).toBe('Expires in 1 min.');
    expect(expiresInText(59_000)).toBe('Expires in 59 s.');
    expect(expiresInText(1)).toBe('Expires in 1 s.');
  });

  it('names the device coarsely, only ever from the closed set, never as Pocket', () => {
    const cases: Array<[Parameters<typeof oneTimeDeviceLabel>[0], string]> = [
      [{ platform: 'iPhone' }, 'iPhone'],
      [{ platform: 'iPad' }, 'iPad'],
      // iPadOS Safari reports a Mac; a real Mac has no touch points.
      [{ platform: 'MacIntel', maxTouchPoints: 5 }, 'iPad'],
      [{ platform: 'MacIntel', maxTouchPoints: 0 }, 'Phone browser'],
      [{ platform: 'Linux armv81', userAgentData: { platform: 'Android' } }, 'Android phone'],
      // Firefox for Android: no `userAgentData`, and a Linux platform.
      [
        {
          platform: 'Linux armv8l',
          userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
        },
        'Android phone',
      ],
      // Where `userAgentData` answers, the user agent is not asked.
      [{ userAgentData: { platform: 'Linux' }, userAgent: 'Android' }, 'Phone browser'],
      // An empty `userAgentData.platform` (a user-agent override) falls through.
      [{ platform: 'iPhone', userAgentData: { platform: '' } }, 'iPhone'],
      [{ platform: 'Linux aarch64' }, 'Phone browser'],
      [{}, 'Phone browser'],
    ];
    for (const [hints, label] of cases) {
      expect(oneTimeDeviceLabel(hints), JSON.stringify(hints)).toBe(label);
      expect(ONE_TIME_DEVICE_LABELS).toContain(oneTimeDeviceLabel(hints));
    }
  });
});

describe('the tap', () => {
  it('opens no socket until Connect, then joins the link’s room on this origin', async () => {
    const opened: string[] = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        readyState = 0;
        constructor(url: string) {
          opened.push(url);
        }
        addEventListener() {}
        send() {}
        close() {}
      },
    );
    const { url, link } = await linkUrl();
    // The real page client, so the socket it opens is the one a phone would.
    render(url);
    await waitFor(shows(ONE_TIME_READY_TITLE));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(opened).toEqual([]);

    await click(container, ONE_TIME_CONNECT_LABEL);
    await waitFor(() => opened.length > 0, 'the socket');
    expect(opened).toEqual([
      `ws://${location.host}${ONE_TIME_WS_ROUTES.client}?${ONE_TIME_ROOM_PARAM}=${link.roomId}`,
    ]);
  });

  it('shows the digits, then the direct wait, and the wall only on ok', async () => {
    const scripted = await tapped();
    expect(scripted.calls[0]!.label).toBe(DEVICE_LABEL);
    expect(scripted.calls[0]!.link).toEqual(scripted.link);
    expect(scripted.endedBeforeConnect()).toBe(true);
    expect(pairingCode(container)).toBe('··');

    await act(async () => scripted.calls[0]!.onCode('42'));
    expect(pairingCode(container)).toBe('42');
    expect(text()).toContain('Type these two digits on your computer.');

    await act(async () => scripted.calls[0]!.onConfirmed?.());
    expect(text()).toContain(ONE_TIME_CONNECTING_TITLE);
    expect(fake.mount).not.toHaveBeenCalled();

    fake.mount.mockResolvedValue({ dispose: vi.fn(async () => undefined) });
    scripted.resolve({ ok: true, burrowLabel: 'Studio iMac' });
    await waitFor(() => container.querySelector('[data-testid="wall"]') !== null, 'the wall');
    expect(fake.mount).toHaveBeenCalledWith(scripted.client);
    const header = container.querySelector('header')!;
    expect(header.textContent).toContain('Studio iMac');
    expect(header.textContent).toContain('direct');
    expect(buttonNamed(container, ONE_TIME_END_LABEL)).not.toBeNull();
    // The wall restores the theme the page's way, which keeps nothing.
    expect(fake.wall?.restoreTheme).toBe(applyPocketTheme);
  });

  it('shows a failure’s fixed copy, offers no retry, and never mounts the wall', async () => {
    const scripted = await tapped();
    scripted.resolve({ ok: false, message: ONE_TIME_LINK_USED_MESSAGE });
    await waitFor(shows(ONE_TIME_LINK_USED_MESSAGE));
    expect(text()).toContain(ONE_TIME_NOT_CONNECTED_TITLE);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(fake.mount).not.toHaveBeenCalled();
  });

  it('cancels from the digits by closing the client', async () => {
    const scripted = await tapped();
    await click(container, 'Cancel');
    expect(scripted.client.close).toHaveBeenCalled();
    expect(text()).toContain(ONE_TIME_ENDED_MESSAGE);
  });
});

describe('the endings', () => {
  it('ends from the wall: the client closed, the terminals released, fixed copy', async () => {
    const { client, adapter } = await onTheWall();
    await click(container, ONE_TIME_END_LABEL);
    expect(client.close).toHaveBeenCalled();
    expect(adapter.dispose).toHaveBeenCalled();
    expect(fake.disposeAllSessions).toHaveBeenCalled();
    expect(text()).toContain(ONE_TIME_ENDED_MESSAGE);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('shows the copy of an ending the client reports after the switch', async () => {
    const { ended, adapter } = await onTheWall();
    ended(ONE_TIME_DIRECT_FAILED_MESSAGE);
    expect(text()).toContain(ONE_TIME_DIRECT_FAILED_MESSAGE);
    expect(adapter.dispose).toHaveBeenCalled();
    // The first ending is the one shown.
    ended(ONE_TIME_ENDED_MESSAGE);
    expect(text()).not.toContain(ONE_TIME_ENDED_MESSAGE);
  });

  it('ends a session whose wall attachment fails', async () => {
    const { client } = await onTheWall();
    act(() => fake.wall?.onError?.(new Error('attach refused')));
    expect(client.close).toHaveBeenCalled();
    expect(text()).toContain(ONE_TIME_ENDED_MESSAGE);
  });

  it('closes a session whose wall could not stand up', async () => {
    const scripted = await tapped();
    fake.mount.mockRejectedValue(new Error('hello failed'));
    scripted.resolve({ ok: true, burrowLabel: 'Studio iMac' });
    await waitFor(shows(ONE_TIME_ENDED_MESSAGE));
    expect(scripted.client.close).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="wall"]')).toBeNull();
  });
});

describe('what the page keeps', () => {
  it('applies its theme without writing anything', () => {
    applyPocketTheme();
    expect(document.body.style.getPropertyValue('--vscode-sideBar-background')).not.toBe('');
    expect(localStorage.length).toBe(0);
  });
});
