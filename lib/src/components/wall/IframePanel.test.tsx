/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import { IframePanel } from './IframePanel';
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
    ...overrides,
  };
}

function panelProps(id: string): IDockviewPanelProps<{ url: string }> {
  return {
    api: { id, title: 'Raw iframe' },
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

async function renderPanel(actions: WallActions): Promise<HTMLIFrameElement> {
  await act(async () => {
    root.render(
      <WallActionsContext.Provider value={actions}>
        <IframePanel {...panelProps('iframe-raw')} />
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
});
