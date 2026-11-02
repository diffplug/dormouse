/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameClient, OpenFrame } from '../client/frame-client';
import { PocketBrowserFrame, type FrameTransport, type PocketBrowserFrameProps } from './PocketBrowserFrame';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = 'https://abc.frames.example';
let container: HTMLDivElement;
let root: Root;
let onClosed: ((reason: string) => void) | undefined;
let close: ReturnType<typeof vi.fn>;
let open: ReturnType<typeof vi.fn>;
let frames: FrameClient;

const DIRECT: FrameTransport = { path: 'direct', cause: null };
const originForFixed = async () => ORIGIN;
const flush = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve); }));

function props(over: Partial<PocketBrowserFrameProps> = {}): PocketBrowserFrameProps {
  return {
    frames,
    surfaceId: 'surface:1',
    isTool: false,
    title: 'App',
    pageUrl: 'http://localhost:5173/app',
    originFor: originForFixed,
    transport: DIRECT,
    visible: true,
    onReconnect: vi.fn(),
    onShowSessions: vi.fn(),
    ...over,
  };
}
const render = async (over: Partial<PocketBrowserFrameProps> = {}) => {
  await act(async () => root.render(<PocketBrowserFrame {...props(over)} />));
  await flush();
};
const iframe = (title: string) => container.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);

/** The bootstrap page's half: connect, and say the worker is up. */
async function join() {
  const bootstrap = iframe('Frame bootstrap')!;
  const post = vi.spyOn(bootstrap.contentWindow!, 'postMessage');
  await act(async () => void bootstrap.dispatchEvent(new Event('load', { bubbles: true })));
  const [message, target, transfer] = post.mock.calls[0] as unknown as [unknown, string, MessagePort[]];
  expect(message).toEqual({ kind: 'dormouse-frame-connect' });
  expect(target).toBe(ORIGIN);
  transfer[0].postMessage({ kind: 'ready' });
  await flush();
  await flush();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  close = vi.fn();
  open = vi.fn(async (init: { onClosed?: (reason: string) => void }) => {
    onClosed = init.onClosed;
    return { id: 'frame-1', path: '/app', url: 'http://localhost:5173/app', close } as unknown as OpenFrame;
  });
  frames = { open } as unknown as FrameClient;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PocketBrowserFrame', () => {
  it('opens nothing until the direct path carries the session', async () => {
    await render({ transport: { path: 'relay', cause: null } });
    expect(container.textContent).toContain('Connecting directly');
    expect(open).not.toHaveBeenCalled();
  });

  it('says what to do on a session that stays relayed, and reconnects', async () => {
    const onReconnect = vi.fn();
    await render({ transport: { path: 'relay', cause: 'failed' }, onReconnect });
    expect(container.textContent).toContain('A VPN such as Tailscale');
    expect(open).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reconnect')!.click());
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('opens at the page\'s origin, frames the page only once the worker is up, and sandboxes it', async () => {
    const originFor = vi.fn(async () => ORIGIN);
    await render({ originFor });
    expect(originFor).toHaveBeenCalledWith('surface:1', 'http://localhost:5173');
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ surfaceId: 'surface:1', frameOrigin: ORIGIN, embedderOrigins: [location.origin] }));
    expect(iframe('App')).toBeNull();
    expect(iframe('Frame bootstrap')!.src).toBe(`${ORIGIN}/__dormouse-frame/bootstrap.html`);
    // The page can script its same-origin sibling, so this is no way out of its sandbox.
    expect(iframe('Frame bootstrap')!.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    await join();
    const page = iframe('App')!;
    expect(page.src).toBe(`${ORIGIN}/app`);
    expect(page.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(container.textContent).toContain('Loading page');
    await act(async () => void page.dispatchEvent(new Event('load', { bubbles: true })));
    expect(container.textContent).not.toContain('Loading page');
  });

  it('takes nothing but the bootstrap page\'s ready as joined', async () => {
    await render();
    const bootstrap = iframe('Frame bootstrap')!;
    const post = vi.spyOn(bootstrap.contentWindow!, 'postMessage');
    await act(async () => void bootstrap.dispatchEvent(new Event('load', { bubbles: true })));
    const port = (post.mock.calls[0] as unknown as [unknown, string, MessagePort[]])[2][0];
    port.postMessage({ kind: 'something else' });
    await flush();
    await flush();
    expect(iframe('App')).toBeNull();
    port.postMessage({ kind: 'ready' });
    await flush();
    await flush();
    expect(iframe('App')).not.toBeNull();
  });

  it('does not reopen for a new render, and closes its frame on the way out', async () => {
    await render();
    await render({ title: 'Renamed' });
    expect(open).toHaveBeenCalledOnce();
    act(() => root.unmount());
    expect(close).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it('reopens a frame closed as gone, since a slow owner reads as gone too', async () => {
    await render();
    await act(async () => onClosed?.('surface-gone'));
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!.click());
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('says so when the page is gone', async () => {
    const onShowSessions = vi.fn();
    await render({ onShowSessions });
    await act(async () => onClosed?.('surface-gone'));
    expect(container.textContent).toContain('no longer open on your computer');
    expect(iframe('Frame bootstrap')).toBeNull();
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Show sessions')!.click());
    expect(onShowSessions).toHaveBeenCalledOnce();
  });

  it('shows why an open failed, and tries again', async () => {
    open.mockRejectedValueOnce(new Error('too many frames are open'));
    await render();
    expect(container.textContent).toContain('too many frames are open');
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!.click());
    await flush();
    expect(open).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('too many frames are open');
  });

  it('stays mounted but unseen when another surface shows', async () => {
    await render({ visible: false });
    expect(container.firstElementChild!.classList.contains('invisible')).toBe(true);
    expect(iframe('Frame bootstrap')).not.toBeNull();
  });

});
