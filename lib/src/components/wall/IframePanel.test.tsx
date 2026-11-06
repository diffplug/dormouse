/**
 * @vitest-environment jsdom
 */
import { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import type { PaneProps } from './pane-props';
import { IframePanel } from './IframePanel';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import { PaneWriteContext, WallActionsContext, type PaneWriteActions, type WallActions } from './wall-context';
import { installBrowserHost, stubWallActions as stubActions } from './wall-test-utils';
import { confirmToolEditorsClose, decideEditorClose, getEditorClosePrompt } from '../../lib/tool-editor';
import { resetToolDirty } from '../../lib/tool-dirty-store';
import type { BurrowLink } from '../../lib/platform/types';
import { networkPolicyResult, type NetworkPolicy, type NetworkPolicyResult } from '../../remote/network-policy';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function paneProps(id: string): PaneProps {
  return { id, title: 'Raw iframe', params: { url: 'http://example.test/app' } };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setPlatform(new FakePtyAdapter());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  void decideEditorClose('cancel');
  resetToolDirty();
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const PROXY = 'http://127.0.0.1:61234';
function proxyPlatform(result: Awaited<ReturnType<NonNullable<PlatformAdapter['createIframeProxyUrl']>>> = { ok: true, url: `${PROXY}/app` }, swapCapable = true) {
  // A host that drives agent-browser can swap the pane to it.
  const platform: PlatformAdapter = swapCapable ? installBrowserHost().platform : new FakePtyAdapter();
  platform.createIframeProxyUrl = vi.fn(async () => result);
  setPlatform(platform);
  return platform;
}

async function renderPanel(
  actions: WallActions,
  props: PaneProps = paneProps('iframe-raw'),
  updateParameters: (patch: Record<string, unknown>) => void = () => {},
): Promise<HTMLIFrameElement> {
  // The panel's title/param writes go through PaneWriteContext now; forward
  // updateParams' patch to the test's mock so its assertions stay unchanged.
  const paneWrite: PaneWriteActions = { updateParams: (_id, patch) => updateParameters(patch), setTitle: () => {} };
  await act(async () => {
    root.render(
      <StrictMode>
        <PaneWriteContext.Provider value={paneWrite}>
          <WallActionsContext.Provider value={actions}>
            <IframePanel {...props} />
          </WallActionsContext.Provider>
        </PaneWriteContext.Provider>
      </StrictMode>,
    );
  });

  const iframe = container.querySelector('iframe');
  if (!iframe) throw new Error('missing iframe');
  return iframe;
}

describe('IframePanel', () => {
  it('connects the resolved built-in file Tool to save consent', async () => {
    const platform = new FakePtyAdapter();
    platform.createIframeProxyUrl = async () => ({ ok: true, url: 'http://localhost:4555/token/view' });
    setPlatform(platform);
    const iframe = await renderPanel(stubActions(), { id: 'edit', title: 'example.ts', params: {
      surfaceType: 'tool', toolName: 'file', toolScope: 'builtin', toolTarget: '/project/example.ts',
      command: 'dor __view-file /project/example.ts', renderMode: 'iframe', url: 'http://localhost:4000/token/view',
    } });
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    iframe.dispatchEvent(new Event('load'));
    const command = post.mock.calls.find(([data]) => data.dorTool === 1 && data.kind === 'connect')?.[0];
    expect(command?.kind).toBe('connect');
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, origin: 'http://localhost:4555',
      data: { dorTool: 1, connection: command.connection, kind: 'ready', dirty: true } }));
    const close = confirmToolEditorsClose(['edit']);
    expect(getEditorClosePrompt()?.items.map(item => item.label)).toEqual(['/project/example.ts']);
    await decideEditorClose('cancel'); expect(await close).toBe(false);
  });
  // The raw fallback is the case with no proxy in front of it at all — the
  // website, Storybook, the tutorial — so it is not the trusted one. It used to
  // be framed with no sandbox and a full camera/microphone/geolocation/
  // clipboard-read grant, in a webview where the per-site prompt is often
  // absent. The sets are exact (docs/specs/security-local.md -> "Browser panes"):
  // a token added here is a privilege every framed page gets.
  it.each(['raw', 'proxied'] as const)('frames a %s page under exactly the audited sandbox and permissions', async (kind) => {
    if (kind === 'proxied') proxyPlatform();
    const iframe = await renderPanel(stubActions());
    expect(iframe.hasAttribute('data-dormouse-proxy')).toBe(kind === 'proxied');

    const tokens = (value: string | null, separator: RegExp) => (value ?? '').split(separator).map((t) => t.trim()).filter(Boolean).sort();
    expect(tokens(iframe.getAttribute('sandbox'), /\s+/)).toEqual([
      'allow-downloads', 'allow-forms', 'allow-modals', 'allow-popups', 'allow-same-origin', 'allow-scripts',
    ]);
    expect(tokens(iframe.getAttribute('allow'), /;/)).toEqual(['autoplay', 'clipboard-write', 'fullscreen']);
  });

  it('refuses an open-window url that is not http(s)', async () => {
    const onOpenBrowserPane = vi.fn();
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'createIframeProxyUrl'>;
    platform.createIframeProxyUrl = vi.fn(async () => ({ ok: true, url: 'http://127.0.0.1:61234/app' }));
    setPlatform(platform);
    await renderPanel(stubActions({ onOpenBrowserPane }), paneProps('iframe-openwindow'));

    // A hostile framed page picks this string; the confirm prompt is consent,
    // not a boundary, so the scheme is checked before the prompt is offered.
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'http://127.0.0.1:61234',
        data: { __dormouse: 'open-window', url: 'javascript:alert(1)' },
      }));
    });

    expect(container.textContent).not.toContain('wants to open a new tab');
    expect(onOpenBrowserPane).not.toHaveBeenCalled();
  });

  // The raw fallback puts `params.url` straight into `<iframe src>`, and the
  // sandbox keeps `allow-same-origin`, so a non-http(s) scheme there can reach
  // the embedding webview's realm. `browserSurfaceUrl` guards the control
  // socket and the `open-window` message, but the panel is the sink every
  // writer of `params.url` ends at — including the header's URL editor, whose
  // `normalizeNavUrl` passes `javascript:` and `data:` through on purpose.
  // React neutralizes `javascript:` in a `src` prop and nothing else, so
  // `data:` is the case that proves this guard does its own work.
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
  ])('refuses %s as a source url instead of framing it', async (url) => {
    await act(async () => {
      root.render(
        <StrictMode>
          <PaneWriteContext.Provider value={{ updateParams: () => {}, setTitle: () => {} }}>
            <WallActionsContext.Provider value={stubActions()}>
              <IframePanel id="iframe-scheme" title="Raw iframe" params={{ url }} />
            </WallActionsContext.Provider>
          </PaneWriteContext.Provider>
        </StrictMode>,
      );
    });

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('frames http:// pages only');
    // `dor agent-browser open` refuses a non-http(s) target too, so it is not the remedy here.
    expect(container.textContent).not.toContain('dor agent-browser open');
    expect(container.textContent).not.toContain('Open in agent-browser');
  });

  // The panel frames the string it checked, not the one it was handed: a
  // schemeless `host:port` in `<iframe src>` would resolve against the app's
  // own origin instead of the dev server.
  it('frames the normalized url for a schemeless source', async () => {
    const iframe = await renderPanel(stubActions(), { id: 'iframe-bare', title: 'Raw iframe', params: { url: 'localhost:5173' } });

    expect(iframe.getAttribute('src')).toBe('http://localhost:5173');
  });

  it('proxies the normalized url for a schemeless source', async () => {
    const createIframeProxyUrl = vi.fn(async () => ({ ok: true as const, url: 'http://127.0.0.1:61234/app' }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'createIframeProxyUrl'>;
    platform.createIframeProxyUrl = createIframeProxyUrl;
    setPlatform(platform);
    await renderPanel(stubActions(), { id: 'iframe-bare-proxy', title: 'Raw iframe', params: { url: 'localhost:5173' } });

    expect(createIframeProxyUrl).toHaveBeenCalledWith('http://localhost:5173', expect.stringMatching(/^iframe-bare-proxy#/));
  });

  // docs/specs/dor-browser.md → "Iframe Proxy Leases".
  it('asks under one lease for the life of the view, and releases it on unmount', async () => {
    const createIframeProxyUrl = vi.fn(async (_url: string, _lease?: string) => ({ ok: true as const, url: 'http://127.0.0.1:61234/app' }));
    const releaseIframeProxy = vi.fn();
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'createIframeProxyUrl' | 'releaseIframeProxy'>;
    platform.createIframeProxyUrl = createIframeProxyUrl;
    platform.releaseIframeProxy = releaseIframeProxy;
    setPlatform(platform);
    await renderPanel(stubActions(), paneProps('iframe-leased'));
    await act(async () => { getAgentBrowserScreenController('iframe-leased')?.chromeActions.reload(); });
    const leases = new Set(createIframeProxyUrl.mock.calls.map(([, lease]) => lease));
    expect(createIframeProxyUrl.mock.calls.length).toBeGreaterThan(1);
    expect(leases.size).toBe(1);
    const [lease] = leases;
    act(() => root.unmount());
    expect(releaseIframeProxy).toHaveBeenLastCalledWith(lease);
    root = createRoot(container);
  });

  // StrictMode mounts, unmounts and remounts: reusing one id would send create,
  // release, create, which a transport may deliver as create, create, release
  // — closing the grant the live view was just given.
  it('never asks for a lease it has released, under StrictMode', async () => {
    const calls: string[] = [];
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'createIframeProxyUrl' | 'releaseIframeProxy'>;
    platform.createIframeProxyUrl = async (_url: string, lease?: string) => {
      calls.push(`create ${lease}`);
      return { ok: true as const, url: 'http://127.0.0.1:61234/app' };
    };
    platform.releaseIframeProxy = (lease: string) => { calls.push(`release ${lease}`); };
    setPlatform(platform);
    await renderPanel(stubActions(), paneProps('iframe-strict'));
    const released = new Set<string>();
    for (const call of calls) {
      const [verb, lease] = call.split(' ');
      if (verb === 'release') released.add(lease);
      else expect(released.has(lease), `${call} after its release in ${calls.join(', ')}`).toBe(false);
    }
    const created = calls.filter((call) => call.startsWith('create')).map((call) => call.split(' ')[1]);
    expect(created.length).toBeGreaterThan(0);
    expect(released.has(created.at(-1)!)).toBe(false);
  });

  // The frame is not the only consumer of the source URL: `liveUrl`, the
  // history entries, and the upstream base that in-frame locations are mapped
  // against all read the same string. Normalized only at the frame, a
  // schemeless `localhost:5173` parses as scheme `localhost:` with origin
  // `"null"`, so this navigation would land on `null/app` — and Back would
  // persist that into `params.url`.
  it('maps an in-frame navigation against the normalized source url', async () => {
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'createIframeProxyUrl'>;
    platform.createIframeProxyUrl = vi.fn(async () => ({ ok: true as const, url: 'http://127.0.0.1:61234/' }));
    setPlatform(platform);
    await renderPanel(stubActions(), { id: 'iframe-bare-nav', title: 'Raw iframe', params: { url: 'localhost:5173' } });

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'http://127.0.0.1:61234',
        data: { __dormouse: 'location', url: 'http://127.0.0.1:61234/app' },
      }));
    });

    expect(getAgentBrowserScreenController('iframe-bare-nav')?.chrome().url).toBe('http://localhost:5173/app');
  });

  it('enters the raw iframe fallback on window blur focus, as focus alone and never a click', async () => {
    const onClickPanel = vi.fn();
    const onEnterPanel = vi.fn();
    const actions = stubActions({ onClickPanel, onEnterPanel });
    const iframe = await renderPanel(actions);

    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(onEnterPanel).toHaveBeenCalledWith('iframe-raw');
    // A click acknowledges the Session; DOM focus never does (docs/specs/alert.md -> Engagement).
    expect(onClickPanel).not.toHaveBeenCalled();
  });

  it('does not adopt a raw iframe blur when the app itself lost focus', async () => {
    const onEnterPanel = vi.fn();
    const actions = stubActions({ onEnterPanel });
    const iframe = await renderPanel(actions);

    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(onEnterPanel).not.toHaveBeenCalled();
  });

  it('drives iframe back and forward from the registered chrome actions', async () => {
    const updateParameters = vi.fn();
    installBrowserHost();
    await renderPanel(stubActions(), paneProps('iframe-history'), updateParameters);

    await act(async () => {
      getAgentBrowserScreenController('iframe-history')?.chromeActions.navigate('http://example.test/one');
    });
    await act(async () => {
      getAgentBrowserScreenController('iframe-history')?.chromeActions.navigate('http://example.test/two');
    });
    await act(async () => {
      getAgentBrowserScreenController('iframe-history')?.chromeActions.back();
    });
    expect(updateParameters).toHaveBeenLastCalledWith({ url: 'http://example.test/one' });

    await act(async () => {
      getAgentBrowserScreenController('iframe-history')?.chromeActions.forward();
    });
    expect(updateParameters).toHaveBeenLastCalledWith({ url: 'http://example.test/two' });
  });

  it('reloads the observed page and preserves its history', async () => {
    const platform = proxyPlatform();
    const createProxy = vi.fn(async (url: string) => ({
      ok: true as const,
      url: url.replace('http://example.test', PROXY),
    }));
    platform.createIframeProxyUrl = createProxy;
    const setTitle = vi.fn();
    function Harness() {
      const [params, setParams] = useState({ url: 'http://example.test/app' });
      return <PaneWriteContext.Provider value={{
        updateParams: (_id, patch) => setParams((current) => ({ ...current, ...patch })),
        setTitle,
      }}><WallActionsContext.Provider value={stubActions()}>
        <IframePanel id="iframe-reload-current" title="Current page" params={params} />
      </WallActionsContext.Provider></PaneWriteContext.Provider>;
    }
    await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
    const chrome = () => getAgentBrowserScreenController('iframe-reload-current')!;
    const observe = async (path: string) => act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: PROXY, data: { __dormouse: 'location', url: PROXY + path, loaded: true },
      }));
    });
    await observe('/other?q=1#part');
    const original = container.querySelector('iframe');
    setTitle.mockClear();
    await act(async () => chrome().chromeActions.reload());
    expect(createProxy).toHaveBeenLastCalledWith('http://example.test/other?q=1#part', expect.any(String));
    expect(container.querySelector('iframe')!.src).toBe(PROXY + '/other?q=1#part');
    expect(container.querySelector('iframe')).not.toBe(original);
    expect(setTitle).not.toHaveBeenCalled();

    await observe('/third');
    await act(async () => chrome().chromeActions.back());
    await act(async () => chrome().chromeActions.reload());
    await act(async () => chrome().chromeActions.forward());
    expect(chrome().chrome().url).toBe('http://example.test/third');
    await act(async () => chrome().chromeActions.back());
    await act(async () => chrome().chromeActions.back());
    expect(chrome().chrome().url).toBe('http://example.test/app');
  });

  it('reloads a raw frame even when its URL is unchanged', async () => {
    const original = await renderPanel(stubActions(), paneProps('iframe-raw-reload'));
    await act(async () => getAgentBrowserScreenController('iframe-raw-reload')!.chromeActions.reload());
    expect(container.querySelector('iframe')!.src).toBe(original.src);
    expect(container.querySelector('iframe')).not.toBe(original);
  });

  it('maps proxied frame location messages into chrome without updating params', async () => {
    const updateParameters = vi.fn();
    const { platform } = installBrowserHost();
    platform.createIframeProxyUrl = vi.fn(async () => ({
      ok: true as const,
      url: 'http://127.0.0.1:61234/app',
      upstream: 'http://example.test/app',
    }));
    await renderPanel(stubActions(), paneProps('iframe-proxied'), updateParameters);

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'http://127.0.0.1:61234',
        data: { __dormouse: 'location', url: 'http://127.0.0.1:61234/other/?q=1#frag' },
      }));
    });

    expect(updateParameters).not.toHaveBeenCalled();
    expect(getAgentBrowserScreenController('iframe-proxied')?.chrome().url).toBe('http://example.test/other/?q=1#frag');
  });

  // Any page can post to this window: another pane's proxy, an upstream that
  // escaped one, the webview itself. Only this panel's own proxy origin speaks
  // for its frame (docs/specs/security-local.md -> "Browser panes").
  it('acts on no message from any origin but its own proxy', async () => {
    const onClickPanel = vi.fn();
    const onFrameLeader = vi.fn();
    proxyPlatform({ ok: true, url: `${PROXY}/app`, upstream: 'http://example.test/app' });
    const frame = await renderPanel(stubActions({ onClickPanel, onFrameLeader }), paneProps('iframe-foreign'));
    frame.focus();
    const chrome = () => getAgentBrowserScreenController('iframe-foreign')?.chrome().url;
    const before = chrome();
    const send = (origin: string, data: unknown) => act(async () => {
      window.dispatchEvent(new MessageEvent('message', { origin, source: frame.contentWindow, data }));
    });

    for (const origin of ['http://127.0.0.1:61235', 'http://localhost:61234', 'https://evil.example', window.location.origin, 'null']) {
      await send(origin, { __dormouse: 'pointerdown' });
      await send(origin, { __dormouse: 'leader' });
      await send(origin, { __dormouse: 'location', url: `${PROXY}/other`, loaded: true });
      await send(origin, { __dormouse: 'open-window', url: `${PROXY}/docs` });
      await send(origin, { __dormouse: 'navigate', url: 'http://localhost:5173/elsewhere' });
    }
    expect(onClickPanel).not.toHaveBeenCalled();
    expect(onFrameLeader).not.toHaveBeenCalled();
    expect(chrome()).toBe(before);
    expect(container.textContent).not.toContain('Open in new pane');

    await send(PROXY, { __dormouse: 'pointerdown' });
    expect(onClickPanel).toHaveBeenCalledWith('iframe-foreign');
  });

  it.each([
    ['pointerdown', 'onClickPanel'],
    ['leader', 'onFrameLeader'],
  ] as const)('takes %s only from its own frame, while that frame holds focus', async (kind, action) => {
    const acted = vi.fn();
    proxyPlatform({ ok: true, url: `${PROXY}/app`, upstream: 'http://example.test/app' });
    const frame = await renderPanel(stubActions({ [action]: acted }), paneProps('iframe-focus'));
    const other = document.createElement('iframe');
    document.body.appendChild(other);
    const send = (source: Window | null) => act(async () => {
      window.dispatchEvent(new MessageEvent('message', { origin: PROXY, source, data: { __dormouse: kind } }));
    });

    await send(frame.contentWindow); // Nothing holds focus.
    other.focus();
    await send(frame.contentWindow); // Another frame holds it.
    await send(other.contentWindow); // That frame, on this panel's origin.
    frame.focus();
    await send(other.contentWindow); // This frame holds it, but another sent.
    await send(null);
    other.remove();
    expect(acted).not.toHaveBeenCalled();

    await send(frame.contentWindow);
    expect(acted).toHaveBeenCalledOnce();
  });

  it('re-resolves the proxy on Back after an observed in-frame navigation', async () => {
    const updateParameters = vi.fn();
    const { platform } = installBrowserHost();
    // Fixed URL so the proxy origin stays stable (the message handler gates on
    // it); re-resolution is observed via the call count, not a changed src.
    const createProxy = vi.fn(async () => ({ ok: true as const, url: 'http://127.0.0.1:61234/app' }));
    platform.createIframeProxyUrl = createProxy;
    await renderPanel(stubActions(), paneProps('iframe-back'), updateParameters);

    // Observe an in-frame navigation: it adds a history entry but, by design,
    // does not write params.url back, so params.url stays the source URL.
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'http://127.0.0.1:61234',
        data: { __dormouse: 'location', url: 'http://127.0.0.1:61234/other' },
      }));
    });

    const callsBeforeBack = createProxy.mock.calls.length;
    await act(async () => {
      getAgentBrowserScreenController('iframe-back')?.chromeActions.back();
    });

    // Back targets the original (still-persisted) URL, so updateParameters is a
    // no-op write — the proxy must still re-resolve or the frame would keep
    // showing /other while the chrome shows /app.
    expect(updateParameters).toHaveBeenLastCalledWith({ url: 'http://example.test/app' });
    expect(createProxy.mock.calls.length).toBeGreaterThan(callsBeforeBack);
  });
});

describe('before its first paint', () => {
  const hidden = (iframe: HTMLIFrameElement) => iframe.classList.contains('opacity-0');
  function renderUrl(url: string, onReady?: () => void) {
    act(() => {
      root.render(
        <PaneWriteContext.Provider value={{ updateParams: () => {}, setTitle: () => {} }}>
          <WallActionsContext.Provider value={stubActions()}>
            <IframePanel id="iframe-paint" title="t" params={{ url }} onReady={onReady} />
          </WallActionsContext.Provider>
        </PaneWriteContext.Provider>,
      );
    });
    return container.querySelector('iframe')!;
  }

  it('hides the frame until its first load, then reports ready a frame later', async () => {
    const onReady = vi.fn();
    const iframe = renderUrl('http://example.test/a', onReady);
    expect(hidden(iframe)).toBe(true);
    await act(async () => { iframe.dispatchEvent(new Event('load')); });
    expect(hidden(iframe)).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    await act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(undefined))); });
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('never hides a loaded frame again when it navigates', async () => {
    const iframe = renderUrl('http://example.test/a');
    await act(async () => { iframe.dispatchEvent(new Event('load')); });
    const next = renderUrl('http://example.test/b');
    expect(next.getAttribute('src')).toBe('http://example.test/b');
    expect(hidden(next)).toBe(false);
  });

  it('shows a frame whose load never fires after a second', async () => {
    vi.useFakeTimers();
    try {
      const iframe = renderUrl('http://example.test/a');
      await act(async () => { vi.advanceTimersByTime(900); });
      expect(hidden(iframe)).toBe(true);
      await act(async () => { vi.advanceTimersByTime(200); });
      expect(hidden(iframe)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('iframe failures offer a way out', () => {
  // The shim's load report (`pageshow` / `DOMContentLoaded`); a clicked link's
  // report carries no `loaded`.
  const report = async (path = '/app', loaded = true) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: PROXY,
        data: { __dormouse: 'location', url: `${PROXY}${path}`, ...(loaded ? { loaded: true } : {}) },
      }));
    });
  };
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label);
  const banner = () => container.querySelector('[role="status"]');

  it('flags a proxied document the shim never reported from, and clears it when one reports', async () => {
    vi.useFakeTimers();
    try {
      const onSwapRenderMode = vi.fn();
      const platform = proxyPlatform();
      const iframe = await renderPanel(stubActions({ onSwapRenderMode }), paneProps('iframe-uninstrumented'));

      // An instrumented document reports its location, so its load is fine.
      await report();
      await act(async () => { iframe.dispatchEvent(new Event('load')); });
      await act(async () => { vi.advanceTimersByTime(1100); });
      expect(banner()).toBeNull();

      // It navigates off the proxy: a load with no report.
      await act(async () => { vi.advanceTimersByTime(2000); });
      await act(async () => { iframe.dispatchEvent(new Event('load')); });
      await act(async () => { vi.advanceTimersByTime(1100); });
      expect(banner()?.textContent).toContain('Dormouse can’t follow this page');

      await act(async () => { button('Open in agent-browser')!.click(); });
      expect(onSwapRenderMode).toHaveBeenCalledWith('iframe-uninstrumented', 'agent-browser-screencast');

      const resolved = vi.mocked(platform.createIframeProxyUrl).mock.calls.length;
      await act(async () => { button('Reload')!.click(); });
      expect(vi.mocked(platform.createIframeProxyUrl).mock.calls.length).toBeGreaterThan(resolved);
      expect(banner()).toBeNull();

      // Reload replaced the frame. Flag its new document, then clear on a report.
      await report();
      await act(async () => { vi.advanceTimersByTime(2000); });
      await act(async () => { container.querySelector('iframe')!.dispatchEvent(new Event('load')); });
      await act(async () => { vi.advanceTimersByTime(1100); });
      expect(banner()).not.toBeNull();
      await report('/back-on-the-proxy');
      expect(banner()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The proxy instruments HTML only: an image, PDF or JSON document framed from
  // the start carries no shim and is working, not lost.
  it('judges nothing until the frame\'s shim has reported once', async () => {
    vi.useFakeTimers();
    try {
      proxyPlatform();
      const iframe = await renderPanel(stubActions(), paneProps('iframe-non-html'));
      await act(async () => { iframe.dispatchEvent(new Event('load')); });
      await act(async () => { vi.advanceTimersByTime(1100); });
      expect(banner()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count a clicked link\'s report as the next document reporting', async () => {
    vi.useFakeTimers();
    try {
      proxyPlatform();
      const iframe = await renderPanel(stubActions(), paneProps('iframe-click-report'));
      await report();
      await act(async () => { vi.advanceTimersByTime(2000); });
      // A same-origin link to a proxied PDF: the page being left reports the
      // href a tick after the click, and the shim-less PDF loads right after.
      await report('/manual.pdf', false);
      await act(async () => { vi.advanceTimersByTime(50); });
      await act(async () => { iframe.dispatchEvent(new Event('load')); });
      await act(async () => { vi.advanceTimersByTime(1100); });
      expect(banner()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count a clicked link that leaves the proxy as the shim reporting', async () => {
    vi.useFakeTimers();
    try {
      proxyPlatform();
      const iframe = await renderPanel(stubActions(), paneProps('iframe-offproxy-link'));
      await report();
      await act(async () => { vi.advanceTimersByTime(2000); });
      // The shim posts a clicked link's href just before the frame navigates.
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { origin: PROXY, data: { __dormouse: 'location', url: 'https://elsewhere.example/' } }));
      });
      await act(async () => { iframe.dispatchEvent(new Event('load')); });
      await act(async () => { vi.advanceTimersByTime(1100); });
      expect(banner()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers agent-browser on an unproxyable url, with the command as the fallback', async () => {
    const onSwapRenderMode = vi.fn();
    proxyPlatform({ ok: false, reason: 'scheme', detail: 'the embedded view frames http:// pages only' });
    await act(async () => {
      root.render(
        <PaneWriteContext.Provider value={{ updateParams: () => {}, setTitle: () => {} }}>
          <WallActionsContext.Provider value={stubActions({ onSwapRenderMode })}>
            <IframePanel id="iframe-https" title="t" params={{ url: 'https://example.com/' }} />
          </WallActionsContext.Provider>
        </PaneWriteContext.Provider>,
      );
    });

    expect(container.textContent).toContain('Can’t frame this URL — the embedded view frames http:// pages only.');
    expect(container.textContent).toContain('dor agent-browser open https://example.com/');
    await act(async () => { button('Open in agent-browser')!.click(); });
    expect(onSwapRenderMode).toHaveBeenCalledWith('iframe-https', 'agent-browser-screencast');

    // A host that cannot launch one keeps only the command.
    proxyPlatform({ ok: false, reason: 'scheme' }, false);
    await act(async () => { root.render(<></>); });
    await act(async () => {
      root.render(
        <PaneWriteContext.Provider value={{ updateParams: () => {}, setTitle: () => {} }}>
          <WallActionsContext.Provider value={stubActions()}>
            <IframePanel id="iframe-https-2" title="t" params={{ url: 'https://example.com/' }} />
          </WallActionsContext.Provider>
        </PaneWriteContext.Provider>,
      );
    });
    expect(button('Open in agent-browser')).toBeUndefined();
    expect(container.textContent).toContain('dor agent-browser open https://example.com/');
  });

  it('opens a new https:// tab in agent-browser instead of an iframe that would refuse it', async () => {
    const onOpenBrowserPane = vi.fn();
    proxyPlatform();
    await renderPanel(stubActions({ onOpenBrowserPane }), paneProps('iframe-newtab'));
    const openWindow = async (url: string) => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { origin: PROXY, data: { __dormouse: 'open-window', url } }));
      });
    };

    await openWindow('https://accounts.example/login');
    expect(button('Open in new pane')).toBeUndefined();
    await act(async () => { button('Open in agent-browser')!.click(); });
    expect(onOpenBrowserPane).toHaveBeenLastCalledWith('iframe-newtab', 'https://accounts.example/login');

    await openWindow(`${PROXY}/docs`);
    await act(async () => { button('Open in new pane')!.click(); });
    expect(onOpenBrowserPane).toHaveBeenLastCalledWith('iframe-newtab', 'http://example.test/docs');
  });
});

describe('the render modes a tool is offered (regression: PR #493 review)', () => {
  // A tool's `render` is `iframe` or `agent-browser-screencast`, so pop-out has no
  // renderer to land in: offering it tears the browser down and re-derives the
  // same screencast, so the user asks for a native window and gets a reload;
  // and a Playwright mode would be written as its render and launch nothing.
  // `FakePtyAdapter` launches no browser, so every mode would be absent off the
  // stock fake — make the host capable first, or the assertion is vacuous.
  function withCapableHost() {
    installBrowserHost();
  }

  it('offers every mode on a plain browser surface', async () => {
    withCapableHost();
    await renderPanel(stubActions({}), {
      id: 'iframe-plain',
      title: 'Plain',
      params: { surfaceType: 'browser', url: 'http://example.test/app' },
    });
    expect(getAgentBrowserScreenController('iframe-plain')?.renderModes)
      .toEqual(['agent-browser-screencast', 'agent-browser-popout', 'playwright-screencast', 'playwright-popout', 'iframe']);
  });

  it('offers a tool only its declarable renders, and swaps to nothing else', async () => {
    withCapableHost();
    const onSwapRenderMode = vi.fn();
    await renderPanel(stubActions({ onSwapRenderMode }), {
      id: 'iframe-tool',
      title: 'storybook',
      params: { surfaceType: 'tool', url: 'http://localhost:6006/' },
    });
    const controller = getAgentBrowserScreenController('iframe-tool')!;
    expect(controller.renderModes).toEqual(['agent-browser-screencast', 'playwright-screencast', 'iframe']);
    await act(async () => {
      controller.actions.setRenderMode?.('agent-browser-popout');
      controller.actions.setRenderMode?.('agent-browser-screencast');
    });
    expect(onSwapRenderMode).toHaveBeenCalledExactlyOnceWith('iframe-tool', 'agent-browser-screencast');
  });
});

describe('external origins', () => {
  const TAILNET_PAGE = 'http://100.101.1.2:5173';
  const TAILNET = '100.64.0.0/10';
  const EXTERNAL = 'http://docs.example';
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);

  /**
   * A Burrow service holding the network policy, which tells every subscriber
   * of each change, and a host whose proxy gate reads it: `localhost` is this
   * machine, the tailnet page is on Tailscale, `192.168.50.7` on a private
   * network this machine is not on, and anything else public.
   */
  function policyHost(platform: PlatformAdapter, initial: NetworkPolicy) {
    let network: NetworkPolicyResult = networkPolicyResult(initial, 'hosted', []);
    const listeners = new Set<(data: unknown) => void>();
    const emit = (policy: NetworkPolicy) => {
      network = networkPolicyResult(policy, 'hosted', []);
      for (const listener of listeners) listener({ name: 'network-policy', ...network });
    };
    const command = vi.fn(async (cmd: string, params?: unknown) => {
      if (cmd === 'networkPolicy') return network;
      if (cmd === 'setNetworkPolicy') {
        emit((params as { policy: NetworkPolicy }).policy);
        return network;
      }
      return null;
    });
    platform.burrow = {
      command, respond: () => {}, notify: () => {},
      on: (name: string, listener: (data: unknown) => void) => {
        if (name !== 'network-policy') return () => {};
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    } as unknown as BurrowLink;
    const createProxy = vi.fn(async (target: string) => {
      const { hostname, pathname } = new URL(target);
      const framed = { ok: true as const, url: `${PROXY}${pathname}` };
      if (hostname === 'localhost') return framed;
      if (hostname === '100.101.1.2') {
        return network.policy.allowed.includes(TAILNET) ? framed
          : { ok: false as const, reason: 'external' as const, offer: { label: 'Tailscale', prefixes: [TAILNET] } };
      }
      if (hostname === '192.168.50.7') return { ok: false as const, reason: 'external' as const };
      return { ok: false as const, reason: 'external' as const, publicAddress: true };
    });
    platform.createIframeProxyUrl = createProxy;
    return { command, createProxy, emit };
  }

  /** A pane under {@link policyHost}, whose param writes land back in its props. */
  async function renderGated(url: string, actions: WallActions = stubActions(), policy: NetworkPolicy = { level: 'nothing', allowed: ['10.8.0.0/24'], autoUpdate: false }) {
    const platform = installBrowserHost().platform;
    const host = policyHost(platform, policy);
    const openExternal = vi.fn();
    platform.openExternal = openExternal;
    const writes: Record<string, unknown>[] = [];
    function Pane() {
      const [params, setParams] = useState<Record<string, unknown>>({ url });
      const paneWrite: PaneWriteActions = {
        updateParams: (_id, patch) => { writes.push(patch); setParams((prev) => ({ ...prev, ...patch })); },
        setTitle: () => {},
      };
      return (
        <PaneWriteContext.Provider value={paneWrite}>
          <WallActionsContext.Provider value={actions}>
            <IframePanel id="iframe-external" title="t" params={params} />
          </WallActionsContext.Provider>
        </PaneWriteContext.Provider>
      );
    }
    await act(async () => { root.render(<Pane />); });
    await act(async () => {});
    return { ...host, openExternal, writes };
  }

  it('warns before framing a page on a network not allowed, then frames it once Allow adds that network', async () => {
    const { command, createProxy } = await renderGated(`${TAILNET_PAGE}/guide`);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('Page on another device');
    expect(container.textContent).toContain(TAILNET_PAGE);
    expect(container.textContent).toContain('Pages on a network you allow can reach services on this computer');
    expect(createProxy).toHaveBeenLastCalledWith(`${TAILNET_PAGE}/guide`, expect.any(String));

    await act(async () => { button(`Allow Tailscale (${TAILNET})`)!.click(); });
    await act(async () => {});
    // Added to what the service last answered, its level left alone.
    expect(command).toHaveBeenCalledWith('setNetworkPolicy', {
      policy: { level: 'nothing', allowed: ['10.8.0.0/24', TAILNET], autoUpdate: false },
    });
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(`${PROXY}/guide`);
  });

  it('closes an open preview whose network is removed, and keeps one a change leaves allowed', async () => {
    const { createProxy, emit } = await renderGated(`${TAILNET_PAGE}/guide`, stubActions(), {
      level: 'local', allowed: [TAILNET], autoUpdate: false,
    });
    const framed = container.querySelector('iframe');
    expect(framed?.getAttribute('src')).toBe(`${PROXY}/guide`);

    // Another window adds a network: the host is asked again and still fronts it.
    const asked = createProxy.mock.calls.length;
    await act(async () => { emit({ level: 'local', allowed: [TAILNET, '10.0.0.0/8'], autoUpdate: false }); });
    await act(async () => {});
    expect(createProxy.mock.calls.length).toBe(asked + 1);
    expect(container.querySelector('iframe')).toBe(framed);

    // Settings removes it: the preview gives way to the warning.
    await act(async () => { emit({ level: 'local', allowed: ['10.0.0.0/8'], autoUpdate: false }); });
    await act(async () => {});
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('Page on another device');
  });

  it('offers no Allow for a public page, only agent-browser, the browser, and Cancel', async () => {
    await renderGated(`${EXTERNAL}/guide`);
    expect(container.textContent).toContain('Website on the internet');
    expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim()))
      .toEqual(['Open in agent-browser', 'Open in browser', 'Cancel']);
  });

  it('offers no Allow for a private network this computer is not on, naming Settings instead', async () => {
    await renderGated('http://192.168.50.7/');
    expect(container.textContent).toContain('add its range in Settings → Network');
    expect(button('Open in agent-browser')).toBeDefined();
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.startsWith('Allow'))).toBe(false);
  });

  it('closes the pane on Cancel when there is no page to go back to, and opens the browser on request', async () => {
    const onKill = vi.fn();
    const { openExternal } = await renderGated(`${EXTERNAL}/guide`, stubActions({ onKill }));
    await act(async () => { button('Open in browser')!.click(); });
    expect(openExternal).toHaveBeenCalledWith(`${EXTERNAL}/guide`);
    expect(onKill).toHaveBeenCalledWith('iframe-external');
  });

  it('follows a redirect off the proxy through the gate, in place of the page that redirected', async () => {
    const onKill = vi.fn();
    const { createProxy, writes } = await renderGated('http://localhost:5173/app', stubActions({ onKill }));
    expect(container.querySelector('iframe')).not.toBeNull();
    // A page that is not http(s) never reaches the gate.
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { origin: PROXY, data: { __dormouse: 'navigate', url: 'javascript:alert(1)' } }));
    });
    expect(writes).toEqual([]);

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: PROXY, data: { __dormouse: 'navigate', url: `${EXTERNAL}/login`, from: `${PROXY}/app` },
      }));
    });
    expect(writes).toEqual([{ url: `${EXTERNAL}/login` }]);
    expect(createProxy).toHaveBeenLastCalledWith(`${EXTERNAL}/login`, expect.any(String));
    expect(container.textContent).toContain('Website on the internet');
    // The redirecting entry was replaced, so there is nothing to go back to.
    await act(async () => { button('Cancel')!.click(); });
    expect(onKill).toHaveBeenCalledWith('iframe-external');
  });

  it('goes back on Cancel to the page that led off the proxy', async () => {
    const onKill = vi.fn();
    const { writes } = await renderGated('http://localhost:5173/app', stubActions({ onKill }));
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { origin: PROXY, data: { __dormouse: 'location', url: `${PROXY}/app/page` } }));
    });
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: PROXY, data: { __dormouse: 'navigate', url: `${EXTERNAL}/login`, from: `${PROXY}/elsewhere` },
      }));
    });
    await act(async () => { button('Cancel')!.click(); });
    expect(onKill).not.toHaveBeenCalled();
    expect(writes.at(-1)).toEqual({ url: 'http://localhost:5173/app/page' });
    expect(container.querySelector('iframe')).not.toBeNull();
  });
});
