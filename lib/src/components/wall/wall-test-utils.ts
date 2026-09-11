import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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

export interface WallHarness {
  container: HTMLDivElement;
  root: Root;
  /** Drain queued microtasks and 0ms timers inside `act`. */
  flush: () => Promise<void>;
  dispose: () => void;
}

/**
 * The jsdom setup any Wall composition needs: the browser APIs jsdom lacks, plus
 * a mounted root. Call from `beforeEach` and `dispose()` from `afterEach`; a
 * test file adds only its own platform and store resets.
 */
export function mountWallHarness(): WallHarness {
  ensureResizeObserver();
  // Reduced motion so the Lath engine runs a 0 duration: the two-phase kill's
  // deferred removal fires on a setTimeout(0) and completes within `flush()` — the
  // instant path is also stage 3's "reduced motion" acceptance requirement.
  globalThis.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  })) as unknown as typeof matchMedia;
  // Baseboard / dynamic-palette read a 2d context; jsdom has none.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null),
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    root,
    flush: async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); },
    dispose: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
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
