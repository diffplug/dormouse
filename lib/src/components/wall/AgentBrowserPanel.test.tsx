/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { AgentBrowserPopResult, AgentBrowserStreamStatusResult, PlatformAdapter } from '../../lib/platform/types';
import { AgentBrowserPanel } from './AgentBrowserPanel';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import { WallActionsContext, type WallActions } from './wall-context';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type TestPanelParams = {
  surfaceType: string;
  renderMode?: string;
  session: string;
  wsPort?: number;
  url?: string;
  poppedOut?: boolean;
};

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
    ...overrides,
  };
}

function panelProps(
  id: string,
  updateParameters = vi.fn(),
): IDockviewPanelProps<TestPanelParams> {
  return {
    api: { id, title: 'Browser', updateParameters, setTitle: vi.fn() },
    params: { surfaceType: 'agent-browser', session: 'browser-session' },
  } as unknown as IDockviewPanelProps<TestPanelParams>;
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
  container.remove();
  vi.restoreAllMocks();
  setPlatform(new FakePtyAdapter());
});

async function renderPanel(props = panelProps('ab-panel')): Promise<void> {
  await act(async () => {
    root.render(
      <StrictMode>
        <WallActionsContext.Provider value={stubActions()}>
          <AgentBrowserPanel {...props} />
        </WallActionsContext.Provider>
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

    await renderPanel(panelProps('ab-panel', updateParameters));

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

    await renderPanel({
      ...panelProps('ab-panel', updateParameters),
      params: { surfaceType: 'browser', renderMode: 'ab-popout', session: 'browser-session' },
    } as unknown as IDockviewPanelProps<{ surfaceType: string; renderMode: string; session: string }>);

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

    await renderPanel({
      ...panelProps('ab-panel', updateParameters),
      params: {
        surfaceType: 'browser',
        renderMode: 'ab-popout',
        session: 'browser-session',
        wsPort: 1111,
        url: 'https://google.com/',
      },
    });

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

    await renderPanel({
      ...panelProps('ab-panel', updateParameters),
      params: {
        surfaceType: 'browser',
        renderMode: 'ab-popout',
        session: 'browser-session',
        wsPort: 1111,
        url: 'https://google.com/',
      },
    });

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

    await renderPanel({
      ...panelProps('ab-panel', updateParameters),
      params: {
        surfaceType: 'browser',
        renderMode: 'ab-popout',
        session: 'browser-session',
        wsPort: 1111,
        url: 'https://google.com/',
      },
    });

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

    await renderPanel({
      ...panelProps('ab-panel'),
      params: { surfaceType: 'browser', session: 'browser-session', wsPort: 1111 },
    });

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

    await renderPanel({
      ...panelProps('ab-panel'),
      params: { surfaceType: 'browser', session: 'browser-session', wsPort: 1111 },
    });

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

    await renderPanel({
      ...panelProps('ab-panel'),
      params: { surfaceType: 'browser', session: 'browser-session', wsPort: 1111 },
    });

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
    await renderPanel({
      ...panelProps('ab-panel', updateParameters),
      params: { surfaceType: 'browser', session: 'browser-session', wsPort: 1111 },
    });

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

    await renderPanel({
      ...panelProps('ab-panel'),
      params: { surfaceType: 'browser', session: 'browser-session', wsPort: 1111 },
    });

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
            <AgentBrowserPanel {...panelProps('ab-panel')} />
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
