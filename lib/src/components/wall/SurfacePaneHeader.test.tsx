/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneProps } from './pane-props';
import { recordToolDirty } from '../../lib/tool-dirty-store';
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
  SelectedIdContext,
  WallActionsContext,
  WindowFocusedContext,
  ZoomedIdContext,
  type WallActions,
} from './wall-context';
import { registerStubScreen, STUB_CHROME, STUB_SCREEN, stubWallActions as stubActions } from './wall-test-utils';
import { setNativeFieldValue } from '../../lib/dom';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SCREEN = STUB_SCREEN;
const CHROME = STUB_CHROME;

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
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      resizeHeader = width => this.callback([{ target, borderBoxSize: [{ inlineSize: width }], contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      resizeHeader(620);
    }
    disconnect() {}
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderHeader(
  props: PaneProps,
  actions: WallActions,
  state: { active?: boolean; zoomedId?: string | null; tool?: boolean } = {},
) {
  act(() => {
    root.render(
      <StrictMode>
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
      </StrictMode>,
    );
  });
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
      act(() => resizeHeader(100));
      const indicator = () => container.querySelector('[role="img"][aria-label="Unsaved changes"]');
      expect(indicator()).toBeNull();
      act(() => recordToolDirty(id, true));
      expect(indicator()).not.toBeNull();
      expect(container.querySelector('[aria-label="Kill"]')).not.toBeNull();
      act(() => addPlainNote(id, 'Keep this note'));
      expect(indicator()).not.toBeNull();
      if ('url' in params) {
        // A 103px Tool has only 79px of browser chrome. The dirty dot remains
        // outside the menu; essential controls join the menu before overflowing.
        act(() => resizeHeader(79));
        expect(indicator()).not.toBeNull();
        expect(container.querySelector('[aria-label="Kill"]')).toBeNull();
        act(() => container.querySelector<HTMLButtonElement>('[aria-label="Browser controls, 1 note"]')!.click());
        expect(document.querySelector('[role="dialog"] [aria-label="Kill"]')).not.toBeNull();
        expect(container.contains(indicator())).toBe(true);
      }
      act(() => recordToolDirty(id, false));
      expect(indicator()).toBeNull();
      act(() => recordToolDirty(id, true));
      expect(indicator()).not.toBeNull();
      act(() => recordToolDirty(id, null));
      expect(indicator()).toBeNull();
    } finally {
      registration.dispose();
      act(() => recordToolDirty(id, null));
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
      act(() => recordToolDirty(id, null));
    }
  });

  it('adapts to pane resizes in a wide window and keeps compact controls keyboard reachable', async () => {
    const registration = register('pane-resize', { ...CHROME, key: 'a'.repeat(300) });
    const actions = stubActions();
    renderHeader({ ...headerProps('pane-resize', 'Browser'), params: { surfaceType: 'tool', url: CHROME.url } }, actions, { tool: true });
    expect(container.querySelector('[aria-label="Terminal context"]')).not.toBeNull();
    const viewport = window.innerWidth;
    expect(container.querySelector('[aria-label="Back"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Zoom"]')).not.toBeNull();
    act(() => resizeHeader(400));
    expect(container.querySelector('[aria-label="Back"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Zoom"]')).toBeNull();
    act(() => resizeHeader(340));
    expect(container.querySelector('[aria-label="Back"]')).toBeNull();
    // A 103px Tool leaves 79px beside its Terminal Context button.
    act(() => resizeHeader(79));
    const overflow = container.querySelector<HTMLButtonElement>('[aria-label="Browser controls"]')!;
    expect(overflow).not.toBeNull();
    for (const label of ['Minimize', 'Kill']) {
      act(() => overflow.click());
      act(() => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
      expect(document.querySelector('[role="dialog"][aria-label="Browser controls"]')).toBeNull();
    }
    expect(actions.onMinimize).toHaveBeenCalledWith('pane-resize');
    expect(actions.onKill).toHaveBeenCalledWith('pane-resize');
    act(() => overflow.click());
    let dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Browser controls"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const firstControl = document.activeElement;
    act(() => firstControl!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.activeElement).not.toBe(firstControl);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(dialog.querySelector('[aria-label="Back"]')).not.toBeNull();
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[aria-label="Split left/right"]')!.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(actions.onSplitH).toHaveBeenCalledWith('pane-resize');
    expect(document.querySelector('[role="dialog"][aria-label="Browser controls"]')).toBeNull();
    act(() => overflow.click());
    dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Browser controls"]')!;
    const url = dialog.querySelector<HTMLElement>('[role="button"]')!;
    act(() => { url.focus(); url.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(dialog.querySelector('input')).not.toBeNull();
    act(() => dialog.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"][aria-label="Browser controls"]')).toBeNull();
    expect(document.activeElement).toBe(overflow);
    act(() => addPlainNote('pane-resize', 'A saved note'));
    expect(overflow.getAttribute('aria-label')).toBe('Browser controls, 1 note');
    act(() => overflow.click());
    expect(document.querySelector('[role="dialog"] input')).toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label^="Notepad"]')!.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(getOpenNotepadId()).toBe('pane-resize');
    act(() => resizeHeader(56));
    expect(container.querySelector('[aria-label="Kill"]')).toBeNull();
    for (const label of ['Minimize', 'Kill']) {
      act(() => overflow.click());
      await act(async () => { document.querySelector<HTMLButtonElement>(`[role="dialog"] [aria-label="${label}"]`)!.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    }
    expect(actions.onMinimize).toHaveBeenCalledTimes(2);
    expect(actions.onKill).toHaveBeenCalledTimes(2);
    act(() => resizeHeader(620));
    expect(container.querySelector('[aria-label^="Browser controls"]')).toBeNull();
    expect(container.querySelector('[aria-label="Back"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Zoom"]')).not.toBeNull();
    expect(window.innerWidth).toBe(viewport);
    registration.dispose();
  });

  it('runs popup Zoom, Reload and Display before dismissal and preserves modal focus', async () => {
    const modalControl = document.createElement('button');
    document.body.appendChild(modalControl);
    const stillOwnsFocus = () => {
      const popup = document.querySelector('[role="dialog"][aria-label="Browser controls"]');
      expect(popup?.contains(document.activeElement)).toBe(true);
    };
    const onZoom = vi.fn(stillOwnsFocus);
    const reload = vi.fn(stillOwnsFocus);
    const openModal = vi.fn(() => { stillOwnsFocus(); modalControl.focus(); });
    const registration = registerAgentBrowserScreen('pane-popup-actions', {
      snapshot: SCREEN, chrome: CHROME, hostCapable: true,
      actions: { engageSync: vi.fn(), applyDevice: vi.fn(), applyViewport: vi.fn(), openModal },
      chromeActions: { navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), reload },
    });
    try {
      renderHeader(headerProps('pane-popup-actions', 'Browser'), stubActions({ onZoom }));
      act(() => resizeHeader(79));
      const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Browser controls"]')!;
      for (const selector of ['[aria-label="Zoom"]', '[aria-label="Reload"]', '[data-browser-display-trigger]']) {
        act(() => trigger.click());
        const action = document.querySelector<HTMLButtonElement>(`[role="dialog"] ${selector}`)!;
        await act(async () => { action.focus(); action.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(document.querySelector('[role="dialog"][aria-label="Browser controls"]')).toBeNull();
      }
      expect(onZoom).toHaveBeenCalledWith('pane-popup-actions');
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
