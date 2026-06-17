/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { SurfacePaneHeader } from './SurfacePaneHeader';
import {
  registerAgentBrowserScreen,
  type ChromeSnapshot,
  type ScreenSnapshot,
} from './agent-browser-screen';
import { setDevServerResolution } from './agent-browser-ports';
import { WallActionsContext, type WallActions } from './wall-context';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SCREEN: ScreenSnapshot = {
  state: 'SYNCED',
  viewport: { w: 1280, h: 720, dpr: 1 },
  paneCss: { w: 1280, h: 720 },
  displayDpr: 1,
  syncEngaged: true,
};

const CHROME: ChromeSnapshot = {
  url: 'http://localhost:5173/app',
  displayUrl: 'localhost:5173/app',
  title: 'Vite + React',
  key: 'storybook',
};

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

function register(id: string, chrome: ChromeSnapshot = CHROME) {
  return registerAgentBrowserScreen(id, {
    snapshot: SCREEN,
    actions: { engageSync: vi.fn(), applyDevice: vi.fn(), applyViewport: vi.fn(), openModal: vi.fn() },
    chrome,
    chromeActions: { navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn() },
    hostCapable: true,
  });
}

function headerApi(id: string, title: string): IDockviewPanelHeaderProps {
  return { api: { id, title } } as unknown as IDockviewPanelHeaderProps;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderHeader(props: IDockviewPanelHeaderProps, actions: WallActions) {
  act(() => {
    root.render(
      <WallActionsContext.Provider value={actions}>
        <SurfacePaneHeader {...props} />
      </WallActionsContext.Provider>,
    );
  });
}

describe('SurfacePaneHeader — browser chrome', () => {
  it('shows the URL as primary text with the HTML title as a tooltip', () => {
    const registration = register('pane-url');
    renderHeader(headerApi('pane-url', 'Vite + React'), stubActions());

    const url = container.querySelector('span[title="Vite + React"]');
    expect(url?.textContent).toBe('localhost:5173/app');

    registration.dispose();
  });

  it('shows a key indicator for a non-default --key but not the default key', () => {
    const reg = register('pane-key', { ...CHROME, key: 'storybook' });
    renderHeader(headerApi('pane-key', 'x'), stubActions());
    // Rendered inline as the key name, with `--key <name>` in the hover tooltip.
    expect(container.querySelector('[title="--key storybook"]')?.textContent).toBe('storybook');
    reg.dispose();

    act(() => root.unmount());
    root = createRoot(container);

    const reg2 = register('pane-key2', { ...CHROME, key: 'default' });
    renderHeader(headerApi('pane-key2', 'x'), stubActions());
    expect(container.querySelector('[title="--key default"]')).toBeNull();
    reg2.dispose();
  });

  it('renders the dev-server chip and focuses the serving pane on click', () => {
    const reg = register('pane-dev');
    setDevServerResolution(5173, { paneId: 'term-9', label: 'pnpm dev' });
    const onFocusPane = vi.fn();
    renderHeader(headerApi('pane-dev', 'x'), stubActions({ onFocusPane }));

    const chip = container.querySelector('button[aria-label="Focus pnpm dev — serves this localhost port"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('pnpm dev');
    expect(chip?.textContent).toContain(':5173');

    // With the chip fronting it, the URL drops the (redundant) domain and shows
    // only the path.
    expect(container.querySelector('span[title="Vite + React"]')?.textContent).toBe('/app');

    act(() => {
      chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onFocusPane).toHaveBeenCalledWith('term-9');

    reg.dispose();
  });

  it('exposes back/forward/reload nav controls', () => {
    const reg = register('pane-nav');
    renderHeader(headerApi('pane-nav', 'x'), stubActions());
    expect(container.querySelector('[aria-label="Back"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Forward"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Reload"]')).not.toBeNull();
    reg.dispose();
  });

  it('opens an inline editor on URL click and navigates (normalized) on Enter', () => {
    const navigate = vi.fn();
    const registration = registerAgentBrowserScreen('pane-url-edit', {
      snapshot: SCREEN,
      actions: { engageSync: vi.fn(), applyDevice: vi.fn(), applyViewport: vi.fn(), openModal: vi.fn() },
      chrome: CHROME,
      chromeActions: { navigate, back: vi.fn(), forward: vi.fn(), reload: vi.fn() },
      hostCapable: true,
    });
    renderHeader(headerApi('pane-url-edit', 'x'), stubActions());

    const urlSpan = container.querySelector('span[title="Vite + React"]') as HTMLElement;
    expect(urlSpan).not.toBeNull();
    act(() => { urlSpan.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // The editor is pre-filled with the full URL (not the host+path display).
    const input = container.querySelector<HTMLInputElement>('[data-url-input-for="pane-url-edit"]');
    expect(input).not.toBeNull();
    expect(input!.value).toBe('http://localhost:5173/app');

    act(() => {
      input!.value = 'localhost:3000/x';
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(navigate).toHaveBeenCalledWith('http://localhost:3000/x');
    // Editor closes after navigating.
    expect(container.querySelector('[data-url-input-for="pane-url-edit"]')).toBeNull();

    registration.dispose();
  });

  it('cancels URL editing on Escape without navigating', () => {
    const navigate = vi.fn();
    const registration = registerAgentBrowserScreen('pane-url-esc', {
      snapshot: SCREEN,
      actions: { engageSync: vi.fn(), applyDevice: vi.fn(), applyViewport: vi.fn(), openModal: vi.fn() },
      chrome: CHROME,
      chromeActions: { navigate, back: vi.fn(), forward: vi.fn(), reload: vi.fn() },
      hostCapable: true,
    });
    renderHeader(headerApi('pane-url-esc', 'x'), stubActions());

    act(() => {
      (container.querySelector('span[title="Vite + React"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = container.querySelector<HTMLInputElement>('[data-url-input-for="pane-url-esc"]');
    expect(input).not.toBeNull();

    act(() => {
      input!.value = 'example.com';
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-url-input-for="pane-url-esc"]')).toBeNull();

    registration.dispose();
  });

  it('falls back to a plain title (no nav) for non-browser surfaces', () => {
    renderHeader(headerApi('pane-iframe', 'example.com'), stubActions());
    expect(container.textContent).toContain('example.com');
    expect(container.querySelector('[aria-label="Back"]')).toBeNull();
    expect(container.querySelector('[aria-label="Reload"]')).toBeNull();
  });
});
