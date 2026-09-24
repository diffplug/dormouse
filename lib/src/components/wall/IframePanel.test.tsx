/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import type { PaneProps } from './pane-props';
import { IframePanel } from './IframePanel';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import { PaneWriteContext, WallActionsContext, type PaneWriteActions, type WallActions } from './wall-context';
import { stubWallActions as stubActions } from './wall-test-utils';

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
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

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
  // The raw fallback is the case with no proxy in front of it at all — the
  // website, Storybook, the tutorial — so it is not the trusted one. It used to
  // be framed with no sandbox and a full camera/microphone/geolocation/
  // clipboard-read grant, in a webview where the per-site prompt is often
  // absent.
  it('sandboxes the raw fallback and grants no device or clipboard-read permission', async () => {
    const iframe = await renderPanel(stubActions());

    const sandbox = iframe.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-top-navigation');
    const allow = iframe.getAttribute('allow') ?? '';
    for (const forbidden of ['camera', 'microphone', 'geolocation', 'clipboard-read']) {
      expect(allow).not.toContain(forbidden);
    }
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
    // `dor ab open` refuses a non-http(s) target too, so it is not the remedy here.
    expect(container.textContent).not.toContain('dor ab open');
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

    expect(createIframeProxyUrl).toHaveBeenCalledWith('http://localhost:5173');
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
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserOpen'>;
    platform.agentBrowserOpen = vi.fn();
    setPlatform(platform);
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

  it('maps proxied frame location messages into chrome without updating params', async () => {
    const updateParameters = vi.fn();
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserOpen' | 'createIframeProxyUrl'>;
    platform.agentBrowserOpen = vi.fn();
    platform.createIframeProxyUrl = vi.fn(async () => ({
      ok: true,
      url: 'http://127.0.0.1:61234/app',
      upstream: 'http://example.test/app',
    }));
    setPlatform(platform);
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

  it('re-resolves the proxy on Back after an observed in-frame navigation', async () => {
    const updateParameters = vi.fn();
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserOpen' | 'createIframeProxyUrl'>;
    platform.agentBrowserOpen = vi.fn();
    // Fixed URL so the proxy origin stays stable (the message handler gates on
    // it); re-resolution is observed via the call count, not a changed src.
    const createProxy = vi.fn(async () => ({ ok: true, url: 'http://127.0.0.1:61234/app' }));
    platform.createIframeProxyUrl = createProxy;
    setPlatform(platform);
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

describe('iframe failures offer a way out', () => {
  const PROXY = 'http://127.0.0.1:61234';
  function proxyPlatform(result: Awaited<ReturnType<NonNullable<PlatformAdapter['createIframeProxyUrl']>>> = { ok: true, url: `${PROXY}/app` }, swapCapable = true) {
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserOpen' | 'createIframeProxyUrl'>;
    if (swapCapable) platform.agentBrowserOpen = vi.fn();
    platform.createIframeProxyUrl = vi.fn(async () => result);
    setPlatform(platform);
    return platform;
  }
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
      expect(onSwapRenderMode).toHaveBeenCalledWith('iframe-uninstrumented', 'ab-screencast');

      const resolved = vi.mocked(platform.createIframeProxyUrl).mock.calls.length;
      await act(async () => { button('Reload')!.click(); });
      expect(vi.mocked(platform.createIframeProxyUrl).mock.calls.length).toBeGreaterThan(resolved);
      expect(banner()).toBeNull();

      // Flagged again, then a later report from the shim clears it.
      await report();
      await act(async () => { vi.advanceTimersByTime(2000); });
      await act(async () => { iframe.dispatchEvent(new Event('load')); });
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
    expect(container.textContent).toContain('dor ab open https://example.com/');
    await act(async () => { button('Open in agent-browser')!.click(); });
    expect(onSwapRenderMode).toHaveBeenCalledWith('iframe-https', 'ab-screencast');

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
    expect(container.textContent).toContain('dor ab open https://example.com/');
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
  // A tool's `render` is `iframe` or `ab-screencast`, so pop-out has no
  // renderer to land in: offering it tears the browser down and re-derives the
  // same screencast, so the user asks for a native window and gets a reload;
  // and a Playwright mode would be written as its render and launch nothing.
  // `FakePtyAdapter` launches no browser, so every mode would be absent off the
  // stock fake — make the host capable first, or the assertion is vacuous.
  function withCapableHost() {
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserOpen' | 'agentBrowserPopOut' | 'playwright'>;
    platform.agentBrowserOpen = async () => ({ ok: true });
    platform.agentBrowserPopOut = async () => ({ ok: true });
    platform.playwright = async () => ({ ok: true });
    setPlatform(platform);
  }

  it('offers every mode on a plain browser surface', async () => {
    withCapableHost();
    await renderPanel(stubActions({}), {
      id: 'iframe-plain',
      title: 'Plain',
      params: { surfaceType: 'browser', url: 'http://example.test/app' },
    });
    expect(getAgentBrowserScreenController('iframe-plain')?.renderModes)
      .toEqual(['ab-screencast', 'ab-popout', 'pw-screencast', 'pw-popout', 'iframe']);
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
    expect(controller.renderModes).toEqual(['ab-screencast', 'iframe']);
    await act(async () => {
      controller.actions.setRenderMode?.('pw-screencast');
      controller.actions.setRenderMode?.('ab-popout');
      controller.actions.setRenderMode?.('ab-screencast');
    });
    expect(onSwapRenderMode).toHaveBeenCalledExactlyOnceWith('iframe-tool', 'ab-screencast');
  });
});
