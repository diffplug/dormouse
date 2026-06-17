/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { PlatformAdapter } from '../../lib/platform/types';
import { IframePanel } from './IframePanel';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import { WallActionsContext, type WallActions } from './wall-context';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function stubActions(overrides: Partial<WallActions> = {}): WallActions {
  return {
    onKill: vi.fn(),
    onMinimize: vi.fn(),
    onAlertButton: vi.fn(() => 'noop'),
    onToggleTodo: vi.fn(),
    onSplitH: vi.fn(),
    onSplitV: vi.fn(),
    onZoom: vi.fn(),
    onClickPanel: vi.fn(),
    onFocusPane: vi.fn(),
    onStartRename: vi.fn(),
    onFinishRename: vi.fn(() => ({ accepted: true })),
    onCancelRename: vi.fn(),
    onSwapRenderMode: vi.fn(),
    ...overrides,
  };
}

function panelProps(id: string, updateParameters = vi.fn()): IDockviewPanelProps<{ url: string }> {
  return {
    api: { id, title: 'Raw iframe', updateParameters, setTitle: vi.fn() },
    params: { url: 'http://example.test/app' },
  } as unknown as IDockviewPanelProps<{ url: string }>;
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

async function renderPanel(actions: WallActions, props = panelProps('iframe-raw')): Promise<HTMLIFrameElement> {
  await act(async () => {
    root.render(
      <WallActionsContext.Provider value={actions}>
        <IframePanel {...props} />
      </WallActionsContext.Provider>,
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
    await renderPanel(stubActions(), panelProps('iframe-history', updateParameters));

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

  it('maps proxied frame location messages back to the upstream URL', async () => {
    const updateParameters = vi.fn();
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserOpen' | 'createIframeProxyUrl'>;
    platform.agentBrowserOpen = vi.fn();
    platform.createIframeProxyUrl = vi.fn(async () => ({
      ok: true,
      url: 'http://127.0.0.1:61234/app',
      upstream: 'http://example.test/app',
    }));
    setPlatform(platform);
    await renderPanel(stubActions(), panelProps('iframe-proxied', updateParameters));

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'http://127.0.0.1:61234',
        data: { __dormouse: 'location', url: 'http://127.0.0.1:61234/other/?q=1#frag' },
      }));
    });

    expect(updateParameters).toHaveBeenLastCalledWith({ url: 'http://example.test/other/?q=1#frag' });
  });
});
