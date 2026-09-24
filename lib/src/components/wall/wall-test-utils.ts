import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { BROWSER_PROVIDER_IDS, type BrowserAutomationProvider } from 'dor-lib-common/browser-providers';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { BrowserOp, BrowserRequest, BrowserResult } from '../../lib/platform/browser-automation';
import type { WallActions } from './wall-context';
import {
  registerAgentBrowserScreen,
  type ChromeSnapshot,
  type RenderMode,
  type ScreenRegistration,
  type ScreenSnapshot,
} from './agent-browser-screen';

/** The full `WallActions` surface as inert vi.fn stubs, so a new member is one
 *  edit here instead of one per component test. */
export function stubWallActions(overrides: Partial<WallActions> = {}): WallActions {
  return {
    onKill: vi.fn(),
    onMinimize: vi.fn(),
    onToggleTodo: vi.fn(),
    onSplitH: vi.fn(),
    onSplitV: vi.fn(),
    onZoom: vi.fn(),
    onClickPanel: vi.fn(),
    onEnterPanel: vi.fn(),
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

/** A dispatchable `PointerEvent`: jsdom has none, so its fields are defined on
 *  a plain event — a primary touch with one button down unless overridden. */
export function pointerEvent(type: string, overrides: Partial<PointerEvent> = {}): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  const values: Partial<PointerEvent> = {
    pointerId: 7,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    clientX: 10,
    clientY: 12,
    screenX: 110,
    screenY: 112,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, get: () => value });
  }
  return event;
}

/** jsdom lacks the native modal `<dialog>` API that `NativeModalDialog` calls. */
export function ensureDialogModal(): void {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
}

/**
 * A ResizeObserver whose width the test drives: every observed element is told
 * `initialWidth` on observe, and the returned setter re-delivers a new width to
 * all of them. Stubbed through `vi.stubGlobal`, so `vi.unstubAllGlobals()` in
 * `afterEach` restores jsdom.
 */
export function stubResizeObserver(initialWidth: number): (width: number) => void {
  let width = initialWidth;
  const deliveries = new Set<() => void>();
  vi.stubGlobal('ResizeObserver', class {
    private readonly delivery = new Set<() => void>();
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      const deliver = () => this.callback([{
        target,
        borderBoxSize: [{ inlineSize: width, blockSize: 0 }],
        contentRect: { width },
      } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      this.delivery.add(deliver);
      deliveries.add(deliver);
      deliver();
    }
    unobserve(): void {}
    disconnect(): void {
      for (const deliver of this.delivery) deliveries.delete(deliver);
    }
  });
  return (next) => {
    width = next;
    for (const deliver of deliveries) deliver();
  };
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
    renderModes?: readonly RenderMode[];
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
    renderModes: init.renderModes ?? ['ab-screencast', 'ab-popout', 'pw-screencast', 'pw-popout', 'iframe'],
  });
}

/** How a fake browser host answers one kind of request. */
export type BrowserAnswers = {
  [K in BrowserOp['op']]?: (request: Extract<BrowserRequest, { op: K }>) => BrowserResult | Promise<BrowserResult>;
};

/**
 * Install a platform whose host drives `providers`, answering each typed
 * browser request from `answers` by operation — `{ ok: true }` where none is
 * given. `answers` stays live, so a test may swap one mid-flight; `requests`
 * reads back every request of one kind, in order.
 */
export function installBrowserHost(
  answers: BrowserAnswers = {},
  providers: readonly BrowserAutomationProvider[] = BROWSER_PROVIDER_IDS,
) {
  const browser = vi.fn(async (request: BrowserRequest): Promise<BrowserResult> => {
    const answer = answers[request.op] as ((r: BrowserRequest) => BrowserResult | Promise<BrowserResult>) | undefined;
    return (await answer?.(request)) ?? { ok: true };
  });
  const platform = Object.assign(new FakePtyAdapter(), { browserProviders: providers, browser });
  setPlatform(platform);
  const requests = <K extends BrowserOp['op']>(op: K): Extract<BrowserRequest, { op: K }>[] =>
    browser.mock.calls.map(([request]) => request).filter((request): request is Extract<BrowserRequest, { op: K }> => request.op === op);
  return { platform, browser, answers, requests };
}
