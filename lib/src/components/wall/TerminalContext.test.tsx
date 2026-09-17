// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalContextView, type TerminalContextViewProps } from './TerminalContextView';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { TerminalPanel } from './TerminalPanel';
import { TerminalContext } from './TerminalContext';
import * as terminalRegistry from '../../lib/terminal-registry';
import * as helpers from '../../lib/helper-terminal';
import { addPlainNote, clearAllNotepads, getNotes, getOpenNotepadId } from '../../lib/notepad/notepad-store';
import { TerminalContextContext } from './wall-context';
import { ensureResizeObserver } from './wall-test-utils';
import { setMouseReporting, removeMouseSelectionState } from '../../lib/mouse-selection';
import { setPlatform } from '../../lib/platform';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { cfg } from '../../cfg';

vi.mock('../TerminalPane', () => ({ TerminalPane: () => <textarea aria-label="Fake terminal input" /> }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let props: TerminalContextViewProps;
let previousAnimate: boolean;
const port = (value: number) => ({ port: value, host: 'localhost', url: `http://localhost:${value}/` });
beforeEach(() => {
  previousAnimate = cfg.layout.animate;
  setPlatform(new FakePtyAdapter()); ensureResizeObserver();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  props = { title: 'pnpm dev', surfaceRef: 'surface:3', cwd: '~/repo', titleSources: [{ source: 'OSC 2', value: 'pnpm dev', note: 'Used' }], scan: { status: 'loaded', entries: [port(5173)] },
    argv0: 'pnpm', watching: false, todo: false, status: 'completed', command: 'git status', explorerLabel: 'Open in Finder', canExplore: true, canAgent: true, canIframe: true,
    onClose: vi.fn(), onCopyRef: vi.fn(), onCopyPath: vi.fn(), onExplore: vi.fn(), onWatch: vi.fn(), onTodo: vi.fn(), onPort: vi.fn(), onModify: vi.fn(async () => {}), onReset: vi.fn(async () => {}), onPromote: vi.fn(async () => {}),
    children: <div data-helper-terminal="helper"><textarea aria-label="Helper input" /></div> };
});
afterEach(() => { act(() => root.unmount()); container.remove(); removeMouseSelectionState('parent'); cfg.layout.animate = previousAnimate; vi.useRealTimers(); });
const render = () => act(() => root.render(<TerminalContextView {...props} />));
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = async (label: string) => { await act(async () => button(label).click()); };

it('shows static context and initial details together when layout animation is disabled', () => {
  cfg.layout.animate = false;
  props.initialDetail = 'title';
  render();
  const surface = container.querySelector('[data-terminal-context]')!;
  expect(surface.classList.contains('terminal-context-enter')).toBe(false);
  expect(container.querySelector('[role="dialog"]')?.closest('.terminal-context-content')).not.toBeNull();
});

it('keeps the opening action focused and Escape available while suppressing repeat launches', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  props.onExplore = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render();
  const launch = button('Open in Finder');
  act(() => launch.focus());
  await click('Open in Finder');
  expect(launch.disabled).toBe(false);
  expect(launch.getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(launch);
  await click('Open in Finder');
  expect(props.onExplore).toHaveBeenCalledOnce();
  act(() => launch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(props.onClose).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTime(800));
  expect(launch.getAttribute('aria-busy')).toBe('true');
  await act(async () => finish());
  expect(launch.hasAttribute('aria-disabled')).toBe(false);
  expect(document.activeElement).toBe(launch);
});

it('uses labeled title, directory and port actions without a redundant heading', () => {
  render(); expect(container.querySelector('h1,h2,h3')).toBeNull();
  for (const label of ['Explain this title', 'Copy absolute path', 'Open in Finder', 'Open in system browser', 'Open in iframe embed', 'Open in agent-browser screencast', 'Open in agent-browser popout']) expect(button(label)).not.toBeNull();
  expect(container.querySelector('select')).toBeNull();
});
it.each(['system', 'iframe', 'ab-screencast', 'ab-popout'] as const)('dispatches the selected port to %s', async mode => {
  props.scan = { status: 'loaded', entries: [port(5173), port(6006), port(9229)] }; render();
  const select = container.querySelector('select')!;
  act(() => { select.value = '6006'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(select.parentElement?.textContent).toContain('3 ports');
  const label = { system: 'Open in system browser', iframe: 'Open in iframe embed', 'ab-screencast': 'Open in agent-browser screencast', 'ab-popout': 'Open in agent-browser popout' }[mode];
  await click(label); expect(props.onPort).toHaveBeenCalledWith(port(6006), mode); expect(props.onClose).not.toHaveBeenCalled();
});
it.each(['scanning', 'failed', 'empty'] as const)('distinguishes %s ports', state => {
  props.scan = state === 'empty' ? { status: 'loaded', entries: [] } : { status: state }; render();
  expect(container.textContent).toContain(state === 'empty' ? 'No listening ports' : state === 'failed' ? 'Port scan failed' : 'Scanning ports');
  expect(button('Open in system browser')).toBeNull();
});
it('disables unsupported host capabilities with an explanation', () => {
  props.canAgent = false; props.canExplore = false; render();
  expect(button('Agent browser unavailable on this host').disabled).toBe(true);
  expect(button('Popout unavailable on this host').disabled).toBe(true);
  expect(button('Directory unavailable on this host').disabled).toBe(true);
});
it('opens title explanation as a disclosure', async () => {
  render(); expect(container.textContent).not.toContain('OSC 2'); await click('Explain this title');
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('OSC 2');
});
it('keeps helper keystrokes out of context dismissal', () => {
  render(); const input = container.querySelector('textarea')!;
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(props.onClose).not.toHaveBeenCalled();
  act(() => button('Close terminal context').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(props.onClose).toHaveBeenCalledOnce();
});
it('requires explicit confirmation before resetting a preserved helper', async () => {
  props.status = 'preserved'; render(); await click('Reset helper terminal'); await click('Keep helper'); expect(props.onReset).not.toHaveBeenCalled();
  await click('Reset helper terminal'); await click('Discard and reset'); expect(props.onReset).toHaveBeenCalledOnce();
});
it('keeps a failed promotion visible and retryable', async () => {
  props.onPromote = vi.fn(async () => { throw new Error('Placement failed'); }); render(); await click('Move this terminal into a new pane');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Placement failed'); expect(props.onClose).not.toHaveBeenCalled();
});
it('keeps a submitting detail button focused so the dialog keeps Escape and its Tab trap', async () => {
  let reject!: (reason: Error) => void;
  props.onModify = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  props.initialDetail = 'modify'; render();
  const save = button('Save default');
  act(() => save.focus());
  await click('Save default');
  // In flight: inert via aria-disabled only, so the browser cannot blur it.
  expect(save.disabled).toBe(false);
  expect(save.getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(save);
  await click('Save default');
  expect(props.onModify).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('Command rejected')));
  // The rejected edit keeps the dialog open, and focus never left the button.
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Command rejected');
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(save.hasAttribute('aria-disabled')).toBe(false);
  expect(document.activeElement).toBe(save);
  // So the <section>'s handlers still receive Tab and Escape from a focused descendant.
  act(() => save.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
  // Focus has to *move* and stay in: `contains` alone passes for a no-op Tab. Which element it
  // lands on is not asserted — jsdom returns a selector list grouped by selector rather than in
  // document order, so the trap's wrap target differs here from a real browser.
  expect(document.activeElement).not.toBe(save);
  expect(container.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
  act(() => (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(props.onClose).not.toHaveBeenCalled();
});
it('keeps the focus ring on an in-flight button while withholding only its hover styling', async () => {
  props.onModify = vi.fn(() => new Promise<void>(() => {}));
  props.initialDetail = 'modify'; render();
  const save = button('Save default');
  const rest = save.className;
  await click('Save default');
  // Hover is gated on aria-disabled; focus-visible is not, so the focused button keeps its ring.
  const hovers = rest.split(' ').filter(c => c.includes('hover:'));
  expect(hovers.length).toBeGreaterThan(0);
  for (const hover of hovers) expect(hover).toContain('not-aria-disabled:');
  for (const ring of ['focus-visible:outline', 'focus-visible:outline-focus-ring', 'enabled:focus-visible:text-link']) expect(save.className.split(' ')).toContain(ring);
  expect(save.className).toBe(rest);
});
it('shows both directories in the mismatch warning', () => {
  props.mismatch = true; props.helperCwd = '~/other'; render(); expect(container.querySelector('[role="alert"]')?.textContent).toContain('~/other'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('~/repo');
});
it('shares header, alert and uncaptured body entry points; captured mouse has no Shift escape', () => {
  const open = vi.fn(); const value = { id: null, mounted: null, open, close: vi.fn(), promote: vi.fn(), openPort: vi.fn() };
  act(() => root.render(<TerminalContextContext.Provider value={value}><TerminalPaneHeader id="parent" /><TerminalPanel id="parent" /></TerminalContextContext.Provider>));
  const header = container.querySelector('[data-pane-header-for]')!;
  const body = container.querySelector('textarea')!;
  const rightClick = (target: Element, shiftKey = false) => act(() => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, shiftKey, clientX: 120, clientY: 90 })));
  rightClick(header); rightClick(container.querySelector('[data-alert-button-for]')!); rightClick(body);
  expect(open).toHaveBeenCalledTimes(3);
  for (const call of open.mock.calls) expect(call).toEqual(['parent', { origin: { x: 120, y: 90 } }]);
  act(() => setMouseReporting('parent', 'vt200'));
  rightClick(body); rightClick(body, true); expect(open).toHaveBeenCalledTimes(3);
  rightClick(header); expect(open).toHaveBeenCalledTimes(4);
});

it('opens the parent notepad from the Helper control and keeps edits on that parent', async () => {
  const helper: helpers.HelperTerminal = { id: 'helper', parentId: 'parent', command: '', status: 'off' };
  const get = vi.spyOn(helpers, 'getHelper').mockReturnValue(helper);
  const open = vi.spyOn(helpers, 'openHelper').mockResolvedValue(helper);
  try {
    addPlainNote('parent', 'shared note');
    await act(async () => root.render(<TerminalContext id="parent" />));
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Notepad · 1 note"]');
    expect(toggle).not.toBeNull();
    await act(async () => toggle!.click());
    expect(getOpenNotepadId()).toBe('parent');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('shared note');
    await click('Delete note');
    expect(getNotes('parent')).toEqual([]);
    expect(getNotes('helper')).toEqual([]);
  } finally {
    get.mockRestore(); open.mockRestore();
    act(() => clearAllNotepads());
  }
});


it('uses the Tool primary terminal without creating a helper or offering helper lifecycle actions', async () => {
  const openHelper = vi.spyOn(helpers, 'openHelper');
  const focusTerminal = vi.fn();
  const terminal = vi.spyOn(terminalRegistry, 'getTerminalInstance').mockReturnValue({ focus: focusTerminal } as unknown as ReturnType<typeof terminalRegistry.getTerminalInstance>);
  const focusSurface = vi.spyOn(terminalRegistry, 'focusSession');
  await act(async () => { root.render(<TerminalContext id="tool-source" title="Storybook" tool />); });
  expect(openHelper).not.toHaveBeenCalled();
  expect(container.querySelector('[data-context-terminal="tool-source"]')).not.toBeNull();
  expect(container.querySelector('[data-helper-terminal]')).toBeNull();
  expect(container.querySelector('[aria-label="Tool terminal status"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Modify autorun command"]')).toBeNull();
  expect(container.querySelector('[aria-label="Reset helper terminal"]')).toBeNull();
  expect(container.querySelector('[aria-label="Move this terminal into a new pane"]')).toBeNull();
  act(() => container.querySelector('[data-context-terminal]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  expect(focusTerminal).toHaveBeenCalledOnce();
  expect(focusSurface).not.toHaveBeenCalled();
  openHelper.mockRestore(); terminal.mockRestore(); focusSurface.mockRestore();
});
