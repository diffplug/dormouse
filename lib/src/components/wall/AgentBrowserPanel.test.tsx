/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { PaneProps } from './pane-props';
import { AgentBrowserPanel, HIDDEN_PARK_DELAY_MS } from './AgentBrowserPanel';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import {
  closeBrowserSurface,
  disposeAgentBrowserSurfaceController,
  disposeAllAgentBrowserSurfaceControllers,
  getAgentBrowserSurfaceController,
  handOverBrowserStream,
} from './agent-browser-surface-controller';
import type { RenderMode } from './agent-browser-screen';
import { ModeContext, PaneWriteContext, SelectedIdContext, WallActionsContext, WorkspaceActiveContext, type PaneWriteActions } from './wall-context';
import { installBrowserHost, stubWallActions as stubActions } from './wall-test-utils';
import { encodeViewerFrame } from '../../lib/platform/browser-automation';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type TestPanelParams = {
  surfaceType: string;
  renderMode?: string;
  session: string;
  stream?: number;
  url?: string;
  poppedOut?: boolean;
  cwd?: string;
};

const DEFAULT_PARAMS: TestPanelParams = { surfaceType: 'agent-browser', session: 'browser-session' };

/** The operations that drive a live browser, rather than bind or view one. */
const DRIVES = new Set(['navigate', 'history', 'tab', 'viewport', 'device', 'close']);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}


function paneProps(id: string, params: TestPanelParams = DEFAULT_PARAMS): PaneProps {
  const props = { id, title: 'Browser', params };
  handOverFixtureStream(props);
  return props;
}

// The panel's title/param writes route through PaneWriteContext now; forward
// updateParams' patch to the test's mock so its assertions stay unchanged.
function paneWriteFor(updateParameters: (patch: Record<string, unknown>) => void): PaneWriteActions {
  return { updateParams: (_id, patch) => updateParameters(patch), setTitle: () => {} };
}

class WebSocketMock {
  static instances: WebSocketMock[] = [];
  static OPEN = 1;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  sent: string[] = [];

  constructor(public url: string) {
    WebSocketMock.instances.push(this);
    queueMicrotask(() => this.onopen?.(new Event('open')));
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }

  emitMessage(data: string | ArrayBuffer) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('WebSocket', WebSocketMock);
  WebSocketMock.instances = [];
  // A host granting every viewer socket, at the stream's number as its port.
  installBrowserHost();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  // Controllers now outlive panel unmount and this suite reuses the id
  // 'ab-panel', so release them or the next test would reuse a stale controller
  // bound to old platform mocks.
  disposeAllAgentBrowserSurfaceControllers();
  handedOver.clear();
  container.remove();
  vi.restoreAllMocks();
  setPlatform(new FakePtyAdapter());
});

// `dor` hands a stream port straight to the Surface's controller, never
// through params. These fixtures carry it in their params, so hand each new one
// over the way the Wall does, with the params the command refreshed.
const handedOver = new Map<string, number>();
function handOverFixtureStream({ id, params }: PaneProps): void {
  const fixture = params as TestPanelParams | undefined;
  if (fixture?.stream === undefined || handedOver.get(id) === fixture.stream) return;
  handedOver.set(id, fixture.stream);
  handOverBrowserStream(id, { ...fixture, renderMode: fixture.renderMode as RenderMode | undefined }, fixture.stream);
}

async function renderPanel(
  props: PaneProps = paneProps('ab-panel'),
  updateParameters: (patch: Record<string, unknown>) => void = () => {},
): Promise<void> {
  await act(async () => {
    root.render(
      <StrictMode>
        <PaneWriteContext.Provider value={paneWriteFor(updateParameters)}>
          <WallActionsContext.Provider value={stubActions()}>
            <AgentBrowserPanel {...props} />
          </WallActionsContext.Provider>
        </PaneWriteContext.Provider>
      </StrictMode>,
    );
  });
}

describe('AgentBrowserPanel placeholders', () => {
  // A bare `dor agent-browser open` drives the caller's default key, which for a keyed or
  // GUI-launched pane is a different browser; the internal session name means
  // nothing to the person reading it.
  it.each([
    ['agent-browser-screencast', 'dor agent-browser'],
    ['playwright-screencast', 'dor playwright'],
  ])('names this pane in its command, never the raw session (%s)', async (renderMode, cli) => {
    setPlatform(new FakePtyAdapter());
    await act(async () => {
      root.render(
        <PaneWriteContext.Provider value={paneWriteFor(() => {})}>
          <WallActionsContext.Provider value={stubActions({ resolveSurfaceRef: () => 'surface:7' })}>
            <AgentBrowserPanel {...paneProps('ab-placeholder', { surfaceType: 'browser', renderMode, session: 'dormouse.1.gui-5f3a' })} />
          </WallActionsContext.Provider>
        </PaneWriteContext.Provider>,
      );
    });

    expect(container.textContent).toContain(`run ${cli} --surface surface:7 open <url>`);
    expect(container.textContent).not.toContain('dormouse.1.gui-5f3a');
  });
});

describe('AgentBrowserPanel render mode controller', () => {
  it('relaunches screencast sessions as popout and publishes the mode immediately', async () => {
    const updateParameters = vi.fn();
    const host = installBrowserHost({
      launch: async () => ({ ok: true, stream: 3456 }),
      attach: async () => ({ ok: true, stream: 1234 }),
    });

    await renderPanel(paneProps('ab-panel'), updateParameters);

    await act(async () => {
      getAgentBrowserScreenController('ab-panel')?.actions.setRenderMode?.('agent-browser-popout');
    });

    expect(host.requests('launch')).toEqual([{ provider: 'agent-browser', binding: { session: 'browser-session' }, op: 'launch', headed: true }]);
    expect(updateParameters).toHaveBeenCalledWith({ renderMode: 'agent-browser-popout' });
    expect(getAgentBrowserScreenController('ab-panel')?.snapshot().renderMode).toBe('agent-browser-popout');
    expect(container.textContent).toContain('This browser is running in a separate window.');
    expect(WebSocketMock.instances.some((ws) => ws.url === 'ws://127.0.0.1:3456')).toBe(true);
  });

  it('relaunches popped-out sessions back into screencast', async () => {
    const updateParameters = vi.fn();
    const host = installBrowserHost({
      launch: async () => ({ ok: true, stream: 4567 }),
      attach: async () => ({ ok: true, stream: 1234 }),
    });

    await renderPanel(
      paneProps('ab-panel', { surfaceType: 'browser', renderMode: 'agent-browser-popout', session: 'browser-session' }),
      updateParameters,
    );

    expect(getAgentBrowserScreenController('ab-panel')?.snapshot().renderMode).toBe('agent-browser-popout');

    await act(async () => {
      getAgentBrowserScreenController('ab-panel')?.actions.setRenderMode?.('agent-browser-screencast');
    });

    expect(host.requests('launch')).toEqual([expect.objectContaining({ provider: 'agent-browser', binding: { session: 'browser-session' }, op: 'launch', headed: false })]);
    expect(updateParameters).toHaveBeenCalledWith({ renderMode: 'agent-browser-screencast' });
    expect(getAgentBrowserScreenController('ab-panel')?.snapshot().renderMode).toBe('agent-browser-screencast');
  });

  it('pop-in uses the latest observed headed-window tab URL over stale params', async () => {
    const updateParameters = vi.fn();
    const host = installBrowserHost({
      launch: async () => ({ ok: true, stream: 4567 }),
      attach: async () => ({ ok: true, stream: 1234 }),
    });

    await renderPanel(
      paneProps('ab-panel', {
        surfaceType: 'browser',
        renderMode: 'agent-browser-popout',
        session: 'browser-session',
        stream: 1111,
        url: 'https://google.com/',
      }),
      updateParameters,
    );

    await act(async () => {
      WebSocketMock.instances[0]?.emitMessage(JSON.stringify({
        type: 'tabs',
        tabs: [{ tabId: 'tab-1', title: 'Example Domain', url: 'https://example.com/', active: true }],
      }));
    });

    expect(updateParameters).toHaveBeenCalledWith({ url: 'https://example.com/' });

    await act(async () => {
      getAgentBrowserScreenController('ab-panel')?.actions.setRenderMode?.('agent-browser-screencast');
    });

    expect(host.requests('launch')).toEqual([expect.objectContaining({
      provider: 'agent-browser', binding: { session: 'browser-session' }, op: 'launch', url: 'https://example.com/', headed: false,
    })]);
  });

  it('mirrors popped-out stream tab URL updates when the stream reports id instead of tabId', async () => {
    const updateParameters = vi.fn();
    installBrowserHost({ attach: async () => ({ ok: true, stream: 1234 }) });

    await renderPanel(
      paneProps('ab-panel', {
        surfaceType: 'browser',
        renderMode: 'agent-browser-popout',
        session: 'browser-session',
        stream: 1111,
        url: 'https://google.com/',
      }),
      updateParameters,
    );

    await act(async () => {
      WebSocketMock.instances[0]?.emitMessage(JSON.stringify({
        type: 'tabs',
        tabs: [{ id: 'tab-1', title: 'Example Domain', url: 'https://example.com/', active: true }],
      }));
    });

    expect(updateParameters).toHaveBeenCalledWith({ url: 'https://example.com/' });
  });

  it('mirrors a popped-out window\'s page as the host observes it, holding no CDP itself', async () => {
    const updateParameters = vi.fn();
    const host = installBrowserHost({ attach: async () => ({ ok: true, stream: 1234 }) });

    await renderPanel(
      paneProps('ab-panel', {
        surfaceType: 'browser',
        renderMode: 'agent-browser-popout',
        session: 'browser-session',
        stream: 1111,
        url: 'https://google.com/',
      }),
      updateParameters,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Its one socket is the host's viewer, told it shows a headed window.
    expect(host.requests('view')).toEqual([{ provider: 'agent-browser', binding: { session: 'browser-session' }, op: 'view', stream: 1111, headed: true }]);
    expect(WebSocketMock.instances.map((ws) => ws.url)).toEqual(['ws://127.0.0.1:1111']);

    await act(async () => {
      WebSocketMock.instances[0].emitMessage(JSON.stringify({ type: 'page', url: 'https://example.com/', title: 'Example Domain' }));
    });

    expect(updateParameters).toHaveBeenCalledWith({ url: 'https://example.com/' });

    // The new-tab page the launch opened beside it is not the page it shows.
    await act(async () => {
      WebSocketMock.instances[0].emitMessage(JSON.stringify({ type: 'page', url: 'chrome://newtab/', title: 'New Tab' }));
    });
    expect(getAgentBrowserScreenController('ab-panel')?.chrome().url).toBe('https://example.com/');
  });

  it('actively selects a newly opened tab when the stream does not mark it active', async () => {
    const host = installBrowserHost();

    await renderPanel(paneProps('ab-panel', { surfaceType: 'browser', session: 'browser-session', stream: 1111 }));

    await act(async () => {
      WebSocketMock.instances.at(-1)?.emitMessage(JSON.stringify({
        type: 'tabs',
        tabs: [{ tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true }],
      }));
    });

    await act(async () => {
      WebSocketMock.instances.at(-1)?.emitMessage(JSON.stringify({
        type: 'tabs',
        tabs: [
          { tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true },
          { tabId: 't2', title: 'GitHub', url: 'https://github.com/diffplug/dormouse', active: false },
        ],
      }));
    });

    expect(host.requests('tab')).toContainEqual({ provider: 'agent-browser', binding: { session: 'browser-session' }, op: 'tab', action: 'select', tabId: 't2' });
  });

  it('does not force-select a provisional new tab that already reports active', async () => {
    const host = installBrowserHost();

    await renderPanel(paneProps('ab-panel', { surfaceType: 'browser', session: 'browser-session', stream: 1111 }));

    await act(async () => {
      WebSocketMock.instances.at(-1)?.emitMessage(JSON.stringify({
        type: 'tabs',
        tabs: [{ tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true }],
      }));
    });

    await act(async () => {
      WebSocketMock.instances.at(-1)?.emitMessage(JSON.stringify({
        type: 'tabs',
        tabs: [
          { tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: false },
          { tabId: 't2', title: 'Dormouse', url: 'https://dormouse.sh/', active: true },
        ],
      }));
    });

    expect(host.browser.mock.calls.map(([request]) => request.op).filter((op) => DRIVES.has(op))).toEqual([]);
  });

  it('selects a provisional new tab after it reaches its destination if it is not active', async () => {
    const host = installBrowserHost();

    await renderPanel(paneProps('ab-panel', { surfaceType: 'browser', session: 'browser-session', stream: 1111 }));

    await act(async () => {
      WebSocketMock.instances.at(-1)?.emitMessage(JSON.stringify({
        type: 'tabs',
        tabs: [{ tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true }],
      }));
    });

    await act(async () => {
      WebSocketMock.instances.at(-1)?.emitMessage(JSON.stringify({
        type: 'tabs',
        tabs: [
          { tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: false },
          { tabId: 't2', title: 'Dormouse', url: 'https://dormouse.sh/', active: true },
        ],
      }));
    });

    await act(async () => {
      WebSocketMock.instances.at(-1)?.emitMessage(JSON.stringify({
        type: 'tabs',
        tabs: [
          { tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true },
          { tabId: 't2', title: 'GitHub', url: 'https://github.com/diffplug/dormouse', active: false },
        ],
      }));
    });

    expect(host.requests('tab')).toContainEqual({ provider: 'agent-browser', binding: { session: 'browser-session' }, op: 'tab', action: 'select', tabId: 't2' });
  });

  it('keeps the last known active tab when the stream emits a transient empty tab list', async () => {
    const updateParameters = vi.fn();
    await renderPanel(
      paneProps('ab-panel', { surfaceType: 'browser', session: 'browser-session', stream: 1111 }),
      updateParameters,
    );

    await act(async () => {
      WebSocketMock.instances.at(-1)?.emitMessage(JSON.stringify({
        type: 'tabs',
        tabs: [{ tabId: 't2', title: 'GitHub', url: 'https://github.com/diffplug/dormouse', active: true }],
      }));
    });

    expect(getAgentBrowserScreenController('ab-panel')?.chrome().url).toBe('https://github.com/diffplug/dormouse');

    await act(async () => {
      WebSocketMock.instances.at(-1)?.emitMessage(JSON.stringify({ type: 'tabs', tabs: [] }));
    });

    expect(getAgentBrowserScreenController('ab-panel')?.chrome().url).toBe('https://github.com/diffplug/dormouse');
  });

  it('swaps straight to iframe with no extra tabs (no confirm gate)', async () => {
    const onSwapRenderMode = vi.fn();
    await act(async () => {
      root.render(
        <StrictMode>
          <WallActionsContext.Provider value={stubActions({ onSwapRenderMode })}>
            <AgentBrowserPanel {...paneProps('ab-panel')} />
          </WallActionsContext.Provider>
        </StrictMode>,
      );
    });

    // A single-tab (here zero-tab) session has nothing to lose, so the swap is
    // issued immediately; the ≥2-tab confirm gate is exercised only in the GUI.
    await act(async () => {
      getAgentBrowserScreenController('ab-panel')?.actions.setRenderMode?.('iframe');
    });

    expect(onSwapRenderMode).toHaveBeenCalledWith('ab-panel', 'iframe');
  });
});

describe('AgentBrowserPanel Playwright params', () => {
  // `dor playwright open --headed` relaunches the native browser outside Dormouse; the
  // Wall records the host-reported mode (and a fresh viewer port) in params,
  // which reach the controller only through this panel.
  it('follows a native headed relaunch and its cwd, and never sizes the headed window', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const host = installBrowserHost();
    // Every operation that drives the browser.
    const commands = () => host.browser.mock.calls.map(([request]) => request.op).filter((op) => DRIVES.has(op));
    const stream = (port: number) => WebSocketMock.instances.findLast((ws) => ws.url === `ws://127.0.0.1:${port}`)!;
    // The pane sizes the host was asked to sync each stream's browser to.
    const synced = (port: number) => stream(port).sent.map((raw) => JSON.parse(raw))
      .filter((message) => message.type === 'sync').map(({ width, height, dpr }) => `${width}x${height}@${dpr}`);
    const params = { surfaceType: 'browser', renderMode: 'playwright-screencast', session: 'app', cwd: '/first', stream: 4321, browserViewport: { mode: 'pane-sync' }, syncEngaged: true } as const;

    await renderPanel(paneProps('pw-panel', params));
    await vi.waitFor(() => expect(synced(4321)).toContain('800x600@1'));
    await act(async () => { stream(4321).emitMessage(JSON.stringify({ type: 'status', connected: true, screencasting: true })); });
    host.browser.mockClear();

    await renderPanel(paneProps('pw-panel', { ...params, renderMode: 'playwright-popout', stream: 4322 }));
    expect(getAgentBrowserScreenController('pw-panel')?.snapshot().renderMode).toBe('playwright-popout');
    expect(container.textContent).toContain('This browser is running in a separate window.');
    expect(commands()).toEqual([]);
    expect(synced(4322)).toEqual([]);
    // The old browser's status is not the new window's: a disconnect before
    // the new stream reports is not the user closing that window.
    await act(async () => { stream(4322).emitMessage(JSON.stringify({ type: 'status', connected: false, screencasting: false })); });
    expect(host.requests('launch')).toEqual([]);

    await renderPanel(paneProps('pw-panel', { ...params, cwd: '/second', stream: 4323 }));
    expect(getAgentBrowserScreenController('pw-panel')?.snapshot().renderMode).toBe('playwright-screencast');
    await vi.waitFor(() => expect(synced(4323)).toContain('800x600@1'));
    // The browser it views runs in the new directory.
    expect(host.requests('view').at(-1)).toMatchObject({ binding: { cwd: '/second' }, stream: 4323 });
  });

  it('keeps its own mode write over params that predate it', async () => {
    const host = installBrowserHost({ launch: async () => ({ ok: true, stream: 4330 }) });
    const updateParameters = vi.fn();
    const popped = { surfaceType: 'browser', renderMode: 'playwright-popout', session: 'app', cwd: '/p', stream: 4321 };
    await renderPanel(paneProps('pw-panel', popped), updateParameters);
    const stream = WebSocketMock.instances.findLast((ws) => ws.url === 'ws://127.0.0.1:4321')!;
    await act(async () => { stream.emitMessage(JSON.stringify({ type: 'status', connected: true, screencasting: false })); });

    // Minimized, the user closes the headed window: auto-revert pops the pane
    // back in and buffers its `renderMode` write until the next attach.
    await act(async () => { root.render(<div />); });
    await act(async () => { stream.emitMessage(JSON.stringify({ type: 'status', connected: false, screencasting: false })); });
    expect(host.requests('launch')).toEqual([expect.objectContaining({
      provider: 'playwright', binding: expect.objectContaining({ session: 'app' }), op: 'launch', headed: false,
    })]);
    expect(updateParameters).not.toHaveBeenCalledWith(expect.objectContaining({ renderMode: 'playwright-screencast' }));

    // Reattached with the params the store still held: they predate the write.
    await renderPanel(paneProps('pw-panel', popped), updateParameters);
    expect(updateParameters).toHaveBeenCalledWith(expect.objectContaining({ renderMode: 'playwright-screencast' }));
    expect(getAgentBrowserScreenController('pw-panel')?.snapshot().renderMode).toBe('playwright-screencast');

    // Once params show it, a later host report is followed again.
    await renderPanel(paneProps('pw-panel', { ...popped, renderMode: 'playwright-screencast', stream: 4330 }), updateParameters);
    await renderPanel(paneProps('pw-panel', { ...popped, stream: 4331 }), updateParameters);
    expect(getAgentBrowserScreenController('pw-panel')?.snapshot().renderMode).toBe('playwright-popout');
  });
});

describe('AgentBrowserPanel across a provider change', () => {
  // A minimized pane keeps this view mounted while its Wall restores a failed
  // cross-provider swap in place: same id, the other provider's params.
  function withBothProviders() {
    installBrowserHost();
  }
  const pw = { surfaceType: 'browser', renderMode: 'playwright-screencast', session: 'failed-swap', stream: 4400 };
  const ab = { surfaceType: 'browser', renderMode: 'agent-browser-screencast', session: 'relaunched', stream: 4401 };

  it('takes a fresh controller when the Wall disposes the old one and restores the other provider', async () => {
    withBothProviders();
    await renderPanel(paneProps('swap-panel', pw));
    const failed = getAgentBrowserSurfaceController('swap-panel');
    await act(async () => { disposeAgentBrowserSurfaceController('swap-panel'); });
    await renderPanel(paneProps('swap-panel', ab));

    const restored = getAgentBrowserSurfaceController('swap-panel');
    expect(restored).not.toBeNull();
    expect(restored).not.toBe(failed);
    expect(getAgentBrowserScreenController('swap-panel')?.snapshot().renderMode).toBe('agent-browser-screencast');
    // The relaunched session's binding reaches the live controller.
    await act(async () => { await Promise.resolve(); });
    expect(WebSocketMock.instances.some((ws) => ws.url.includes('4401'))).toBe(true);
  });

  it('replaces a controller of the other provider even when nothing disposed it', async () => {
    withBothProviders();
    await renderPanel(paneProps('swap-panel', pw));
    const failed = getAgentBrowserSurfaceController('swap-panel')!;
    // No port handover, which would acquire the controller itself.
    await renderPanel(paneProps('swap-panel', { ...ab, stream: undefined }));
    await act(async () => { await Promise.resolve(); });
    expect(getAgentBrowserSurfaceController('swap-panel')).not.toBe(failed);
    expect(getAgentBrowserScreenController('swap-panel')?.snapshot().renderMode).toBe('agent-browser-screencast');
    // The replaced one is released, its stream with it.
    expect(WebSocketMock.instances.filter((ws) => ws.url.includes('4400')).every((ws) => ws.readyState === 3)).toBe(true);
  });
});

describe('AgentBrowserPanel after its controller is released', () => {
  it('takes a fresh controller for the params that follow, and none for the release alone', async () => {
    const host = installBrowserHost({ attach: async () => ({ ok: true, stream: 4402 }) });
    const first = { surfaceType: 'browser', renderMode: 'agent-browser-screencast', session: 'first-run', stream: 4400 };
    await renderPanel(paneProps('released-panel', first));
    const released = getAgentBrowserSurfaceController('released-panel');

    // A kill releases it as the pane starts to fade: nothing comes back.
    await act(async () => { await closeBrowserSurface('released-panel', first); });
    expect(getAgentBrowserSurfaceController('released-panel')).toBeNull();

    // A Tool's next run names a new session on the same Surface.
    await renderPanel(paneProps('released-panel', { surfaceType: 'browser', renderMode: 'agent-browser-screencast', session: 'next-run' }));
    await act(async () => { await Promise.resolve(); });
    const next = getAgentBrowserSurfaceController('released-panel');
    expect(next).not.toBeNull();
    expect(next).not.toBe(released);
    expect(host.requests('attach')).toContainEqual(expect.objectContaining({ binding: { session: 'next-run' } }));
  });
});

describe('AgentBrowserPanel visibility parking', () => {
  // Three things hide a surface (`useSurfaceVisibility`): a backgrounded window,
  // a hidden Workspace, and a PARKED leaf — minimized, so mounted but out of the
  // tree (docs/specs/tiling-engine.md → "Parked leaves"). A window transition is a
  // `visibilitychange` event, driven here by overriding `document.visibilityState`;
  // a Workspace and a park transition are both props, driven by re-rendering.
  function setDocumentHidden(hidden: boolean): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
  }

  async function renderVisibilityPanel(
    params: TestPanelParams,
  ): Promise<{
    setVisible: (visible: boolean) => void;
    setParked: (parked: boolean) => void;
    setWorkspaceActive: (active: boolean) => void;
  }> {
    setDocumentHidden(false); // mount on-screen
    const render = (parked: boolean, workspaceActive = true) => {
      root.render(
        <StrictMode>
          <WorkspaceActiveContext.Provider value={workspaceActive}>
            <PaneWriteContext.Provider value={paneWriteFor(() => {})}>
              <WallActionsContext.Provider value={stubActions()}>
                <AgentBrowserPanel {...paneProps('ab-panel', params)} parked={parked} />
              </WallActionsContext.Provider>
            </PaneWriteContext.Provider>
          </WorkspaceActiveContext.Provider>
        </StrictMode>,
      );
    };
    await act(async () => { render(false); });
    return {
      setVisible: (visible) => {
        setDocumentHidden(!visible);
        document.dispatchEvent(new Event('visibilitychange'));
      },
      setParked: (parked) => { render(parked); },
      setWorkspaceActive: (active) => { render(false, active); },
    };
  }

  const streamSockets = (port: number) =>
    WebSocketMock.instances.filter((ws) => ws.url === `ws://127.0.0.1:${port}`);
  const liveStreamSocket = (port: number) => streamSockets(port).at(-1);

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  });

  it('parks a hidden panel: closes the stream and opens no replacement', async () => {
    const { setVisible } = await renderVisibilityPanel({
      surfaceType: 'browser', session: 'browser-session', stream: 4321,
    });

    const socket = liveStreamSocket(4321);
    expect(socket?.readyState).toBe(1);
    const before = streamSockets(4321).length;

    await act(async () => { setVisible(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50); });

    // The live socket is torn down and nothing reconnects while hidden.
    expect(socket?.readyState).toBe(3);
    expect(streamSockets(4321).length).toBe(before);
  });

  it('parks a minimized (parked) panel even while the window stays in the foreground', async () => {
    const { setParked } = await renderVisibilityPanel({
      surfaceType: 'browser', session: 'browser-session', stream: 4321,
    });

    const socket = liveStreamSocket(4321);
    expect(socket?.readyState).toBe(1);
    const before = streamSockets(4321).length;

    // Minimize: the leaf stays mounted so the screencast canvas survives, but it is
    // showing nothing, so it must stop pulling frames.
    await act(async () => { setParked(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50); });
    expect(socket?.readyState).toBe(3);
    expect(streamSockets(4321).length).toBe(before);

    // Reattach reconnects without the panel ever having unmounted.
    await act(async () => { setParked(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(streamSockets(4321).length).toBeGreaterThan(before);
    expect(liveStreamSocket(4321)?.readyState).toBe(1);
  });

  it('idles a screencast whose Workspace is hidden, and resumes it on return', async () => {
    const { setWorkspaceActive } = await renderVisibilityPanel({
      surfaceType: 'browser', session: 'browser-session', stream: 4321,
    });

    const socket = liveStreamSocket(4321);
    expect(socket?.readyState).toBe(1);
    const before = streamSockets(4321).length;

    // The Wall stays mounted and live; only its visibility changed.
    await act(async () => { setWorkspaceActive(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50); });
    expect(socket?.readyState).toBe(3);
    expect(streamSockets(4321).length).toBe(before);

    await act(async () => { setWorkspaceActive(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(streamSockets(4321).length).toBeGreaterThan(before);
    expect(liveStreamSocket(4321)?.readyState).toBe(1);
  });

  it('reconnects and repaints from the stream when it becomes visible again', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4, height: 4, close: vi.fn() })));

    const { setVisible } = await renderVisibilityPanel({
      surfaceType: 'browser', session: 'browser-session', stream: 4321,
    });

    await act(async () => { setVisible(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50); });
    const parkedCount = streamSockets(4321).length;

    await act(async () => { setVisible(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // A fresh socket to the same port replaces the parked one.
    expect(streamSockets(4321).length).toBeGreaterThan(parkedCount);
    const reconnected = liveStreamSocket(4321);
    expect(reconnected?.readyState).toBe(1);

    // The host's first frame over the reconnected socket paints.
    await act(async () => {
      reconnected?.emitMessage(encodeViewerFrame({ kind: 'provisional', jpeg: new Uint8Array([0xff, 0xd8, 1]) }).buffer);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(createImageBitmap).toHaveBeenCalledOnce();
  });

  it('does not park a popped-out panel while it is hidden', async () => {
    const { setVisible } = await renderVisibilityPanel({
      surfaceType: 'browser', renderMode: 'agent-browser-popout', session: 'browser-session', stream: 1111,
    });

    const socket = liveStreamSocket(1111);
    expect(socket?.readyState).toBe(1);

    await act(async () => { setVisible(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50); });

    // Popped out is exempt: the stream observer that drives window-close
    // auto-revert must keep running.
    expect(socket?.readyState).toBe(1);
  });

  it('parks when the document is hidden (raw visibilitychange event)', async () => {
    await renderVisibilityPanel({
      surfaceType: 'browser', session: 'browser-session', stream: 4321,
    });

    const socket = liveStreamSocket(4321);
    expect(socket?.readyState).toBe(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50); });
    expect(socket?.readyState).toBe(3);
  });

  it('does not park when a hide is reversed within the delay', async () => {
    const { setVisible } = await renderVisibilityPanel({
      surfaceType: 'browser', session: 'browser-session', stream: 4321,
    });

    const socket = liveStreamSocket(4321);
    expect(socket?.readyState).toBe(1);

    await act(async () => { setVisible(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS / 2); });
    await act(async () => { setVisible(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS); });

    expect(socket?.readyState).toBe(1);
  });
});

describe('AgentBrowserPanel canvas input forwarding', () => {
  // The pane that `dor agent-browser open` creates is not the selected pane (the terminal
  // is), so the FIRST click on the browser surface must still reach the page —
  // it is the click that selects the pane. Mouse-down/up therefore gate on
  // passthrough mode alone, not full `interactive` (mode && selected).
  async function renderWithMode(
    mode: 'passthrough' | 'command',
    selectedId: string | null,
    workspaceActive = true,
  ): Promise<HTMLCanvasElement> {
    const props = paneProps('ab-panel', { surfaceType: 'agent-browser', session: 'browser-session', stream: 4321 });
    await act(async () => {
      root.render(
        <StrictMode>
          <WorkspaceActiveContext.Provider value={workspaceActive}>
            <PaneWriteContext.Provider value={paneWriteFor(() => {})}>
              <WallActionsContext.Provider value={stubActions()}>
                <ModeContext.Provider value={mode}>
                  <SelectedIdContext.Provider value={selectedId}>
                    <AgentBrowserPanel {...props} />
                  </SelectedIdContext.Provider>
                </ModeContext.Provider>
              </WallActionsContext.Provider>
            </PaneWriteContext.Provider>
          </WorkspaceActiveContext.Provider>
        </StrictMode>,
      );
    });
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    // jsdom has no layout — give the canvas a frame grid + box so toDevice maps.
    canvas.width = 1280;
    canvas.height = 720;
    canvas.getBoundingClientRect = () => ({ width: 1280, height: 720, left: 0, top: 0, right: 1280, bottom: 720, x: 0, y: 0, toJSON() {} }) as DOMRect;
    return canvas;
  }

  const sentMouseEvents = () => WebSocketMock.instances
    .flatMap((ws) => ws.sent)
    .filter((m) => m.includes('"type":"input_mouse"'));

  it('forwards a click to the page when in passthrough mode even if the pane is not selected', async () => {
    const canvas = await renderWithMode('passthrough', 'some-other-pane');
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 50, button: 0 }));
      canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 50, button: 0 }));
    });
    const events = sentMouseEvents();
    expect(events.some((m) => m.includes('"eventType":"mousePressed"'))).toBe(true);
    expect(events.some((m) => m.includes('"eventType":"mouseReleased"'))).toBe(true);
  });

  it('does not forward canvas clicks in command mode', async () => {
    const canvas = await renderWithMode('command', null);
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 50, button: 0 }));
      canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 50, button: 0 }));
    });
    expect(sentMouseEvents()).toHaveLength(0);
  });

  const sentKeyEvents = () => WebSocketMock.instances
    .flatMap((ws) => ws.sent)
    .filter((m) => m.includes('"type":"input_keyboard"'));

  // The window key forwarder is a capture-phase listener that preventDefaults
  // what it takes, so a Workspace left in passthrough on a browser pane would go
  // on eating every keystroke while hidden (docs/specs/layout.md → "Workspaces").
  it('stops forwarding window keys once its Workspace is hidden, and resumes on return', async () => {
    await renderWithMode('passthrough', 'ab-panel');
    const press = async () => {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
      });
    };

    await press();
    expect(sentKeyEvents().length).toBeGreaterThan(0);

    await renderWithMode('passthrough', 'ab-panel', false);
    const whileHidden = sentKeyEvents().length;
    const swallowed = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(swallowed); });
    expect(sentKeyEvents().length).toBe(whileHidden);
    expect(swallowed.defaultPrevented).toBe(false);

    await renderWithMode('passthrough', 'ab-panel', true);
    await press();
    expect(sentKeyEvents().length).toBeGreaterThan(whileHidden);
  });
});

describe('AgentBrowserPanel tab strip actions', () => {
  // The chip/× use plain onClick. In the real app a click on an unselected
  // browser pane used to be lost because selecting the pane moved its DOM
  // mid-press; under Lath the leaf div is never re-parented, so the node stays put
  // and the click survives. jsdom doesn't move the DOM, so a dispatched click here
  // just exercises the onClick → selectTab/closeTab wiring.
  async function renderWithTwoTabs(): Promise<ReturnType<typeof installBrowserHost>> {
    const host = installBrowserHost();
    const props = paneProps('ab-panel', { surfaceType: 'agent-browser', session: 'browser-session', stream: 4321 });
    await renderPanel(props);
    const ws = WebSocketMock.instances[WebSocketMock.instances.length - 1];
    await act(async () => {
      ws.emitMessage(JSON.stringify({ type: 'tabs', tabs: [
        { tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true },
        { tabId: 't2', title: 'GitHub', url: 'https://github.com/diffplug/dormouse', active: false },
      ] }));
    });
    return host;
  }

  const chipFor = (url: string) => [...container.querySelectorAll('div[title]')]
    .find((e) => e.getAttribute('title') === url && (e.className || '').includes('cursor-pointer')) as HTMLElement;

  it('switches to an inactive tab on chip click', async () => {
    const host = await renderWithTwoTabs();
    const chip = chipFor('https://github.com/diffplug/dormouse');
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    expect(host.requests('tab')).toContainEqual({ provider: 'agent-browser', binding: { session: 'browser-session' }, op: 'tab', action: 'select', tabId: 't2' });
  });

  it('closes a tab on the × button click', async () => {
    const host = await renderWithTwoTabs();
    const closeBtn = chipFor('https://github.com/diffplug/dormouse')
      .querySelector('button[aria-label="Close tab"]') as HTMLButtonElement;
    await act(async () => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    expect(host.requests('tab')).toContainEqual({ provider: 'agent-browser', binding: { session: 'browser-session' }, op: 'tab', action: 'close', tabId: 't2' });
  });

});

describe('the render modes a tool is offered (regression: PR #493 review)', () => {
  // The second of the two screen-registration sites (the other is
  // `IframePanel`): a tool declaring `render: agent-browser-screencast` mounts this panel,
  // so the gate has to be here too. Why it exists is at the gate itself, in
  // `agent-browser-surface-controller.ts`. The host can do everything, so a
  // refusal is the tool rule and not a missing capability.
  function withCapableHost() {
    return installBrowserHost({ launch: async () => ({ ok: true, stream: 1 }) });
  }

  it('offers every mode on a plain browser surface', async () => {
    withCapableHost();
    await renderPanel(paneProps('ab-plain', { surfaceType: 'browser', session: 's', renderMode: 'agent-browser-screencast' }));
    expect(getAgentBrowserScreenController('ab-plain')?.renderModes)
      .toEqual(['agent-browser-screencast', 'agent-browser-popout', 'playwright-screencast', 'playwright-popout', 'iframe']);
  });

  it('offers a tool only its declarable renders, and refuses the rest', async () => {
    const host = withCapableHost();
    const onSwapRenderMode = vi.fn();
    await act(async () => {
      root.render(
        <PaneWriteContext.Provider value={paneWriteFor(() => {})}>
          <WallActionsContext.Provider value={stubActions({ onSwapRenderMode })}>
            <AgentBrowserPanel {...paneProps('ab-tool', { surfaceType: 'tool', session: 's', renderMode: 'agent-browser-screencast' })} />
          </WallActionsContext.Provider>
        </PaneWriteContext.Provider>,
      );
    });
    const controller = getAgentBrowserScreenController('ab-tool')!;
    expect(controller.renderModes).toEqual(['agent-browser-screencast', 'playwright-screencast', 'iframe']);

    // The popout relaunches in-controller, never reaching the Wall's guard.
    await act(async () => { controller.actions.setRenderMode?.('agent-browser-popout'); });
    expect(host.requests('launch')).toEqual([]);
    expect(onSwapRenderMode).not.toHaveBeenCalled();

    await act(async () => { controller.actions.setRenderMode?.('iframe'); });
    expect(onSwapRenderMode).toHaveBeenCalledExactlyOnceWith('ab-tool', 'iframe');
  });
});
