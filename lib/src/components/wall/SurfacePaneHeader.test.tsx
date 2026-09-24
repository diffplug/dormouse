/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneProps } from './pane-props';
import { recordToolDirty, resetToolDirty } from '../../lib/tool-dirty-store';
import { SurfacePaneHeader } from './SurfacePaneHeader';
import { ToolPaneHeader } from './ToolPaneHeader';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { setPlatform } from '../../lib/platform';
import { addPlainNote, clearAllNotepads, getOpenNotepadId } from '../../lib/notepad/notepad-store';
import {
  registerAgentBrowserScreen,
  type ChromeSnapshot,
  type ScreenSnapshot,
} from './agent-browser-screen';
import { setDevServerResolution } from './agent-browser-ports';
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
const OVERFLOW_PX = 102; // chrome behind the trigger, minimize/kill still inline
const TIGHT_PX = 94;     // a dirty report moves minimize/kill into the popover
const TINY_PX = 80;      // zoom alone beside the trigger

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
  clearAllNotepads();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  resizeHeader = stubResizeObserver(620);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  resetToolDirty();
  vi.restoreAllMocks();
});

function renderHeader(
  props: PaneProps,
  actions: WallActions,
  state: { active?: boolean; zoomedId?: string | null; tool?: boolean; workspaceActive?: boolean } = {},
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
                    {state.tool ? <ToolPaneHeader {...props} /> : <SurfacePaneHeader {...props} />}
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
/** The compact header's trigger; its label grows a note count. */
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
  it.each([
    ['terminal', {}],
    ['port conflict', { toolPortConflict: [3000, 4000] }],
    ['browser', { url: CHROME.url }],
  ])('shows live unsaved changes on the Tool %s face at narrow widths', (_face, params) => {
    const id = 'dirty-tool-header';
    const registration = register(id);
    try {
      renderHeader({ ...headerProps(id, 'Tool'), params: { surfaceType: 'tool', ...params } }, stubActions(), { tool: true });
      act(() => resizeHeader(120));
      const indicator = () => container.querySelector('[role="img"][aria-label="Unsaved changes"]');
      expect(indicator()).toBeNull();
      act(() => recordToolDirty(id, true));
      expect(indicator()).not.toBeNull();
      expect(container.querySelector('[aria-label="Kill"]')).not.toBeNull();
      act(() => addPlainNote(id, 'Keep this note'));
      expect(indicator()).not.toBeNull();
      act(() => recordToolDirty(id, false));
      expect(indicator()).toBeNull();
      act(() => recordToolDirty(id, true));
      expect(indicator()).not.toBeNull();
      act(() => recordToolDirty(id, null));
      expect(indicator()).toBeNull();
    } finally {
      registration.dispose();
    }
  });

  it('keeps the dirty dot outside the browser overflow menu that Kill joins at the tight tier', () => {
    // A 118px Tool has only 94px of browser chrome: the dot stays inline and
    // essential controls join the menu before overflowing.
    const id = 'dirty-tool-header-narrow';
    const registration = register(id);
    try {
      recordToolDirty(id, true);
      addPlainNote(id, 'Keep this note');
      renderHeader({ ...headerProps(id, 'Tool'), params: { surfaceType: 'tool', url: CHROME.url } }, stubActions(), { tool: true });
      act(() => resizeHeader(TIGHT_PX));
      const indicator = () => container.querySelector('[role="img"][aria-label="Unsaved changes"]');
      expect(indicator()).not.toBeNull();
      expect(container.querySelector('[aria-label="Kill"]')).toBeNull();
      // Zoom never joins the menu: it is the last control the header keeps.
      expect(container.querySelector('[aria-label="Zoom"]')).not.toBeNull();
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Browser controls, 1 note"]')!.click());
      expect(document.querySelector('[role="dialog"] [aria-label="Kill"]')).not.toBeNull();
      expect(container.contains(indicator())).toBe(true);
    } finally {
      registration.dispose();
    }
  });

  it.each([TIGHT_PX, 100, OVERFLOW_PX])('repositions essential actions on dirty updates at a fixed %spx width', width => {
    const id = 'dirty-fixed-width';
    const registration = register(id);
    try {
      renderHeader({ ...headerProps(id, 'Tool'), params: { surfaceType: 'tool', url: CHROME.url } }, stubActions(), { tool: true });
      act(() => resizeHeader(width));
      const inlineKill = container.querySelector<HTMLButtonElement>('[aria-label="Kill"]')!;
      act(() => inlineKill.focus());
      expect(document.activeElement).toBe(inlineKill);
      act(() => recordToolDirty(id, true));
      expect(container.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
      if (width < OVERFLOW_PX) {
        expect(container.querySelector('[aria-label="Kill"]')).toBeNull();
        expect(document.activeElement).toBe(overflowTrigger());
        openPopup();
        expect(inPopup('[aria-label="Kill"]')).not.toBeNull();
        act(() => inPopup('[aria-label="Kill"]')!.focus());
        expect(document.activeElement).toBe(inPopup('[aria-label="Kill"]'));
      } else {
        expect(document.activeElement).toBe(inlineKill);
      }
      act(() => recordToolDirty(id, false));
      expect(container.querySelector('[aria-label="Unsaved changes"]')).toBeNull();
      expect(container.querySelector('[aria-label="Kill"]')).not.toBeNull();
      expect(inPopup('[aria-label="Kill"]')).toBeNull();
      if (width < OVERFLOW_PX) {
        expect(popup()).toBeNull();
        expect(document.activeElement).toBe(overflowTrigger());
      }
    } finally {
      registration.dispose();
    }
  });

  it.each([null, false].flatMap(initial =>
    (['inline', 'elsewhere', 'hidden'] as const).map(focus => ({ initial, focus })),
  ))('handles $initial → dirty with $focus focus at a fixed narrow width', ({ initial, focus }) => {
    const id = 'dirty-inline-focus';
    const registration = register(id);
    const props = { ...headerProps(id, 'Tool'), params: { surfaceType: 'tool', url: CHROME.url } };
    const actions = stubActions();
    const other = document.createElement('button');
    document.body.appendChild(other);
    try {
      recordToolDirty(id, initial);
      renderHeader(props, actions, { tool: true });
      act(() => resizeHeader(TIGHT_PX));
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!.focus());
      if (focus === 'elsewhere') act(() => other.focus());
      if (focus === 'hidden') renderHeader(props, actions, { tool: true, workspaceActive: false });
      act(() => recordToolDirty(id, true));
      expect(container.querySelector('[aria-label="Minimize"]')).toBeNull();
      expect(popup()).toBeNull();
      expect(document.activeElement).toBe(focus === 'inline' ? overflowTrigger() : focus === 'elsewhere' ? other : document.body);
    } finally {
      other.remove();
      registration.dispose();
    }
  });

  it.each(['terminal', 'browser'] as const)('ignores dirty reports on an ordinary %s', kind => {
    const id = 'dirty-non-tool-header';
    const registration = register(id);
    try {
      act(() => recordToolDirty(id, true));
      renderHeader({ ...headerProps(id, 'Ordinary'), params: { surfaceType: kind, url: CHROME.url } }, stubActions(), { tool: kind === 'terminal' });
      expect(container.querySelector('[aria-label="Unsaved changes"]')).toBeNull();
    } finally {
      registration.dispose();
    }
  });

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

  it('collapses chrome by its own width, excluding the Tool context button', () => {
    const registration = register('pane-resize', { ...CHROME, key: 'a'.repeat(300) });
    renderHeader({ ...headerProps('pane-resize', 'Browser'), params: { surfaceType: 'tool', url: CHROME.url } }, stubActions(), { tool: true });
    const split = () => container.querySelector('[aria-label="Split left/right"]');
    const zoom = () => container.querySelector('[aria-label="Zoom"]');
    expect(container.querySelector('[aria-label="Terminal context"]')).not.toBeNull();
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
    // A 126px Tool leaves 102px beside its Terminal Context button.
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

  it('names notes on the trigger and opens the notepad from the popover', async () => {
    const registration = register('pane-notes');
    renderHeader(headerProps('pane-notes', 'Browser'), stubActions());
    act(() => resizeHeader(OVERFLOW_PX));
    act(() => addPlainNote('pane-notes', 'A saved note'));
    expect(overflowTrigger().getAttribute('aria-label')).toBe('Browser controls, 1 note');
    openPopup();
    expect(inPopup('input')).toBeNull();
    await clickAndSettle(inPopup('button[aria-label^="Notepad"]')!);
    expect(getOpenNotepadId()).toBe('pane-notes');
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
      actions: { engageSync: vi.fn(), applyDevice: vi.fn(), applyViewport: vi.fn(), openModal },
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
      [{ ...SCREEN, renderMode: 'ab-screencast', syncEngaged: true }, 'ab-resize', 2],
      [{ ...SCREEN, renderMode: 'ab-screencast', syncEngaged: false }, 'ab-fixed', 2],
      [{ ...SCREEN, renderMode: 'ab-popout', syncEngaged: false }, 'ab-popout', 2],
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
    setDevServerResolution(5173, { paneId: 'term-9', label: 'pnpm dev' });
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
      actions: { engageSync: vi.fn(), applyDevice: vi.fn(), applyViewport: vi.fn(), openModal: vi.fn() },
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
      actions: { engageSync: vi.fn(), applyDevice: vi.fn(), applyViewport: vi.fn(), openModal: vi.fn() },
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
      actions: { engageSync: vi.fn(), applyDevice: vi.fn(), applyViewport: vi.fn(), openModal: vi.fn() },
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
