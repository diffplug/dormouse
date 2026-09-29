/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneProps } from './pane-props';
import { SurfacePaneHeader } from './SurfacePaneHeader';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { setPlatform } from '../../lib/platform';
import {
  registerAgentBrowserScreen,
  type ChromeSnapshot,
  type ScreenSnapshot,
} from './agent-browser-screen';
import { setDevServerResolution } from './agent-browser-ports';
import { removeTerminalPaneState, setTerminalUserTitle } from '../../lib/terminal-state-store';
import * as terminalState from '../../lib/terminal-state';
import {
  ModeContext,
  WorkspaceActiveContext,
  SelectedIdContext,
  WallActionsContext,
  WindowFocusedContext,
  ZoomedIdContext,
  type WallActions,
} from './wall-context';
import { registerStubScreen, STUB_CHROME, STUB_SCREEN, stubResizeObserver, stubWallActions as stubActions } from './wall-test-utils';
import { setNativeFieldValue } from '../../lib/dom';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SCREEN = STUB_SCREEN;
const CHROME = STUB_CHROME;

// Header widths landing in each collapsed browser tier (`browserHeaderTier`).
const OVERFLOW_PX = 94; // chrome behind the trigger, minimize/kill still inline
const TINY_PX = 93;     // zoom alone beside the trigger

function register(id: string, chrome: ChromeSnapshot = CHROME, snapshot: ScreenSnapshot = SCREEN) {
  return registerStubScreen(id, { chrome, snapshot });
}

function headerProps(id: string, title: string): PaneProps {
  return { id, title, params: undefined };
}

let container: HTMLDivElement;
let root: Root;
let resizeHeader: (width: number) => void;

beforeEach(() => {
  setPlatform(new FakePtyAdapter());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  resizeHeader = stubResizeObserver(620);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderHeader(
  props: PaneProps,
  actions: WallActions,
  state: { active?: boolean; zoomedId?: string | null; workspaceActive?: boolean } = {},
) {
  act(() => {
    root.render(
      <StrictMode>
        <WorkspaceActiveContext.Provider value={state.workspaceActive ?? true}>
          <ModeContext.Provider value={state.active ? 'passthrough' : 'command'}>
            <SelectedIdContext.Provider value={state.active ? props.id : null}>
              <WindowFocusedContext.Provider value={true}>
                <ZoomedIdContext.Provider value={state.zoomedId ?? null}>
                  <WallActionsContext.Provider value={actions}>
                    <SurfacePaneHeader {...props} />
                  </WallActionsContext.Provider>
                </ZoomedIdContext.Provider>
              </WindowFocusedContext.Provider>
            </SelectedIdContext.Provider>
          </ModeContext.Provider>
        </WorkspaceActiveContext.Provider>
      </StrictMode>,
    );
  });
}

/** The compact header's popover, portaled to `document.body`. */
const popup = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Browser controls"]');
/** The compact header's trigger. */
const overflowTrigger = () => container.querySelector<HTMLButtonElement>('[aria-label^="Browser controls"]')!;
const inPopup = (selector: string) => popup()?.querySelector<HTMLElement>(selector) ?? null;
/** Click, then let the popover's deferred dismissal (a 0ms task) run. */
async function clickAndSettle(element: HTMLElement) {
  await act(async () => { element.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
}
function openPopup() {
  act(() => overflowTrigger().click());
  expect(popup()).not.toBeNull();
}

describe('SurfacePaneHeader — browser chrome', () => {
  it.each(['workspace', 'parked'] as const)('dismisses compact controls without stealing focus when hidden by %s', hiddenBy => {
    const id = 'pane-hidden-controls';
    const registration = register(id);
    const props = headerProps(id, 'Browser');
    const actions = stubActions();
    const otherWorkspaceControl = document.createElement('button');
    document.body.appendChild(otherWorkspaceControl);
    try {
      renderHeader(props, actions);
      act(() => resizeHeader(OVERFLOW_PX));
      openPopup();
      otherWorkspaceControl.focus();
      renderHeader({ ...props, parked: hiddenBy === 'parked' }, actions, { workspaceActive: hiddenBy !== 'workspace' });
      expect(popup()).toBeNull();
      expect(document.activeElement).toBe(otherWorkspaceControl);
      renderHeader(props, actions);
      expect(popup()).toBeNull();
      expect(overflowTrigger().getAttribute('aria-expanded')).toBe('false');
    } finally {
      otherWorkspaceControl.remove();
      registration.dispose();
    }
  });

  it('collapses chrome by its own width', () => {
    const registration = register('pane-resize', { ...CHROME, key: 'a'.repeat(300) });
    renderHeader({ ...headerProps('pane-resize', 'Browser'), params: { surfaceType: 'browser', url: CHROME.url } }, stubActions());
    const split = () => container.querySelector('[aria-label="Split left/right"]');
    const zoom = () => container.querySelector('[aria-label="Zoom"]');
    expect(container.querySelector('[aria-label="Back"]')).not.toBeNull();
    expect(split()).not.toBeNull();
    // Zoom outlives every other control, so every step below re-asserts it.
    act(() => resizeHeader(400));
    expect(container.querySelector('[aria-label="Back"]')).not.toBeNull();
    expect(split()).toBeNull();
    expect(zoom()).not.toBeNull();
    act(() => resizeHeader(340));
    expect(container.querySelector('[aria-label="Back"]')).toBeNull();
    expect(zoom()).not.toBeNull();
    act(() => resizeHeader(OVERFLOW_PX));
    expect(overflowTrigger()).not.toBeNull();
    expect(container.querySelector('[aria-label="Kill"]')).not.toBeNull();
    expect(zoom()).not.toBeNull();
    act(() => resizeHeader(TINY_PX));
    expect(container.querySelector('[aria-label="Kill"]')).toBeNull();
    expect(zoom()).not.toBeNull();
    act(() => resizeHeader(620));
    expect(container.querySelector('[aria-label^="Browser controls"]')).toBeNull();
    expect(container.querySelector('[aria-label="Back"]')).not.toBeNull();
    expect(split()).not.toBeNull();
    expect(zoom()).not.toBeNull();
    registration.dispose();
  });

  it('keeps the popover keyboard reachable and hands focus back to its trigger', async () => {
    const registration = register('pane-popup');
    const actions = stubActions();
    renderHeader(headerProps('pane-popup', 'Browser'), actions);
    act(() => resizeHeader(OVERFLOW_PX));
    openPopup();
    expect(popup()!.contains(document.activeElement)).toBe(true);
    const firstControl = document.activeElement!;
    act(() => firstControl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.activeElement).not.toBe(firstControl);
    expect(popup()!.contains(document.activeElement)).toBe(true);
    expect(inPopup('[aria-label="Back"]')).not.toBeNull();
    await clickAndSettle(inPopup('[aria-label="Split left/right"]')!);
    expect(actions.onSplitH).toHaveBeenCalledWith('pane-popup');
    expect(popup()).toBeNull();

    openPopup();
    const url = inPopup('[role="button"]')!;
    act(() => { url.focus(); url.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(inPopup('input')).not.toBeNull();
    act(() => inPopup('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(overflowTrigger());

    openPopup();
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(popup()).toBeNull();

    openPopup();
    // Separate acts: a browser flushes the pointerdown's state before the click.
    act(() => overflowTrigger().dispatchEvent(new Event('pointerdown', { bubbles: true })));
    act(() => overflowTrigger().click());
    expect(popup()).toBeNull();
    expect(overflowTrigger().getAttribute('aria-expanded')).toBe('false');
    registration.dispose();
  });

  it('reclamps changing popup content near the viewport edge without moving editor focus', () => {
    const registration = register('pane-popup-geometry');
    vi.stubGlobal('innerWidth', 300);
    vi.stubGlobal('innerHeight', 300);
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'dialog') {
        return new DOMRect(0, 0, 276, this.querySelector('input') ? 40 : 80);
      }
      if (this.getAttribute('aria-label')?.startsWith('Browser controls')) return new DOMRect(280, 240, 20, 20);
      return originalRect.call(this);
    });
    renderHeader(headerProps('pane-popup-geometry', 'Browser'), stubActions());
    act(() => resizeHeader(OVERFLOW_PX));
    let resizePopup: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        resizePopup = () => this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect = disconnect;
    });
    try {
      openPopup();
      expect(popup()!.style.top).toBe('208px');
      expect(popup()!.style.left).toBe('12px');
      expect(popup()!.style.maxWidth).toBe('calc(100vw - 24px)');
      act(() => inPopup('[role="button"]')!.click());
      const input = inPopup('input')!;
      expect(document.activeElement).toBe(input);
      act(() => resizePopup());
      expect(popup()!.style.top).toBe('248px');
      expect(document.activeElement).toBe(input);
      act(() => inPopup('[aria-label="Back"]')!.focus());
      expect(inPopup('input')).toBeNull();
      act(() => resizePopup());
      expect(popup()!.style.top).toBe('208px');
      expect(Number.parseFloat(popup()!.style.top) + 80).toBe(288);
      const disconnectsBeforeClose = disconnect.mock.calls.length;
      act(() => overflowTrigger().click());
      expect(popup()).toBeNull();
      expect(disconnect.mock.calls.length).toBeGreaterThan(disconnectsBeforeClose);
    } finally {
      registration.dispose();
    }
  });

  it('hands focus to the trigger when a resize moves a focused Kill into the popover', () => {
    const registration = register('pane-kill-focus');
    renderHeader(headerProps('pane-kill-focus', 'Browser'), stubActions());
    act(() => resizeHeader(OVERFLOW_PX));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Kill"]')!.focus());
    act(() => resizeHeader(TINY_PX));
    expect(container.querySelector('[aria-label="Kill"]')).toBeNull();
    expect(document.activeElement).toBe(overflowTrigger());
    registration.dispose();
  });

  it('closes the popover from Minimize and Kill wherever they render', async () => {
    const registration = register('pane-actions');
    const actions = stubActions();
    renderHeader(headerProps('pane-actions', 'Browser'), actions);
    act(() => resizeHeader(OVERFLOW_PX));
    for (const label of ['Minimize', 'Kill']) {
      openPopup();
      act(() => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
      expect(popup()).toBeNull();
    }
    act(() => resizeHeader(TINY_PX));
    for (const label of ['Minimize', 'Kill']) {
      openPopup();
      await clickAndSettle(inPopup(`[aria-label="${label}"]`)!);
      expect(popup()).toBeNull();
    }
    expect(actions.onMinimize).toHaveBeenCalledTimes(2);
    expect(actions.onKill).toHaveBeenCalledTimes(2);
    expect(actions.onKill).toHaveBeenCalledWith('pane-actions');
    registration.dispose();
  });

  it('runs popup Split, Reload and Display before dismissal and preserves modal focus', async () => {
    const modalControl = document.createElement('button');
    document.body.appendChild(modalControl);
    const stillOwnsFocus = () => expect(popup()?.contains(document.activeElement)).toBe(true);
    const onSplitH = vi.fn(stillOwnsFocus);
    const reload = vi.fn(stillOwnsFocus);
    const openModal = vi.fn(() => { stillOwnsFocus(); modalControl.focus(); });
    const registration = registerAgentBrowserScreen('pane-popup-actions', {
      snapshot: SCREEN, chrome: CHROME, hostCapable: true,
      actions: { engageSync: vi.fn(), applyViewport: vi.fn(), openModal },
      chromeActions: { navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), reload },
    });
    try {
      renderHeader(headerProps('pane-popup-actions', 'Browser'), stubActions({ onSplitH }));
      act(() => resizeHeader(OVERFLOW_PX));
      for (const selector of ['[aria-label="Split left/right"]', '[aria-label="Reload"]', '[data-browser-display-trigger]']) {
        openPopup();
        const action = inPopup(selector)!;
        action.focus();
        await clickAndSettle(action);
        expect(popup()).toBeNull();
      }
      expect(onSplitH).toHaveBeenCalledWith('pane-popup-actions');
      expect(reload).toHaveBeenCalledOnce();
      expect(openModal).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(modalControl);
    } finally {
      registration.dispose();
      modalControl.remove();
    }
  });

  it('uses the shared capability-first icon pair for every browser display mode', () => {
    const cases = [
      [{ ...SCREEN, renderMode: 'agent-browser-screencast', syncEngaged: true }, 'agent-browser-resize', 2],
      [{ ...SCREEN, renderMode: 'agent-browser-screencast', syncEngaged: false }, 'agent-browser-fixed', 2],
      [{ ...SCREEN, renderMode: 'agent-browser-popout', syncEngaged: false }, 'agent-browser-popout', 2],
      [{ ...SCREEN, renderMode: 'iframe', syncEngaged: false }, 'iframe', 1],
    ] as const;

    for (const [snapshot, displayMode, iconCount] of cases) {
      const id = `pane-${displayMode}`;
      const registration = register(id, CHROME, snapshot);
      renderHeader(headerProps(id, 'Browser'), stubActions());
      const trigger = container.querySelector<HTMLButtonElement>('[data-browser-display-trigger]');
      const display = trigger?.querySelector(`[data-browser-display-mode="${displayMode}"]`);
      expect(display).not.toBeNull();
      expect(display?.querySelectorAll('svg'), displayMode).toHaveLength(iconCount);
      const capability = display?.querySelector('[data-agent-capability-icon="robot-wide"]');
      if (displayMode === 'iframe') expect(capability, displayMode).toBeNull();
      else expect(capability, displayMode).not.toBeNull();
      registration.dispose();
    }
  });

  it('inverts only its own Unzoom control against the active header palette', () => {
    const props = headerProps('pane-zoom', 'Zoomed');
    renderHeader(props, stubActions(), { active: true, zoomedId: 'pane-zoom' });

    const unzoom = container.querySelector<HTMLButtonElement>('button[aria-label="Unzoom"]');
    expect(unzoom).not.toBeNull();
    expect(unzoom?.className).toContain('bg-header-active-fg');
    expect(unzoom?.className).toContain('text-header-active-bg');

    renderHeader(props, stubActions(), { active: true, zoomedId: 'another-pane' });
    expect(container.querySelector('button[aria-label="Unzoom"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Zoom"]')?.className).toContain('hover:bg-current/10');
  });

  it('shows the URL as primary text with the HTML title as a tooltip', () => {
    const registration = register('pane-url');
    renderHeader(headerProps('pane-url', 'Vite + React'), stubActions());

    const url = container.querySelector('span[title="Vite + React"]');
    expect(url?.textContent).toBe('localhost:5173/app');

    registration.dispose();
  });

  it('shows a key indicator for a non-default --key but not the default key', () => {
    const reg = register('pane-key', { ...CHROME, key: 'storybook' });
    renderHeader(headerProps('pane-key', 'x'), stubActions());
    // Rendered inline as the key name, with `--key <name>` in the hover tooltip.
    expect(container.querySelector('[title="--key storybook"]')?.textContent).toBe('storybook');
    reg.dispose();

    act(() => root.unmount());
    root = createRoot(container);

    const reg2 = register('pane-key2', { ...CHROME, key: 'default' });
    renderHeader(headerProps('pane-key2', 'x'), stubActions());
    expect(container.querySelector('[title="--key default"]')).toBeNull();
    reg2.dispose();
  });

  it('renders the dev-server chip and focuses the serving pane on click', () => {
    const reg = register('pane-dev');
    setDevServerResolution(5173, { paneId: 'term-9', fallbackTitle: 'pnpm dev' });
    const onFocusPane = vi.fn();
    renderHeader(headerProps('pane-dev', 'x'), stubActions({ onFocusPane }));

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

  it('labels the chip from the serving pane\'s live state, so a retitle shows at once', () => {
    const reg = register('pane-live');
    setDevServerResolution(5173, { paneId: 'term-live', fallbackTitle: 'stored' });
    try {
      renderHeader(headerProps('pane-live', 'x'), stubActions());
      const chipLabel = () => container.querySelector('button[aria-label$="serves this localhost port"]')?.getAttribute('aria-label');
      expect(chipLabel()).toBe('Focus stored — serves this localhost port');
      act(() => { setTerminalUserTitle('term-live', 'first.md'); });
      expect(chipLabel()).toBe('Focus first.md — serves this localhost port');
      // Another pane's state change leaves the label underived.
      const derive = vi.spyOn(terminalState, 'deriveSurfaceLabel');
      act(() => { setTerminalUserTitle('term-other', 'elsewhere'); });
      expect(derive).not.toHaveBeenCalled();
      act(() => { setTerminalUserTitle('term-live', 'second.md'); });
      expect(chipLabel()).toBe('Focus second.md — serves this localhost port');
    } finally {
      reg.dispose();
      setDevServerResolution(5173, null);
      removeTerminalPaneState('term-live');
      removeTerminalPaneState('term-other');
    }
  });

  it('lets the URL give up all its width before the chip truncates', () => {
    // jsdom has no layout: the URL grows from a zero basis up to its text, and
    // the space it leaves goes to an auto margin rather than a flexible spacer.
    const reg = register('pane-width');
    setDevServerResolution(5173, { paneId: 'term-9', fallbackTitle: 'pnpm dev' });
    try {
      renderHeader(headerProps('pane-width', 'x'), stubActions());
      const url = container.querySelector<HTMLElement>('span[title="Vite + React"]')!;
      expect([...url.classList]).toEqual(expect.arrayContaining(['basis-0', 'grow', 'max-w-max', 'min-w-0']));
      expect(url.nextElementSibling?.className).toBe('ml-auto');
    } finally {
      reg.dispose();
      setDevServerResolution(5173, null);
    }
  });

  it('exposes back/forward/reload nav controls', () => {
    const reg = register('pane-nav');
    renderHeader(headerProps('pane-nav', 'x'), stubActions());
    expect(container.querySelector('[aria-label="Back"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Forward"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Reload"]')).not.toBeNull();
    reg.dispose();
  });

  it('opens an inline editor on URL click and navigates (normalized) on Enter', () => {
    const navigate = vi.fn();
    const registration = registerAgentBrowserScreen('pane-url-edit', {
      snapshot: SCREEN,
      actions: { engageSync: vi.fn(), applyViewport: vi.fn(), openModal: vi.fn() },
      chrome: CHROME,
      chromeActions: { navigate, back: vi.fn(), forward: vi.fn(), reload: vi.fn() },
      hostCapable: true,
    });
    renderHeader(headerProps('pane-url-edit', 'x'), stubActions());

    const urlSpan = container.querySelector('span[title="Vite + React"]') as HTMLElement;
    expect(urlSpan).not.toBeNull();
    act(() => { urlSpan.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // The editor is pre-filled with the full URL (not the host+path display).
    const input = container.querySelector<HTMLInputElement>('[data-url-input-for="pane-url-edit"]');
    expect(input).not.toBeNull();
    expect(input!.value).toBe('http://localhost:5173/app');

    act(() => {
      setNativeFieldValue(input!, 'localhost:3000/x');
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(navigate).toHaveBeenCalledWith('http://localhost:3000/x');
    // Editor closes after navigating.
    expect(container.querySelector('[data-url-input-for="pane-url-edit"]')).toBeNull();

    registration.dispose();
  });

  it('refuses a non-http(s) address visibly instead of navigating to it', () => {
    const navigate = vi.fn();
    const registration = registerAgentBrowserScreen('pane-url-refuse', {
      snapshot: SCREEN,
      actions: { engageSync: vi.fn(), applyViewport: vi.fn(), openModal: vi.fn() },
      chrome: CHROME,
      chromeActions: { navigate, back: vi.fn(), forward: vi.fn(), reload: vi.fn() },
      hostCapable: true,
    });
    renderHeader(headerProps('pane-url-refuse', 'x'), stubActions());

    for (const typed of ['file:///tmp/report.html', 'about:blank']) {
      act(() => {
        (container.querySelector('span[title="Vite + React"]') as HTMLElement)
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const input = container.querySelector<HTMLInputElement>('[data-url-input-for="pane-url-refuse"]')!;
      act(() => {
        setNativeFieldValue(input, typed);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      const warning = document.querySelector('[data-url-refusal-for="pane-url-refuse"]');
      expect(warning?.textContent).toContain(typed);
      expect(warning?.textContent).toContain('http:// and https:// pages only');
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    }
    expect(navigate).not.toHaveBeenCalled();

    registration.dispose();
  });

  it('cancels URL editing on Escape without navigating', () => {
    const navigate = vi.fn();
    const registration = registerAgentBrowserScreen('pane-url-esc', {
      snapshot: SCREEN,
      actions: { engageSync: vi.fn(), applyViewport: vi.fn(), openModal: vi.fn() },
      chrome: CHROME,
      chromeActions: { navigate, back: vi.fn(), forward: vi.fn(), reload: vi.fn() },
      hostCapable: true,
    });
    renderHeader(headerProps('pane-url-esc', 'x'), stubActions());

    act(() => {
      (container.querySelector('span[title="Vite + React"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = container.querySelector<HTMLInputElement>('[data-url-input-for="pane-url-esc"]');
    expect(input).not.toBeNull();

    act(() => {
      setNativeFieldValue(input!, 'example.com');
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-url-input-for="pane-url-esc"]')).toBeNull();

    registration.dispose();
  });

  it('falls back to a plain title (no nav) for non-browser surfaces', () => {
    renderHeader(headerProps('pane-iframe', 'example.com'), stubActions());
    expect(container.textContent).toContain('example.com');
    expect(container.querySelector('[aria-label="Back"]')).toBeNull();
    expect(container.querySelector('[aria-label="Reload"]')).toBeNull();
  });
});
