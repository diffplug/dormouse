import { vi } from 'vitest';
import type { WallActions } from './wall-context';
import {
  registerAgentBrowserScreen,
  type ChromeSnapshot,
  type ScreenRegistration,
  type ScreenSnapshot,
} from './agent-browser-screen';

/** The full `WallActions` surface as inert vi.fn stubs, so a new member is one
 *  edit here instead of one per component test. */
export function stubWallActions(overrides: Partial<WallActions> = {}): WallActions {
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
    onConnectPort: vi.fn(),
    ...overrides,
  };
}

/** jsdom lacks ResizeObserver; the pane headers' responsive-tier observer needs it. */
export function ensureResizeObserver(): void {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

export const STUB_SCREEN: ScreenSnapshot = {
  state: 'SYNCED',
  renderMode: 'ab-screencast',
  viewport: { w: 1280, h: 720, dpr: 1 },
  paneCss: { w: 1280, h: 720 },
  displayDpr: 1,
  syncEngaged: true,
};

export const STUB_CHROME: ChromeSnapshot = {
  url: 'http://localhost:5173/app',
  displayUrl: 'localhost:5173/app',
  title: 'Vite + React',
  key: 'storybook',
};

/** Register an inert screen controller so a component test can read one back
 *  through `getAgentBrowserScreenController` — same route the panels take, so a
 *  new `ScreenController` member is one edit here rather than one per test. */
export function registerStubScreen(
  id: string,
  init: {
    snapshot?: ScreenSnapshot;
    chrome?: ChromeSnapshot;
    hostCapable?: boolean;
    canPopOut?: boolean;
  } = {},
): ScreenRegistration {
  return registerAgentBrowserScreen(id, {
    snapshot: init.snapshot ?? STUB_SCREEN,
    actions: {
      engageSync: vi.fn(),
      applyDevice: vi.fn(),
      applyViewport: vi.fn(),
      openModal: vi.fn(),
      setRenderMode: vi.fn(),
    },
    chrome: init.chrome ?? STUB_CHROME,
    chromeActions: { navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn() },
    hostCapable: init.hostCapable ?? true,
    canPopOut: init.canPopOut ?? true,
  });
}
