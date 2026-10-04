/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneProps } from './pane-props';
import { ToolPaneHeader } from './ToolPaneHeader';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { setPlatform } from '../../lib/platform';
import { setNativeFieldValue } from '../../lib/dom';
import { recordToolDirty, resetToolDirty } from '../../lib/tool-dirty-store';
import { applyTerminalSemanticEvents, removeTerminalPaneState, setTerminalUserTitle } from '../../lib/terminal-state-store';
import { commitPreviewTransition, resetPreviewTransitions } from '../../lib/preview-transition-store';
import * as terminalRegistry from '../../lib/terminal-registry';
import { clearTerminalActivity, setTerminalActivity } from '../../lib/session-activity-store';
import { setDevServerResolution } from './agent-browser-ports';
import { beginSlotSwitch } from './preview-transition';
import {
  ModeContext,
  RenamingIdContext,
  SelectedIdContext,
  TerminalContextContext,
  WallActionsContext,
  WindowFocusedContext,
  WorkspaceActiveContext,
  ZoomedIdContext,
  type WallActions,
} from './wall-context';
import { doubleClick, registerStubScreen, STUB_CHROME, STUB_SCREEN, stubResizeObserver, stubWallActions as stubActions } from './wall-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ID = 'tool-header';
/** A.md's viewer, serving. */
const SERVING = {
  surfaceType: 'tool', command: 'view /repo/a.md', toolName: 'viewer', toolKey: ['viewer', '/repo/a.md'], toolTarget: '/repo/a.md',
  url: STUB_CHROME.url, renderMode: 'agent-browser-screencast',
};

let container: HTMLDivElement;
let root: Root;
let resizeHeader: (width: number) => void;
let registration: { dispose(): void } | null;

beforeEach(() => {
  setPlatform(new FakePtyAdapter());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  resizeHeader = stubResizeObserver(620);
  registration = registerStubScreen(ID);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  registration?.dispose();
  vi.unstubAllGlobals();
  resetToolDirty();
  resetPreviewTransitions();
  removeTerminalPaneState(ID);
  clearTerminalActivity(ID);
});

const context = { id: null, mounted: null, open: vi.fn(), close: vi.fn(), promote: vi.fn(), openPort: vi.fn() };

function renderHeader(params: Record<string, unknown>, actions: WallActions = stubActions(), options: { renaming?: boolean; title?: string } = {}) {
  const props: PaneProps = { id: ID, title: options.title ?? 'viewer', params };
  act(() => {
    root.render(
      <StrictMode>
        <WorkspaceActiveContext.Provider value={true}>
          <ModeContext.Provider value="passthrough">
            <SelectedIdContext.Provider value={ID}>
              <WindowFocusedContext.Provider value={true}>
                <ZoomedIdContext.Provider value={null}>
                  <RenamingIdContext.Provider value={options.renaming ? ID : null}>
                    <TerminalContextContext.Provider value={context}>
                      <WallActionsContext.Provider value={actions}>
                        <ToolPaneHeader {...props} />
                      </WallActionsContext.Provider>
                    </TerminalContextContext.Provider>
                  </RenamingIdContext.Provider>
                </ZoomedIdContext.Provider>
              </WindowFocusedContext.Provider>
            </SelectedIdContext.Provider>
          </ModeContext.Provider>
        </WorkspaceActiveContext.Provider>
      </StrictMode>,
    );
  });
}

const header = () => container.querySelector<HTMLElement>(`[data-pane-header-for="${ID}"]`)!;
const name = () => container.querySelector<HTMLElement>(`[data-pane-title-for="${ID}"]`);
const labelled = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
/** The accessible names of the header's controls, in order. */
const controls = () => [...header().querySelectorAll('button')].map(button => button.getAttribute('aria-label'));

describe('ToolPaneHeader — a serving Tool', () => {
  it('shows Display, Terminal Context, and the name inside its own header, with no navigation or address', () => {
    renderHeader(SERVING);
    expect(header().className).toContain('bg-header-active-bg');
    expect(controls()).toEqual([
      'agent-browser resizes with pane — change display', 'Terminal context',
      'Split left/right', 'Split top/bottom', 'Zoom', 'Minimize', 'Break', 'Kill',
    ]);
    // The name sits after both, before the layout buttons.
    const order = [labelled('Terminal context')!, name()!, labelled('Split left/right')!];
    expect(order.every((element, index) => index === 0 || (order[index - 1].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    expect(name()?.textContent).toBe('a.md');
    expect(name()?.className).toContain('font-medium');
    for (const absent of ['Back', 'Forward', 'Reload', 'Browser controls']) expect(labelled(absent)).toBeNull();
    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(container.textContent).not.toContain('localhost');
    expect(container.textContent).not.toContain(STUB_CHROME.key!);
  });

  it("shows its Session's TODO pill, which clears the TODO", () => {
    act(() => setTerminalActivity(ID, { todo: true, notification: { title: 'Tool finished', body: null } }));
    renderHeader(SERVING);
    const pill = container.querySelector<HTMLButtonElement>(`[data-session-todo-for="${ID}"]`);
    expect(pill?.getAttribute('aria-label')).toBe('Dismiss TODO: Tool finished');
    // Between the name and the layout buttons, as on a terminal's header.
    expect(name()!.compareDocumentPosition(pill!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pill!.compareDocumentPosition(labelled('Split left/right')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const cleared = vi.spyOn(terminalRegistry, 'clearSessionTodo');
    act(() => pill!.click());
    expect(cleared).toHaveBeenCalledWith(ID);
  });

  it('opens its Terminal Context from under the button', () => {
    renderHeader(SERVING);
    context.open.mockClear();
    act(() => labelled('Terminal context')!.click());
    expect(context.open).toHaveBeenCalledWith(ID, { origin: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }) });
    act(() => header().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 12 })));
    expect(context.open).toHaveBeenLastCalledWith(ID, { origin: { x: 30, y: 12 } });
  });

  it('names the Tool from its params alone: never its port, page, or terminal output', () => {
    setDevServerResolution(5173, { paneId: ID, fallbackTitle: 'other' });
    try {
      renderHeader(SERVING);
      act(() => applyTerminalSemanticEvents(ID, [{ type: 'title', title: { title: 'terminal title', source: 'osc2', updatedAt: 1 } }]));
      expect(name()?.textContent).toBe('a.md');
      renderHeader({ ...SERVING, toolTarget: undefined, toolKey: ['viewer', '/Users/me/dormouse.open-folder'] });
      expect(name()?.textContent).toBe('viewer dormouse.open-folder');
      renderHeader({ surfaceType: 'tool', command: 'python3 -m http.server', url: STUB_CHROME.url });
      expect(name()?.textContent).toBe('python3 -m http.server');
    } finally {
      setDevServerResolution(5173, null);
    }
  });

  it('shows the user\'s rename, and renames from a click on its name or from the shortcut', () => {
    const onStartRename = vi.fn();
    const onFinishRename = vi.fn((id: string, value: string) => setTerminalUserTitle(id, value));
    renderHeader(SERVING, stubActions({ onStartRename, onFinishRename }));
    act(() => name()!.click());
    expect(onStartRename).toHaveBeenCalledWith(ID);
    renderHeader(SERVING, stubActions({ onStartRename, onFinishRename }), { renaming: true });
    const input = container.querySelector<HTMLInputElement>(`[data-renaming-input-for="${ID}"]`)!;
    expect(input.value).toBe('a.md');
    act(() => { setNativeFieldValue(input, 'notes'); });
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onFinishRename).toHaveBeenCalledWith(ID, 'notes');
    renderHeader(SERVING, stubActions());
    expect(name()?.textContent).toBe('notes');
  });

  it('collapses by its own width: splits, then Display, then minimize and kill', () => {
    renderHeader(SERVING);
    act(() => recordToolDirty(ID, true));
    const steps: [number, (string | null)[]][] = [
      [382, ['agent-browser resizes with pane — change display', 'Terminal context', 'Split left/right', 'Split top/bottom', 'Zoom', 'Minimize', 'Break', 'Kill']],
      [381, ['agent-browser resizes with pane — change display', 'Terminal context', 'Zoom', 'Minimize', 'Break', 'Kill']],
      [187, ['agent-browser resizes with pane — change display', 'Terminal context', 'Zoom', 'Minimize', 'Break', 'Kill']],
      [186, ['Terminal context', 'Zoom', 'Minimize', 'Break', 'Kill']],
      [151, ['Terminal context', 'Zoom', 'Minimize', 'Break', 'Kill']],
      [150, ['Terminal context', 'Zoom']],
      [80, ['Terminal context', 'Zoom']],
    ];
    for (const [width, expected] of steps) {
      act(() => resizeHeader(width));
      expect(controls(), `${width}px`).toEqual(expected);
      expect(labelled('Unsaved changes'), `${width}px`).not.toBeNull();
      expect(name()?.textContent).toBe('a.md');
    }
  });
});

describe('ToolPaneHeader — preview slot', () => {
  const PREVIEW = { ...SERVING, toolPreview: true };

  it('italicizes the name, titled Preview, as its only mark at every width', () => {
    renderHeader(PREVIEW);
    for (const width of [620, 200, 140, 100]) {
      act(() => resizeHeader(width));
      expect(name()?.className).toContain('italic');
      expect(name()?.title).toBe('Preview');
      expect(container.querySelectorAll('.italic')).toHaveLength(1);
      expect(container.textContent).not.toContain('Preview');
    }
  });

  it('keeps the slot on a double-click of its name or empty header, never of a control, and its name renames nothing', () => {
    const onPinPreview = vi.fn();
    const onStartRename = vi.fn();
    renderHeader(PREVIEW, stubActions({ onPinPreview, onStartRename }));
    const buttons = [...header().querySelectorAll('button')];
    expect(buttons.map(button => button.getAttribute('aria-label'))).toContain('Terminal context');
    for (const button of buttons) doubleClick(button);
    expect(onPinPreview).not.toHaveBeenCalled();
    doubleClick(name()!);
    expect(onPinPreview).toHaveBeenCalledExactlyOnceWith(ID);
    doubleClick(header());
    expect(onPinPreview).toHaveBeenCalledTimes(2);
    expect(onStartRename).not.toHaveBeenCalled();
  });

  it('marks nothing once pinned, and a double-click keeps nothing', () => {
    const onPinPreview = vi.fn();
    renderHeader(SERVING, stubActions({ onPinPreview }));
    expect(container.querySelector('.italic')).toBeNull();
    doubleClick(header());
    expect(onPinPreview).not.toHaveBeenCalled();
  });

  it('holds the browser face and its Display glyph through a switch, naming the new target once it is retargeted', () => {
    renderHeader(PREVIEW);
    const shown = name();
    const glyph = () => container.querySelector('[data-browser-display-mode]')?.getAttribute('data-browser-display-mode');
    expect(glyph()).toBe('agent-browser-resize');
    let token!: number;
    act(() => { token = beginSlotSwitch(ID, () => PREVIEW)!; });
    // Retired: its screencast gone, the incoming layer an embed without a URL.
    act(() => {
      registration!.dispose();
      registration = registerStubScreen(ID, { snapshot: { ...STUB_SCREEN, renderMode: 'iframe', syncEngaged: false }, chrome: { url: '', displayUrl: '', title: null, key: null } });
    });
    const retired = { ...PREVIEW, url: undefined, renderMode: undefined };
    renderHeader(retired);
    expect(name()).toBe(shown);
    expect(name()?.textContent).toBe('a.md');
    expect(glyph()).toBe('agent-browser-resize');
    act(() => { commitPreviewTransition(ID, token, () => () => {}); });
    renderHeader({ ...retired, command: 'view /repo/b.md', toolKey: ['viewer', '/repo/b.md'], toolTarget: '/repo/b.md' });
    expect(name()).toBe(shown);
    expect(name()?.textContent).toBe('b.md');
    // Ended without a URL, the Tool shows its terminal face.
    act(() => resetPreviewTransitions());
    expect(name()).not.toBe(shown);
    expect(labelled('Terminal context')).toBeNull();
  });

  it('holds a terminal face\'s label through a switch, then names the Tool the retarget committed', () => {
    const params = { surfaceType: 'tool', command: 'less /repo/a.md', toolTarget: '/repo/a.md', toolPreview: true };
    act(() => applyTerminalSemanticEvents(ID, [
      { type: 'commandLine', commandLine: 'less /repo/a.md' }, { type: 'commandStart', source: 'osc633_boundaries' },
    ]));
    renderHeader(params);
    const label = () => name()?.textContent;
    const shown = label();
    expect(shown).toContain('less /repo/a.md');
    let token!: number;
    act(() => { token = beginSlotSwitch(ID, () => params)!; });
    act(() => applyTerminalSemanticEvents(ID, [{ type: 'commandFinish', exitCode: 130 }, { type: 'promptStart' }]));
    expect(label()).toBe(shown);
    act(() => { commitPreviewTransition(ID, token, () => () => {}); });
    renderHeader({ ...params, command: 'less /repo/b.md', toolTarget: '/repo/b.md' });
    expect(label()).toBe('b.md');
    act(() => resetPreviewTransitions());
    // Derived live again: neither the held label nor the committed name.
    expect([shown, 'b.md']).not.toContain(label());
  });
});

describe('ToolPaneHeader — other faces', () => {
  const DIRTY_FACES = [
    ['terminal', {}],
    ['port conflict', { toolPortConflict: [3000, 4000] }],
    ['browser', { url: STUB_CHROME.url }],
  ] as const;
  const indicator = () => labelled('Unsaved changes');

  it.each(DIRTY_FACES)('shows live unsaved changes on the %s face at narrow widths', (_face, params) => {
    renderHeader({ surfaceType: 'tool', command: 'pnpm dev', ...params });
    act(() => resizeHeader(100));
    expect(indicator()).toBeNull();
    act(() => recordToolDirty(ID, true));
    expect(indicator()).not.toBeNull();
    expect(labelled('Zoom')).not.toBeNull();
    act(() => recordToolDirty(ID, false));
    expect(indicator()).toBeNull();
    act(() => recordToolDirty(ID, true));
    act(() => recordToolDirty(ID, null));
    expect(indicator()).toBeNull();
  });

  it.each(DIRTY_FACES)('keeps the dirty %s face’s Kill target stable through reports and rename', (_face, params) => {
    const actions = stubActions();
    const toolParams = { surfaceType: 'tool', command: 'pnpm dev', ...params };
    renderHeader(toolParams, actions);
    const kill = labelled('Kill')!;
    act(() => recordToolDirty(ID, true));
    expect(labelled('Kill')).toBe(kill);
    expect(kill.contains(indicator())).toBe(true);
    expect(kill.getAttribute('aria-description')).toBe('Unsaved changes');
    act(() => kill.click());
    expect(actions.onKill).toHaveBeenCalledWith(ID);
    renderHeader(toolParams, actions, { renaming: true });
    expect(labelled('Kill')).toBeNull();
    expect(indicator()).not.toBeNull();
    renderHeader(toolParams, actions);
    act(() => recordToolDirty(ID, false));
    expect(labelled('Kill')!.getAttribute('aria-description')).toBeNull();
    expect(indicator()).toBeNull();
  });

  it('leads a port conflict\'s derived label with Terminal Context, inside the header', () => {
    renderHeader({ surfaceType: 'tool', command: 'pnpm dev', toolPortConflict: [3000, 4000] });
    const button = labelled('Terminal context')!;
    expect(header().contains(button)).toBe(true);
    expect(controls()[0]).toBe('Terminal context');
    expect(button.compareDocumentPosition(name()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(labelled('Change display')).toBeNull();
  });

  it('shows no Terminal Context on the terminal face, which shows that terminal', () => {
    renderHeader({ surfaceType: 'tool', command: 'pnpm dev' });
    expect(labelled('Terminal context')).toBeNull();
    expect(name()).not.toBeNull();
  });

  it('re-tiers when a port conflict comes and goes, though the header\'s width never changes', () => {
    act(() => resizeHeader(136));
    renderHeader({ surfaceType: 'tool', command: 'pnpm dev' });
    expect(labelled('Kill')).not.toBeNull();
    renderHeader({ surfaceType: 'tool', command: 'pnpm dev', toolPortConflict: [3000, 4000] });
    expect(labelled('Terminal context')).not.toBeNull();
    expect(labelled('Kill')).toBeNull();
    renderHeader({ surfaceType: 'tool', command: 'pnpm dev' });
    expect(labelled('Kill')).not.toBeNull();
  });

  it('keeps the port-conflict face\'s minimize and kill to the Terminal Context button\'s narrowest boundary', () => {
    renderHeader({ surfaceType: 'tool', command: 'pnpm dev', toolPortConflict: [3000, 4000] });
    act(() => resizeHeader(151));
    expect(labelled('Kill')).not.toBeNull();
    act(() => resizeHeader(150));
    expect(labelled('Kill')).toBeNull();
    expect(labelled('Zoom')).not.toBeNull();
  });
});
