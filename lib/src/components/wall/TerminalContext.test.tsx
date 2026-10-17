// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { contextTeeth, teethCount, TerminalContextView, type TerminalContextViewProps } from './TerminalContextView';
import { TERMINAL_CONTEXT_TEETH_PX } from '../design';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { TerminalPanel } from './TerminalPanel';
import { TerminalContext } from './TerminalContext';
import * as terminalRegistry from '../../lib/terminal-registry';
import * as helpers from '../../lib/helper-terminal';
import { TerminalContextContext, WorkspaceActiveContext } from './wall-context';
import { ensureResizeObserver, PortalAnchoredButton } from './wall-test-utils';
import { setMouseReporting, removeMouseSelectionState } from '../../lib/mouse-selection';
import { setPlatform } from '../../lib/platform';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { rememberBrowserProvider } from './BrowserProviderSwitch';
import { cfg } from '../../cfg';
import { cwdFromOsc633, cwdFromOsc7, cwdFromOsc9_9 } from '../../lib/terminal-state';

vi.mock('../TerminalPane', () => ({ TerminalPane: () => <textarea aria-label="Fake terminal input" /> }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let props: TerminalContextViewProps;
let previousAnimate: boolean;
const port = (value: number) => ({ port: value, host: 'localhost', url: `http://localhost:${value}/` });
beforeEach(() => {
  rememberBrowserProvider('agent-browser');
  previousAnimate = cfg.layout.animate;
  setPlatform(new FakePtyAdapter()); ensureResizeObserver();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  props = { title: 'pnpm dev', surfaceId: 'surface:3', cwd: '~/repo', titleSources: [{ source: 'OSC 2', value: 'pnpm dev', note: 'Used' }], scan: { status: 'loaded', entries: [port(5173)] },
    watchRule: 'pnpm', watching: false, todo: false, status: 'completed', command: 'git status', explorerLabel: 'Reveal in Finder', canExplore: true, browserProviders: ['agent-browser', 'playwright'], canIframe: true,
    onClose: vi.fn(), onCopyId: vi.fn(), onCopyPath: vi.fn(), onExplore: vi.fn(), onWatch: vi.fn(), onTodo: vi.fn(), onPort: vi.fn(), onModify: vi.fn(async () => {}), onReset: vi.fn(async () => {}), onPromote: vi.fn(async () => {}),
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
  const launch = button('Reveal in Finder');
  act(() => launch.focus());
  await click('Reveal in Finder');
  expect(launch.disabled).toBe(false);
  expect(launch.getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(launch);
  await click('Reveal in Finder');
  expect(props.onExplore).toHaveBeenCalledOnce();
  act(() => launch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(props.onClose).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTime(800));
  expect(launch.getAttribute('aria-busy')).toBe('true');
  await act(async () => finish());
  expect(launch.hasAttribute('aria-disabled')).toBe(false);
  expect(document.activeElement).toBe(launch);
});

it('keeps a pending port action focused, blocks repeats, and clears feedback on failure', async () => {
  const launch = Promise.withResolvers<void>();
  props.onPort = vi.fn(() => launch.promise);
  render();
  const open = button('Open in agent-browser screencast');
  act(() => open.focus());
  await click('Open in agent-browser screencast');
  expect(open.textContent).toContain('opening…');
  expect(open.getAttribute('aria-busy')).toBe('true');
  expect(open.disabled).toBe(false);
  expect(document.activeElement).toBe(open);
  await click('Open in agent-browser screencast');
  expect(props.onPort).toHaveBeenCalledOnce();
  await act(async () => launch.reject(new Error('Launch failed')));
  expect(open.hasAttribute('aria-busy')).toBe(false);
  expect(container.querySelector('[data-context-diagnostic]')?.textContent).toBe('Launch failed');
});

it('uses labeled title, directory and port actions without a redundant heading', () => {
  render(); expect(container.querySelector('h1,h2,h3')).toBeNull();
  for (const label of ['Explain this title', 'Copy absolute path', 'Reveal in Finder', 'Open in system browser', 'Open in iframe embed', 'Open in agent-browser screencast', 'Open in agent-browser popout']) expect(button(label)).not.toBeNull();
  expect(container.querySelector('select')).toBeNull();
});
it.each(['system', 'iframe', 'agent-browser-screencast', 'agent-browser-popout'] as const)('dispatches the selected port to %s', async mode => {
  props.scan = { status: 'loaded', entries: [port(5173), port(6006), port(9229)] }; render();
  const select = container.querySelector('select')!;
  act(() => { select.value = '6006'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(select.parentElement?.textContent).toContain('3 ports');
  const label = { system: 'Open in system browser', iframe: 'Open in iframe embed', 'agent-browser-screencast': 'Open in agent-browser screencast', 'agent-browser-popout': 'Open in agent-browser popout' }[mode];
  await click(label); expect(props.onPort).toHaveBeenCalledWith(port(6006), mode); expect(props.onClose).not.toHaveBeenCalled();
});
it.each(['scanning', 'failed', 'empty'] as const)('distinguishes %s ports', state => {
  props.scan = state === 'empty' ? { status: 'loaded', entries: [] } : { status: state }; render();
  expect(container.textContent).toContain(state === 'empty' ? 'No listening ports' : state === 'failed' ? 'Port scan failed' : 'Scanning ports');
  expect(button('Open in system browser')).toBeNull();
});
it('moves trailing actions into the dropdown on resize and dispatches hidden actions', async () => {
  let width = 250;
  const observers = new Set<() => void>();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observers.add(callback); }
    observe() {} disconnect() {} unobserve() {}
  });
  const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.hasAttribute('data-port-actions') ? width : 0; });
  const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
  try {
    render();
    const dropdown = () => container.querySelector<HTMLSelectElement>('[aria-label="More browser actions"]');
    expect(button('Open in system browser')).not.toBeNull();
    expect(button('Open in agent-browser screencast')).toBeNull();
    expect([...dropdown()!.options].map(option => option.value)).toContain('agent-browser-screencast');
    const launch = Promise.withResolvers<void>();
    props.onPort = vi.fn(() => launch.promise); render();
    await act(async () => { dropdown()!.value = 'agent-browser-screencast'; dropdown()!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(props.onPort).toHaveBeenCalledWith(port(5173), 'agent-browser-screencast');
    expect(dropdown()!.getAttribute('aria-busy')).toBe('true');
    await act(async () => launch.reject(new Error('Launch failed')));
    expect(container.querySelector('[data-context-diagnostic]')?.textContent).toBe('Launch failed');
    act(() => { width = 80; observers.forEach(notify => notify()); });
    expect(button('Open in system browser')).toBeNull();
    expect(dropdown()!.options).toHaveLength(6);
    act(() => { width = 600; observers.forEach(notify => notify()); });
    expect(dropdown()).toBeNull();
    expect(button('Open in agent-browser popout')).not.toBeNull();
  } finally { client.mockRestore(); offset.mockRestore(); vi.unstubAllGlobals(); }
});

it('drops the title explanation label, then compacts the Surface id, as the header narrows', () => {
  let width = 320;
  const observers = new Set<() => void>();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observers.add(callback); }
    observe() {} disconnect() {} unobserve() {}
  });
  const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.hasAttribute('data-context-title') ? width : 0; });
  // Ten pixels a character, twenty an icon: ref 110, explanation 130 or 20 bare, close 20.
  const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function(this: HTMLElement) {
    return (this.textContent?.length ?? 0) * 10 + this.querySelectorAll('svg').length * 20;
  });
  const resize = (next: number) => act(() => { width = next; observers.forEach(notify => notify()); });
  try {
    render();
    expect(button('Explain this title').textContent).toBe('debug title');
    expect(button('Copy surface:3').textContent).toBe('surface:3');
    resize(200);
    expect(button('Explain this title').textContent).toBe('');
    expect(button('Copy surface:3').textContent).toBe('surface:3');
    resize(140);
    expect(button('Copy surface:3').textContent).toBe('');
    resize(320);
    expect(button('Explain this title').textContent).toBe('debug title');
    expect(button('Copy surface:3').textContent).toBe('surface:3');
  } finally { client.mockRestore(); offset.mockRestore(); vi.unstubAllGlobals(); }
});

it('re-fits the title row when its helper placement buttons change', () => {
  // Observers here see only the elements they observe, so an unobserved group cannot trigger a re-fit.
  const observed = new Map<Element, Set<() => void>>();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(element: Element) { observed.set(element, (observed.get(element) ?? new Set()).add(this.callback)); }
    disconnect() { for (const callbacks of observed.values()) callbacks.delete(this.callback); }
    unobserve() {}
  });
  const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.hasAttribute('data-context-title') ? 170 : 0; });
  // As above; each placement side and the close add a twenty-pixel icon to the actions group.
  const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function(this: HTMLElement) {
    return (this.textContent?.length ?? 0) * 10 + this.querySelectorAll('svg').length * 20;
  });
  try {
    props.placement = { side: 'bottom', available: ['bottom'], onChange: vi.fn() };
    render();
    expect(button('Copy surface:3').textContent).toBe('surface:3');
    props.placement = { side: 'bottom', available: ['bottom', 'top'], onChange: vi.fn() };
    render();
    const actions = container.querySelector('[data-context-header-actions]')!;
    act(() => observed.get(actions)?.forEach(notify => notify()));
    expect(button('Copy surface:3').textContent).toBe('');
  } finally { client.mockRestore(); offset.mockRestore(); vi.unstubAllGlobals(); }
});

it('drops the explorer label, and its busy text, before truncating the directory', async () => {
  let width = 400;
  const observers = new Set<() => void>();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observers.add(callback); }
    observe() {} disconnect() {} unobserve() {}
  });
  const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.hasAttribute('data-context-dir') ? width : 0; });
  const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
  const resize = (next: number) => act(() => { width = next; observers.forEach(notify => notify()); });
  try {
    render();
    expect(button('Reveal in Finder').textContent).toContain('reveal in Finder');
    resize(250);
    expect(button('Reveal in Finder').textContent).not.toContain('reveal in Finder');
    props.onExplore = vi.fn(() => new Promise<void>(() => {}));
    render();
    await click('Reveal in Finder');
    expect(button('Reveal in Finder').getAttribute('aria-busy')).toBe('true');
    expect(button('Reveal in Finder').textContent).toBe('');
    resize(400);
    expect(button('Reveal in Finder').textContent).toContain('reveal in Finder');
  } finally { client.mockRestore(); offset.mockRestore(); vi.unstubAllGlobals(); }
});

it('confirms the unlabeled path copy with the check alone, keeping its width', async () => {
  props.onCopyPath = vi.fn(async () => {});
  render();
  await click('Copy absolute path');
  const copy = button('Copy absolute path');
  expect(copy.querySelector('[role="status"] svg')).not.toBeNull();
  expect(copy.textContent).toBe('');
});

it('opens the overflow list from the keyboard rather than letting keys pick its first entry', () => {
  const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.hasAttribute('data-port-actions') ? 80 : 0; });
  const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
  try {
    render();
    const more = container.querySelector<HTMLSelectElement>('[aria-label="More browser actions"]')!;
    const showPicker = vi.fn();
    more.showPicker = showPicker;
    const cancels = (key: string) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => { more.dispatchEvent(event); });
      return event.defaultPrevented;
    };
    expect(cancels('ArrowDown')).toBe(true);
    expect(showPicker).toHaveBeenCalledTimes(1);
    expect(cancels('s')).toBe(true);
    expect(cancels('End')).toBe(true);
    expect(showPicker).toHaveBeenCalledTimes(1);
    expect(cancels(' ')).toBe(false);
    expect(cancels('Tab')).toBe(false);
  } finally { client.mockRestore(); offset.mockRestore(); }
});

it('uses one pair of automated actions and remembers the selected provider on reopening', async () => {
  render();
  expect(button('Open in playwright screencast')).toBeNull();
  act(() => button('switch to playwright').click());
  expect(button('Open in agent-browser screencast')).toBeNull();
  await click('Open in playwright screencast');
  expect(props.onPort).toHaveBeenCalledWith(port(5173), 'playwright-screencast');
  act(() => root.render(null));
  render();
  expect(button('Open in playwright popout')).not.toBeNull();
});
it('disables unsupported host capabilities with an explanation', () => {
  props.browserProviders = ['playwright']; props.canExplore = false; render();
  expect(button('Open in agent-browser popout')).toBeNull();
  expect(button('switch to agent-browser')).toBeNull();
  expect(button('Open in playwright popout').disabled).toBe(false);
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
it('keeps presses in a helper\'s portaled copy editor out of context dismissal', () => {
  props.children = <div data-helper-terminal="helper"><PortalAnchoredButton /></div>;
  render();
  const editor = document.querySelector<HTMLButtonElement>('[data-portaled]')!;
  expect(container.contains(editor)).toBe(false);
  act(() => editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  expect(props.onClose).not.toHaveBeenCalled();
  act(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  expect(props.onClose).toHaveBeenCalledOnce();
});
it('requires explicit confirmation before resetting a preserved helper', async () => {
  props.status = 'preserved'; render(); await click('Reset helper terminal'); await click('Keep helper'); expect(props.onReset).not.toHaveBeenCalled();
  await click('Reset helper terminal'); await click('Discard and reset'); expect(props.onReset).toHaveBeenCalledOnce();
});

it('resets at once, with no question, when Labs makes the old helper a pending kill', async () => {
  props.status = 'preserved'; props.resetAsks = false; render();
  await click('Reset helper terminal');
  expect(props.onReset).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain('Discard and reset');
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
it('shares header and uncaptured body entry points; captured mouse has no Shift escape', () => {
  const open = vi.fn(); const value = { id: null, mounted: null, open, close: vi.fn(), promote: vi.fn(), openPort: vi.fn() };
  act(() => root.render(<TerminalContextContext.Provider value={value}><TerminalPaneHeader id="parent" /><TerminalPanel id="parent" /></TerminalContextContext.Provider>));
  const header = container.querySelector('[data-pane-header-for]')!;
  const body = container.querySelector('textarea')!;
  const rightClick = (target: Element, shiftKey = false) => act(() => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, shiftKey, clientX: 120, clientY: 90 })));
  rightClick(header); rightClick(body);
  expect(open).toHaveBeenCalledTimes(2);
  for (const call of open.mock.calls) expect(call).toEqual(['parent', { origin: { x: 120, y: 90 } }]);
  act(() => setMouseReporting('parent', 'vt200'));
  rightClick(body); rightClick(body, true); expect(open).toHaveBeenCalledTimes(2);
  rightClick(header); expect(open).toHaveBeenCalledTimes(3);
});


it('offers the rule covering the running script, else that script\'s own key', async () => {
  const clearRules = () => act(() => { for (const name of terminalRegistry.getWatchedCommands()) terminalRegistry.setCommandWatched(name, false); });
  clearRules();
  const open = vi.spyOn(helpers, 'openHelper').mockResolvedValue({ id: 'helper', parentId: 'watch-row', command: '', status: 'off' });
  terminalRegistry.applyTerminalSemanticEvents('watch-row', [
    { type: 'commandLine', commandLine: 'cd web && pnpm run dev' },
    { type: 'commandStart', source: 'osc633_boundaries' },
  ]);
  const watchSwitch = () => container.querySelector<HTMLButtonElement>('[role="switch"][aria-label^="Watch all"]');
  try {
    act(() => terminalRegistry.setCommandWatched('pnpm', true));
    await act(async () => root.render(<TerminalContext id="watch-row" />));
    // A bare runner rule already covers `pnpm dev`, so the row names — and turns off — that rule.
    expect(watchSwitch()?.getAttribute('aria-label')).toBe('Watch all pnpm commands on');
    await act(async () => watchSwitch()!.click());
    expect(terminalRegistry.getWatchedCommands()).toEqual([]);
    expect(watchSwitch()?.getAttribute('aria-label')).toBe('Watch all pnpm dev commands off');
    await act(async () => watchSwitch()!.click());
    expect(terminalRegistry.getWatchedCommands()).toEqual(['pnpm dev']);
  } finally {
    open.mockRestore();
    clearRules();
    terminalRegistry.removeTerminalPaneState('watch-row');
  }
});

it('never offers Explore for a share or device path, however the terminal reported it', async () => {
  const open = vi.spyOn(helpers, 'openHelper').mockResolvedValue({ id: 'helper', parentId: 'unc-row', command: '', status: 'off' });
  const unavailable = () => container.querySelector('[aria-label="Directory unavailable on this host"]');
  try {
    for (const [cwd, explorable] of [
      [cwdFromOsc7('file:///home/me/repo'), true],
      [cwdFromOsc7('file:////host/share/repo'), false],
      [cwdFromOsc9_9('\\\\host\\share'), false],
      [cwdFromOsc633('/\\host\\share'), false],
      [cwdFromOsc9_9('\\\\?\\C:\\repo'), false],
    ] as const) {
      terminalRegistry.applyTerminalSemanticEvents('unc-row', [{ type: 'cwd', cwd: cwd! }]);
      await act(async () => root.render(<TerminalContext id="unc-row" />));
      expect(unavailable() === null, cwd!.path).toBe(explorable);
    }
  } finally {
    open.mockRestore();
    terminalRegistry.removeTerminalPaneState('unc-row');
  }
});

it('shows a running Tool command that spans lines on one', () => {
  props = { ...props, terminalRole: 'tool', status: 'running', command: 'cd web\npnpm dev' };
  render();
  expect(container.querySelector('[title^="Running "]')?.getAttribute('title')).toBe('Running cd web pnpm dev…');
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

it('offers Keep open only for a preview slot, as a focusable button that keeps focus in the context', async () => {
  props = { ...props, terminalRole: 'tool', status: 'running', command: 'view a.md' };
  render();
  expect(button('Keep open')).toBeNull();
  props.onKeepPreview = vi.fn();
  render();
  const keep = button('Keep open');
  expect(keep.textContent).toBe('Keep open');
  expect(keep.disabled).toBe(false);
  expect(keep.tabIndex).toBe(0);
  act(() => keep.focus());
  expect(document.activeElement).toBe(keep);
  await click('Keep open');
  expect(props.onKeepPreview).toHaveBeenCalledOnce();
  // The action leaves with the mark; Escape still closes from the context.
  props.onKeepPreview = undefined;
  render();
  expect(button('Keep open')).toBeNull();
  expect(document.activeElement?.hasAttribute('data-terminal-context')).toBe(true);
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(props.onClose).toHaveBeenCalledOnce();
});

it('cuts 90° teeth corner to corner along the edge facing the source', () => {
  expect(teethCount(200)).toBe(200 / (2 * TERMINAL_CONTEXT_TEETH_PX));
  const { clip, path, viewBox } = contextTeeth('left', 4);
  // In a strip one tooth deep and one unit per tooth: valleys at the depth, tips at the edge, half a tooth apart.
  expect(viewBox).toBe(`0 0 ${TERMINAL_CONTEXT_TEETH_PX} 4`);
  const D = TERMINAL_CONTEXT_TEETH_PX;
  expect(path).toBe(`M${D},0 L0,0.5 L${D},1 L0,1.5 L${D},2 L0,2.5 L${D},3 L0,3.5 L${D},4`);
  // The clip keeps the halo past the other three sides, never past the tips.
  expect(clip).toContain('calc(100% + 16px) calc(0% - 16px)');
  expect(clip).toContain('0px 87.5%');
  expect(clip).not.toMatch(/(^|[(,]\s*)-\d/);
  expect(contextTeeth('bottom', 1).path).toBe(`M0,0 L0.5,${D} L1,0`);
  expect(contextTeeth('bottom', 1).clip).toContain(`50% calc(100% - 0px)`);
});

it('faces its teeth toward the source and carries the terminal ground into them', () => {
  props.placement = { side: 'right', available: ['right'], onChange: vi.fn() };
  render();
  const context = container.querySelector<HTMLElement>('[data-terminal-context]')!;
  expect(context.dataset.contextTeeth).toBe('left');
  const ground = container.querySelector<HTMLElement>('[aria-label="Helper terminal status"]')!.parentElement!;
  expect(ground.style.borderLeft).toBe(`${TERMINAL_CONTEXT_TEETH_PX}px solid transparent`);
  expect(ground.style.borderRight).toBe('');
  props.placement = undefined;
  render();
  expect(context.dataset.contextTeeth).toBeUndefined();
  expect(ground.style.borderLeft).toBe('');
});

it('always shows context details alongside the helper', () => {
  render();
  expect(button('Terminal context details')).toBeNull();
  expect(button('Open in system browser')).not.toBeNull();
  expect(button('Explain this title')).not.toBeNull();
  expect(button('Copy absolute path')).not.toBeNull();
  expect(container.querySelector('[role="switch"][aria-label^="TODO"]')).not.toBeNull();
  expect(container.querySelector('textarea')).not.toBeNull();
});

it('position buttons preserve input focus and report the destination', async () => {
  props.placement = { side: 'top', available: ['top', 'bottom'], onChange: vi.fn() };
  render();
  const input = container.querySelector('textarea')!;
  act(() => input.focus());
  const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
  act(() => button('Place helper at bottom').dispatchEvent(down));
  expect(down.defaultPrevented).toBe(true);
  await click('Place helper at bottom');
  expect(props.placement.onChange).toHaveBeenCalledWith('bottom');
  expect(button('Use automatic helper placement')).toBeNull();
  expect(button('Place helper at top').getAttribute('aria-pressed')).toBe('true');
  expect(document.activeElement).toBe(input);
});


it.each(['composing', 'WebKit ending'])('leaves detail Escape and Tab to the IME (%s)', async phase => {
  render();
  await click('Modify autorun command');
  const input = container.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  act(() => input.focus());
  for (const key of ['Tab', 'Escape']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: phase === 'composing' });
    if (phase === 'WebKit ending') Object.defineProperty(event, 'keyCode', { value: 229 });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  }
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('pauses its helper while its Workspace is out of view, and resumes when it returns', async () => {
  const open = vi.spyOn(helpers, 'openHelper').mockResolvedValue({ id: 'helper', parentId: 'hidden-source', command: '', status: 'off' });
  const visible = vi.spyOn(helpers, 'setHelperVisible');
  const show = (active: boolean) => act(async () => root.render(<WorkspaceActiveContext.Provider value={active}><TerminalContext id="hidden-source" /></WorkspaceActiveContext.Provider>));
  try {
    await show(true);
    expect(visible.mock.calls.at(-1)).toEqual(['hidden-source', true]);
    await show(false);
    expect(visible.mock.calls.at(-1)).toEqual(['hidden-source', false]);
    await show(true);
    expect(visible.mock.calls.at(-1)).toEqual(['hidden-source', true]);
  } finally {
    await act(async () => root.render(<></>));
    open.mockRestore();
    visible.mockRestore();
  }
});

