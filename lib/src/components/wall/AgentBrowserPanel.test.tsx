/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { AgentBrowserPopResult, AgentBrowserStreamStatusResult, PlatformAdapter } from '../../lib/platform/types';
import type { PaneProps } from './pane-props';
import { AgentBrowserPanel, HIDDEN_PARK_DELAY_MS } from './AgentBrowserPanel';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import { disposeAllAgentBrowserSurfaceControllers } from './agent-browser-surface-controller';
import { ModeContext, PaneWriteContext, SelectedIdContext, WallActionsContext, type PaneWriteActions, type WallActions } from './wall-context';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type TestPanelParams = {
  surfaceType: string;
  renderMode?: string;
  session: string;
  wsPort?: number;
  url?: string;
  poppedOut?: boolean;
};

const DEFAULT_PARAMS: TestPanelParams = { surfaceType: 'agent-browser', session: 'browser-session' };

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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
    resolveSurfaceRef: vi.fn((id: string) => id),
    onConnectPort: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

function paneProps(id: string, params: TestPanelParams = DEFAULT_PARAMS): PaneProps {
  return { id, title: 'Browser', params };
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

  emitMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('WebSocket', WebSocketMock);
  WebSocketMock.instances = [];
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
  container.remove();
  vi.restoreAllMocks();
  setPlatform(new FakePtyAdapter());
});

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

describe('AgentBrowserPanel render mode controller', () => {
  it('relaunches screencast sessions as popout and publishes the mode immediately', async () => {
    const updateParameters = vi.fn();
    const popOut = vi.fn<PlatformAdapter['agentBrowserPopOut']>(async (): Promise<AgentBrowserPopResult> => ({
      ok: true,
      wsPort: 3456,
    }));
    const streamStatus = vi.fn<PlatformAdapter['agentBrowserStreamStatus']>(async (): Promise<AgentBrowserStreamStatusResult> => ({
      ok: true,
      wsPort: 1234,
    }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserPopOut' | 'agentBrowserStreamStatus'>;
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    platform.agentBrowserPopOut = popOut;
    platform.agentBrowserStreamStatus = streamStatus;
    setPlatform(platform);

    await renderPanel(paneProps('ab-panel'), updateParameters);

    await act(async () => {
      getAgentBrowserScreenController('ab-panel')?.actions.setRenderMode?.('ab-popout');
    });

    expect(popOut).toHaveBeenCalledWith('browser-session', expect.objectContaining({ url: undefined }), undefined);
    expect(updateParameters).toHaveBeenCalledWith({ renderMode: 'ab-popout' });
    expect(getAgentBrowserScreenController('ab-panel')?.snapshot().renderMode).toBe('ab-popout');
    expect(container.textContent).toContain('This browser is running in a separate window.');
    expect(WebSocketMock.instances.some((ws) => ws.url === 'ws://127.0.0.1:3456')).toBe(true);
  });

  it('relaunches popped-out sessions back into screencast', async () => {
    const updateParameters = vi.fn();
    const popIn = vi.fn<PlatformAdapter['agentBrowserPopIn']>(async (): Promise<AgentBrowserPopResult> => ({
      ok: true,
      wsPort: 4567,
    }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserPopIn' | 'agentBrowserStreamStatus'>;
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    platform.agentBrowserPopIn = popIn;
    platform.agentBrowserStreamStatus = vi.fn(async () => ({ ok: true, wsPort: 1234 }));
    setPlatform(platform);

    await renderPanel(
      paneProps('ab-panel', { surfaceType: 'browser', renderMode: 'ab-popout', session: 'browser-session' }),
      updateParameters,
    );

    expect(getAgentBrowserScreenController('ab-panel')?.snapshot().renderMode).toBe('ab-popout');

    await act(async () => {
      getAgentBrowserScreenController('ab-panel')?.actions.setRenderMode?.('ab-screencast');
    });

    expect(popIn).toHaveBeenCalledWith('browser-session', expect.objectContaining({ url: undefined }), undefined);
    expect(updateParameters).toHaveBeenCalledWith({ renderMode: 'ab-screencast' });
    expect(getAgentBrowserScreenController('ab-panel')?.snapshot().renderMode).toBe('ab-screencast');
  });

  it('pop-in uses the latest observed headed-window tab URL over stale params', async () => {
    const updateParameters = vi.fn();
    const popIn = vi.fn<PlatformAdapter['agentBrowserPopIn']>(async (): Promise<AgentBrowserPopResult> => ({
      ok: true,
      wsPort: 4567,
    }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserPopIn' | 'agentBrowserStreamStatus'>;
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    platform.agentBrowserPopIn = popIn;
    platform.agentBrowserStreamStatus = vi.fn(async () => ({ ok: true, wsPort: 1234 }));
    setPlatform(platform);

    await renderPanel(
      paneProps('ab-panel', {
        surfaceType: 'browser',
        renderMode: 'ab-popout',
        session: 'browser-session',
        wsPort: 1111,
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
      getAgentBrowserScreenController('ab-panel')?.actions.setRenderMode?.('ab-screencast');
    });

    expect(popIn).toHaveBeenCalledWith('browser-session', expect.objectContaining({ url: 'https://example.com/' }), undefined);
  });

  it('mirrors popped-out stream tab URL updates when the stream reports id instead of tabId', async () => {
    const updateParameters = vi.fn();
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserStreamStatus'>;
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    platform.agentBrowserStreamStatus = vi.fn(async () => ({ ok: true, wsPort: 1234 }));
    setPlatform(platform);

    await renderPanel(
      paneProps('ab-panel', {
        surfaceType: 'browser',
        renderMode: 'ab-popout',
        session: 'browser-session',
        wsPort: 1111,
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

  it('mirrors popped-out manual navigation from CDP target events', async () => {
    const updateParameters = vi.fn();
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserStreamStatus'>;
    platform.agentBrowserCommand = vi.fn(async (_session, args) => {
      if (args.join(' ') === 'get cdp-url') return { exitCode: 0, stdout: 'ws://127.0.0.1:9222/devtools/browser/test', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    platform.agentBrowserStreamStatus = vi.fn(async () => ({ ok: true, wsPort: 1234 }));
    setPlatform(platform);

    await renderPanel(
      paneProps('ab-panel', {
        surfaceType: 'browser',
        renderMode: 'ab-popout',
        session: 'browser-session',
        wsPort: 1111,
        url: 'https://google.com/',
      }),
      updateParameters,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const cdpWs = WebSocketMock.instances.find((ws) => ws.url.includes('/devtools/browser/'));
    expect(cdpWs).toBeTruthy();

    await act(async () => {
      cdpWs?.emitMessage(JSON.stringify({
        method: 'Target.targetInfoChanged',
        params: { targetInfo: { type: 'page', url: 'https://example.com/', title: 'Example Domain' } },
      }));
    });

    expect(platform.agentBrowserCommand).toHaveBeenCalledWith('browser-session', ['get', 'cdp-url'], undefined);
    expect(updateParameters).toHaveBeenCalledWith({ url: 'https://example.com/' });
  });

  it('actively selects a newly opened tab when the stream does not mark it active', async () => {
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand'>;
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    setPlatform(platform);

    await renderPanel(paneProps('ab-panel', { surfaceType: 'browser', session: 'browser-session', wsPort: 1111 }));

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

    expect(platform.agentBrowserCommand).toHaveBeenCalledWith('browser-session', ['tab', 't2'], undefined);
  });

  it('does not force-select a provisional new tab that already reports active', async () => {
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand'>;
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    setPlatform(platform);

    await renderPanel(paneProps('ab-panel', { surfaceType: 'browser', session: 'browser-session', wsPort: 1111 }));

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

    expect(platform.agentBrowserCommand).not.toHaveBeenCalled();
  });

  it('selects a provisional new tab after it reaches its destination if it is not active', async () => {
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand'>;
    platform.agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    setPlatform(platform);

    await renderPanel(paneProps('ab-panel', { surfaceType: 'browser', session: 'browser-session', wsPort: 1111 }));

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

    expect(platform.agentBrowserCommand).toHaveBeenCalledWith('browser-session', ['tab', 't2'], undefined);
  });

  it('keeps the last known active tab when the stream emits a transient empty tab list', async () => {
    const updateParameters = vi.fn();
    await renderPanel(
      paneProps('ab-panel', { surfaceType: 'browser', session: 'browser-session', wsPort: 1111 }),
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

  it('does not recover a stale port through stream status after that port opened live', async () => {
    const streamStatus = vi.fn<PlatformAdapter['agentBrowserStreamStatus']>(async (): Promise<AgentBrowserStreamStatusResult> => ({
      ok: true,
      wsPort: 2222,
    }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserStreamStatus'>;
    platform.agentBrowserStreamStatus = streamStatus;
    setPlatform(platform);

    await renderPanel(paneProps('ab-panel', { surfaceType: 'browser', session: 'browser-session', wsPort: 1111 }));

    await act(async () => {
      await Promise.resolve();
    });
    streamStatus.mockClear();

    await act(async () => {
      WebSocketMock.instances.at(-1)?.emitMessage(JSON.stringify({ type: 'status', connected: false, screencasting: false }));
      await Promise.resolve();
    });

    expect(streamStatus).not.toHaveBeenCalled();
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

describe('AgentBrowserPanel visibility parking', () => {
  // Under Lath a mounted leaf is always engine-visible, so on-screen visibility
  // reduces to document visibility (`useSurfaceVisibility`). A hidden/shown
  // transition is a `visibilitychange` event; the harness drives it by overriding
  // `document.visibilityState` and dispatching.
  function setDocumentHidden(hidden: boolean): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
  }

  async function renderVisibilityPanel(
    params: TestPanelParams,
  ): Promise<{ setVisible: (visible: boolean) => void }> {
    setDocumentHidden(false); // mount on-screen
    await act(async () => {
      root.render(
        <StrictMode>
          <PaneWriteContext.Provider value={paneWriteFor(() => {})}>
            <WallActionsContext.Provider value={stubActions()}>
              <AgentBrowserPanel {...paneProps('ab-panel', params)} />
            </WallActionsContext.Provider>
          </PaneWriteContext.Provider>
        </StrictMode>,
      );
    });
    return {
      setVisible: (visible) => {
        setDocumentHidden(!visible);
        document.dispatchEvent(new Event('visibilitychange'));
      },
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
      surfaceType: 'browser', session: 'browser-session', wsPort: 4321,
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

  it('never queries stream status while parked', async () => {
    const streamStatus = vi.fn<PlatformAdapter['agentBrowserStreamStatus']>(async () => ({ ok: false }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserStreamStatus'>;
    platform.agentBrowserStreamStatus = streamStatus;
    setPlatform(platform);

    // No wsPort ⇒ the stale-port recovery effect is the code path that would
    // query the daemon; the parked guard must suppress it.
    const { setVisible } = await renderVisibilityPanel({
      surfaceType: 'browser', session: 'browser-session',
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    streamStatus.mockClear();

    await act(async () => { setVisible(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HIDDEN_PARK_DELAY_MS + 50); });

    expect(streamStatus).not.toHaveBeenCalled();
  });

  it('reconnects and repaints from the stream when it becomes visible again', async () => {
    const screenshot = vi.fn(async () => ({ ok: false as const, error: 'test' }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserScreenshot'>;
    platform.agentBrowserScreenshot = screenshot;
    setPlatform(platform);

    const { setVisible } = await renderVisibilityPanel({
      surfaceType: 'browser', session: 'browser-session', wsPort: 4321,
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

    // A frame pulse over the reconnected stream drives a device screenshot.
    screenshot.mockClear();
    await act(async () => {
      reconnected?.emitMessage(JSON.stringify({ type: 'frame', data: 'x'.repeat(32) }));
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screenshot).toHaveBeenCalled();
  });

  it('does not park a popped-out panel while it is hidden', async () => {
    const { setVisible } = await renderVisibilityPanel({
      surfaceType: 'browser', renderMode: 'ab-popout', session: 'browser-session', wsPort: 1111,
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
      surfaceType: 'browser', session: 'browser-session', wsPort: 4321,
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
      surfaceType: 'browser', session: 'browser-session', wsPort: 4321,
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
  // The pane that `dor ab open` creates is not the selected pane (the terminal
  // is), so the FIRST click on the browser surface must still reach the page —
  // it is the click that selects the pane. Mouse-down/up therefore gate on
  // passthrough mode alone, not full `interactive` (mode && selected).
  async function renderWithMode(mode: 'passthrough' | 'command', selectedId: string | null): Promise<HTMLCanvasElement> {
    const props = paneProps('ab-panel', { surfaceType: 'agent-browser', session: 'browser-session', wsPort: 4321 });
    await act(async () => {
      root.render(
        <StrictMode>
          <PaneWriteContext.Provider value={paneWriteFor(() => {})}>
            <WallActionsContext.Provider value={stubActions()}>
              <ModeContext.Provider value={mode}>
                <SelectedIdContext.Provider value={selectedId}>
                  <AgentBrowserPanel {...props} />
                </SelectedIdContext.Provider>
              </ModeContext.Provider>
            </WallActionsContext.Provider>
          </PaneWriteContext.Provider>
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
});

describe('AgentBrowserPanel tab strip actions', () => {
  // The chip/× use plain onClick. In the real app a click on an unselected
  // browser pane used to be lost because selecting the pane moved its DOM
  // mid-press; under Lath the leaf div is never re-parented, so the node stays put
  // and the click survives. jsdom doesn't move the DOM, so a dispatched click here
  // just exercises the onClick → selectTab/closeTab wiring.
  async function renderWithTwoTabs(): Promise<ReturnType<typeof vi.fn>> {
    const command = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserCommand'>;
    platform.agentBrowserCommand = command;
    setPlatform(platform);
    const props = paneProps('ab-panel', { surfaceType: 'agent-browser', session: 'browser-session', wsPort: 4321 });
    await renderPanel(props);
    const ws = WebSocketMock.instances[WebSocketMock.instances.length - 1];
    await act(async () => {
      ws.emitMessage(JSON.stringify({ type: 'tabs', tabs: [
        { tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: true },
        { tabId: 't2', title: 'GitHub', url: 'https://github.com/diffplug/dormouse', active: false },
      ] }));
    });
    return command;
  }

  const chipFor = (url: string) => [...container.querySelectorAll('div[title]')]
    .find((e) => e.getAttribute('title') === url && (e.className || '').includes('cursor-pointer')) as HTMLElement;

  it('switches to an inactive tab on chip click', async () => {
    const command = await renderWithTwoTabs();
    const chip = chipFor('https://github.com/diffplug/dormouse');
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    expect(command).toHaveBeenCalledWith('browser-session', ['tab', 't2'], undefined);
  });

  it('closes a tab on the × button click', async () => {
    const command = await renderWithTwoTabs();
    const closeBtn = chipFor('https://github.com/diffplug/dormouse')
      .querySelector('button[aria-label="Close tab"]') as HTMLButtonElement;
    await act(async () => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    expect(command).toHaveBeenCalledWith('browser-session', ['tab', 'close', 't2'], undefined);
  });

  it('captures a fresh frame when the active tab changes, but not on other tab edits', async () => {
    // The daemon emits no screencast frame on a tab switch and the dedup'd stream
    // is otherwise silent, so the panel forces one device screenshot so the canvas
    // follows the newly-active tab.
    const screenshot = vi.fn(async () => ({ ok: false as const, error: 'test' }));
    const platform = new FakePtyAdapter() as FakePtyAdapter & Pick<PlatformAdapter, 'agentBrowserScreenshot'>;
    platform.agentBrowserScreenshot = screenshot;
    setPlatform(platform);
    const props = paneProps('ab-panel', { surfaceType: 'agent-browser', session: 'browser-session', wsPort: 4321 });
    await renderPanel(props);
    const ws = WebSocketMock.instances[WebSocketMock.instances.length - 1];
    const tabs = (a: 't1' | 't2', extra = false) => JSON.stringify({ type: 'tabs', tabs: [
      { tabId: 't1', title: 'Dormouse', url: 'https://dormouse.sh/', active: a === 't1' },
      { tabId: 't2', title: 'GitHub', url: 'https://github.com/diffplug/dormouse', active: a === 't2' },
      ...(extra ? [{ tabId: 't3', title: 'GitHub', url: 'https://github.com/diffplug/dormouse', active: false }] : []),
    ] });

    await act(async () => { ws.emitMessage(tabs('t1')); });
    // Let the loop go fully idle before measuring tab-driven captures. Besides the
    // priming capture, StrictMode remounts the panel, and the re-attach repaint
    // pulse (a live connection survives the detach) schedules a throttled
    // follow-up capture ~one shot-interval later — drain it before mockClear.
    await new Promise((r) => setTimeout(r, 250));
    screenshot.mockClear();

    // Adding a tab without changing which is active must NOT force a capture.
    await act(async () => { ws.emitMessage(tabs('t1', true)); });
    await new Promise((r) => setTimeout(r, 120));
    expect(screenshot).not.toHaveBeenCalled();

    // Switching the active tab does.
    await act(async () => { ws.emitMessage(tabs('t2', true)); });
    await new Promise((r) => setTimeout(r, 120));
    expect(screenshot).toHaveBeenCalled();
  });
});
