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
  it('adopts clicks into the raw iframe fallback via window blur focus', async () => {
    const onClickPanel = vi.fn();
    const actions = stubActions({ onClickPanel });
    const iframe = await renderPanel(actions);

    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(onClickPanel).toHaveBeenCalledWith('iframe-raw');
  });

  it('does not adopt a raw iframe blur when the app itself lost focus', async () => {
    const onClickPanel = vi.fn();
    const actions = stubActions({ onClickPanel });
    const iframe = await renderPanel(actions);

    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(onClickPanel).not.toHaveBeenCalled();
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

describe('the pop-out affordance on a tool (regression: PR #493 review)', () => {
  // A tool's `render` is `iframe` or `ab-screencast`, so pop-out has no
  // renderer to land in: offering it tears the browser down and re-derives the
  // same screencast, so the user asks for a native window and gets a reload.
  // `FakePtyAdapter` has no `agentBrowserPopOut`, so both cases would read
  // `false` off the stock fake — attach one first, or the assertion is vacuous.
  function withPopOutCapableHost() {
    const platform = new FakePtyAdapter() as FakePtyAdapter & { agentBrowserPopOut: () => Promise<unknown> };
    platform.agentBrowserPopOut = async () => ({ ok: true });
    setPlatform(platform);
  }

  it('offers pop-out on a plain browser surface', async () => {
    withPopOutCapableHost();
    await renderPanel(stubActions({}), {
      id: 'iframe-plain',
      title: 'Plain',
      params: { surfaceType: 'browser', url: 'http://example.test/app' },
    });
    expect(getAgentBrowserScreenController('iframe-plain')?.canPopOut).toBe(true);
  });

  it('never offers it on a tool', async () => {
    withPopOutCapableHost();
    await renderPanel(stubActions({}), {
      id: 'iframe-tool',
      title: 'storybook',
      params: { surfaceType: 'tool', url: 'http://localhost:6006/' },
    });
    expect(getAgentBrowserScreenController('iframe-tool')?.canPopOut).toBe(false);
  });
});
