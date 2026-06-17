/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { AgentBrowserPopResult, AgentBrowserStreamStatusResult, PlatformAdapter } from '../../lib/platform/types';
import { AgentBrowserPanel } from './AgentBrowserPanel';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import { WallActionsContext, type WallActions } from './wall-context';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
): IDockviewPanelProps<{ surfaceType: string; session: string; wsPort?: number; poppedOut?: boolean }> {
  return {
    api: { id, title: 'Browser', updateParameters, setTitle: vi.fn() },
    params: { surfaceType: 'agent-browser', session: 'browser-session' },
  } as unknown as IDockviewPanelProps<{ surfaceType: string; session: string; wsPort?: number; poppedOut?: boolean }>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
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
      <WallActionsContext.Provider value={stubActions()}>
        <AgentBrowserPanel {...props} />
      </WallActionsContext.Provider>,
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
      getAgentBrowserScreenController('ab-panel')?.actions.setRenderMode?.('popout');
    });

    expect(popOut).toHaveBeenCalledWith('browser-session', expect.objectContaining({ url: undefined }), undefined);
    expect(updateParameters).toHaveBeenCalledWith({ poppedOut: true });
    expect(getAgentBrowserScreenController('ab-panel')?.snapshot().renderMode).toBe('popout');
    expect(container.textContent).toContain('This browser is running in a separate window.');
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
      params: { surfaceType: 'agent-browser', session: 'browser-session', poppedOut: true },
    } as unknown as IDockviewPanelProps<{ surfaceType: string; session: string; poppedOut: boolean }>);

    expect(getAgentBrowserScreenController('ab-panel')?.snapshot().renderMode).toBe('popout');

    await act(async () => {
      getAgentBrowserScreenController('ab-panel')?.actions.setRenderMode?.('screencast');
    });

    expect(popIn).toHaveBeenCalledWith('browser-session', expect.objectContaining({ url: undefined }), undefined);
    expect(updateParameters).toHaveBeenCalledWith({ poppedOut: false });
    expect(getAgentBrowserScreenController('ab-panel')?.snapshot().renderMode).toBe('screencast');
  });
});
