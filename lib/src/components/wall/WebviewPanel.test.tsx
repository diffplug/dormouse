/**
 * @vitest-environment jsdom
 */
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import { focusSession } from '../../lib/terminal-registry';
import { useOccludePaneWebviews } from '../../lib/pane-webview-occlusion';
import { isRealBlur } from '../../lib/window-focus';
import { setNativeFieldValue } from '../../lib/dom';
import { BrowserPanel } from './BrowserPanel';
import { browserDisplayModeFromParams } from './browser-surface';
import { getAgentBrowserScreenController } from './agent-browser-screen';
import { closeBrowserSurface } from './agent-browser-surface-controller';
import { LayoutFramesContext, PaneWriteContext, PassthroughPaneIdContext, WallActionsContext, WorkspaceActiveContext, type PaneWriteActions, type WallActions } from './wall-context';
import { installPaneWebview, stubWallActions } from './wall-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ID = 'surface:web';
const URL = 'https://example.com/';
const RECT = { x: 10, y: 40, width: 300, height: 200 };

let container: HTMLDivElement;
let root: Root;
let platform: FakePtyAdapter;
let pane: ReturnType<typeof installPaneWebview>;
let observers: Set<() => void>;
let layoutFrames: Set<(settled: boolean) => void>;
const subscribeLayoutFrames = (listener: (settled: boolean) => void) => {
  layoutFrames.add(listener);
  return () => layoutFrames.delete(listener);
};
let rect: typeof RECT;
let paneWrite: { updateParams: Mock<PaneWriteActions['updateParams']>; setTitle: Mock<PaneWriteActions['setTitle']> };

beforeEach(() => {
  platform = new FakePtyAdapter();
  setPlatform(platform);
  pane = installPaneWebview(platform);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  observers = new Set();
  layoutFrames = new Set();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe() { observers.add(this.callback); }
    disconnect() { observers.delete(this.callback); }
  });
  rect = RECT;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => ({}) }));
  paneWrite = { updateParams: vi.fn<PaneWriteActions['updateParams']>(), setTitle: vi.fn<PaneWriteActions['setTitle']>() };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The pane may have moved: what a resize of it reports. */
function moved(): void {
  for (const callback of [...observers]) callback();
}

function Occluder() {
  useOccludePaneWebviews(true);
  return null;
}

interface Shown {
  params?: Record<string, unknown>;
  parked?: boolean;
  active?: boolean;
  /** The pane in passthrough, if any. */
  passthrough?: string | null;
  actions?: WallActions;
  extra?: ReactNode;
}

async function show({ params = { surfaceType: 'browser', renderMode: 'webview', url: URL }, parked, active = true, passthrough = null, actions = stubWallActions(), extra }: Shown = {}): Promise<void> {
  await act(async () => {
    root.render(
      <StrictMode>
        <WorkspaceActiveContext.Provider value={active}>
          <PassthroughPaneIdContext.Provider value={passthrough}>
            <PaneWriteContext.Provider value={paneWrite}>
              <WallActionsContext.Provider value={actions}>
                <LayoutFramesContext.Provider value={subscribeLayoutFrames}>
                  <BrowserPanel id={ID} title="example.com" params={params} parked={parked} />
                </LayoutFramesContext.Provider>
                {extra}
              </WallActionsContext.Provider>
            </PaneWriteContext.Provider>
          </PassthroughPaneIdContext.Provider>
        </WorkspaceActiveContext.Provider>
      </StrictMode>,
    );
  });
}

const lastPlace = () => pane.of('place').at(-1);
const dialogEvent = (dialog: 'alert' | 'confirm' | 'prompt', text?: string) =>
  ({ id: ID, kind: 'dialog' as const, dialog, message: '<b>Sure?</b>', origin: 'example.com', text });
const prompt = () => container.querySelector('[role="alertdialog"]');
const key = (target: Element, key: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });

describe('WebviewPanel', () => {
  it('renders a webview Surface with the iframe renderer on a host without pane webviews, keeping its mode', async () => {
    await show();
    expect(container.querySelector('iframe')).toBeNull();
    // StrictMode mounts twice: the second open adopts the first's view.
    expect(new Set(pane.of('open').map((call) => call.join()))).toEqual(new Set([['open', ID, URL].join()]));

    act(() => root.unmount());
    root = createRoot(container);
    delete platform.paneWebview;
    await show();
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(URL);
    expect(paneWrite.updateParams.mock.calls.some(([, patch]) => 'renderMode' in patch)).toBe(false);
    // Its Door says what the pane shows, not what is stored.
    const stored = { surfaceType: 'browser', renderMode: 'webview', url: URL };
    expect(browserDisplayModeFromParams(stored)).toBe(browserDisplayModeFromParams({ ...stored, renderMode: 'iframe' }));
    installPaneWebview(platform);
    expect(browserDisplayModeFromParams(stored)).not.toBe(browserDisplayModeFromParams({ ...stored, renderMode: 'iframe' }));
  });

  it('opens or adopts the view on mount, hides it on unmount, and destroys it only through closeBrowserSurface', async () => {
    await show();
    moved();
    expect(lastPlace()).toEqual(['place', ID, RECT]);

    act(() => root.unmount());
    root = createRoot(container);
    expect(lastPlace()).toEqual(['place', ID, null]);
    expect(pane.of('close')).toEqual([]);

    await closeBrowserSurface(ID, { surfaceType: 'browser', renderMode: 'iframe', url: URL });
    expect(pane.of('close')).toEqual([]);
    await closeBrowserSurface(ID, { surfaceType: 'browser', renderMode: 'webview', url: URL });
    expect(pane.of('close')).toEqual([['close', ID]]);
  });

  it('places the view on its pane\'s rect as it moves, only while in sight and no overlay is open', async () => {
    await show();
    moved();
    expect(lastPlace()).toEqual(['place', ID, RECT]);
    const placed = pane.of('place').length;
    moved();
    expect(pane.of('place')).toHaveLength(placed);
    rect = { ...RECT, x: 50 };
    moved();
    expect(lastPlace()).toEqual(['place', ID, { ...RECT, x: 50 }]);

    // A layout animation moves a pane without resizing it.
    rect = { ...RECT, x: 60 };
    for (const listener of [...layoutFrames]) listener(false);
    expect(lastPlace()).toEqual(['place', ID, { ...RECT, x: 60 }]);
    rect = { ...RECT, x: 50 };
    moved();

    await show({ extra: <Occluder /> });
    expect(lastPlace()).toEqual(['place', ID, null]);
    await show();
    expect(lastPlace()).toEqual(['place', ID, { ...RECT, x: 50 }]);

    await show({ parked: true });
    expect(lastPlace()).toEqual(['place', ID, null]);
    await show();
    await show({ active: false });
    expect(lastPlace()).toEqual(['place', ID, null]);
  });

  it('shows the page the host reports in the chrome and title, and persists every http(s) URL it commits', async () => {
    await show();
    act(() => pane.emit({ id: ID, kind: 'page', url: 'https://example.com/next', title: 'Next', canGoBack: true, canGoForward: false, loading: false }));
    expect(getAgentBrowserScreenController(ID)?.chrome()).toMatchObject({ url: 'https://example.com/next', title: 'Next' });
    expect(paneWrite.setTitle).toHaveBeenLastCalledWith(ID, 'Next');
    expect(paneWrite.updateParams).toHaveBeenLastCalledWith(ID, { url: 'https://example.com/next' });

    paneWrite.updateParams.mockClear();
    act(() => pane.emit({ id: ID, kind: 'page', url: 'about:blank', title: '', canGoBack: true, canGoForward: false, loading: false }));
    act(() => pane.emit({ id: 'surface:other', kind: 'page', url: 'https://other.test/', title: 'Other', canGoBack: false, canGoForward: false, loading: false }));
    expect(paneWrite.updateParams).not.toHaveBeenCalled();
    expect(getAgentBrowserScreenController(ID)?.chrome().url).toBe('about:blank');
  });

  it('enters its pane on a press and leaves passthrough on the leader, for its own view only', async () => {
    const actions = stubWallActions();
    await show({ actions });
    act(() => pane.emit({ id: 'surface:other', kind: 'pointerdown' }));
    act(() => pane.emit({ id: 'surface:other', kind: 'leader' }));
    expect(actions.onClickPanel).not.toHaveBeenCalled();
    expect(actions.onFrameLeader).not.toHaveBeenCalled();

    act(() => pane.emit({ id: ID, kind: 'pointerdown' }));
    expect(actions.onClickPanel).toHaveBeenCalledExactlyOnceWith(ID);
    act(() => pane.emit({ id: ID, kind: 'leader' }));
    expect(actions.onFrameLeader).toHaveBeenCalledOnce();
  });

  it('asks before opening a new-window target as a new pane, hiding the view while it asks', async () => {
    const onOpenBrowserPane = vi.fn();
    await show({ actions: stubWallActions({ onOpenBrowserPane }) });
    moved();
    act(() => pane.emit({ id: ID, kind: 'open-window', url: 'javascript:alert(1)' }));
    expect(container.textContent).not.toContain('wants to open a new tab');

    act(() => pane.emit({ id: ID, kind: 'open-window', url: 'https://example.com/popup' }));
    expect(container.textContent).toContain('wants to open a new tab');
    expect(lastPlace()).toEqual(['place', ID, null]);
    const open = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Open in new pane')!;
    act(() => open.click());
    expect(onOpenBrowserPane).toHaveBeenCalledExactlyOnceWith(ID, 'https://example.com/popup');
  });

  it('raises a new-window prompt only from a page on screen, and shows it only while its pane is in sight', async () => {
    // Its prompt hides every pane webview, which a page nobody can see must not do.
    await show({ parked: true });
    moved();
    act(() => pane.emit({ id: ID, kind: 'open-window', url: 'https://example.com/popup' }));
    await show();
    expect(container.textContent).not.toContain('wants to open a new tab');

    moved();
    act(() => pane.emit({ id: ID, kind: 'open-window', url: 'https://example.com/popup' }));
    expect(container.textContent).toContain('wants to open a new tab');
    await show({ parked: true });
    expect(container.textContent).not.toContain('wants to open a new tab');
    await show();
    expect(container.textContent).toContain('wants to open a new tab');
  });

  it('asks a page\'s dialog in its pane as the page\'s plain text, hiding the view, and answers what the user chose', async () => {
    await show({ passthrough: ID });
    moved();
    const button = (label: string) => [...prompt()!.querySelectorAll('button')].find((b) => b.textContent === label);
    act(() => pane.emit(dialogEvent('confirm')));
    expect(prompt()!.textContent).toContain('example.com says:<b>Sure?</b>');
    expect(prompt()!.querySelector('b')).toBeNull();
    expect(lastPlace()).toEqual(['place', ID, null]);
    // Focus parked on the placeholder, by the keyboard's return or a press on
    // the backdrop, belongs in the prompt.
    act(() => prompt()!.parentElement!.focus());
    expect(document.activeElement).toBe(button('OK'));
    // Enter on a focused Cancel is that button's, never an OK.
    key(button('Cancel')!, 'Enter');
    expect(pane.of('answer')).toEqual([]);
    act(() => button('Cancel')!.click());
    expect(pane.of('answer')).toEqual([['answer', ID, false, undefined]]);
    expect(prompt()).toBeNull();
    expect(lastPlace()).toEqual(['place', ID, RECT]);

    act(() => pane.emit(dialogEvent('prompt', 'default')));
    const input = prompt()!.querySelector('input')!;
    expect(input.value).toBe('default');
    expect(document.activeElement).toBe(input);
    act(() => setNativeFieldValue(input, 'typed'));
    key(input, 'Enter');
    expect(pane.of('answer').at(-1)).toEqual(['answer', ID, true, 'typed']);

    act(() => pane.emit(dialogEvent('alert')));
    expect(button('Cancel')).toBeUndefined();
    key(document.activeElement!, 'Escape');
    expect(pane.of('answer').at(-1)).toEqual(['answer', ID, false, undefined]);
    expect(prompt()).toBeNull();
  });

  it.each([
    ['crashed', 'The page crashed.'],
    ['closed', 'The page closed itself.'],
  ] as const)('closes a view whose page %s, says so, and opens a new one on Reload', async (kind, copy) => {
    await show();
    act(() => pane.emit({ id: ID, kind }));
    expect(pane.of('close')).toEqual([['close', ID]]);
    expect(container.textContent).toContain(copy);
    const opens = pane.of('open').length;
    await act(async () => getAgentBrowserScreenController(ID)!.chromeActions.reload());
    expect(pane.of('open')).toHaveLength(opens + 1);
  });

  it('says so when the host refuses a page\'s download, only for a page on screen', async () => {
    await show({ parked: true });
    act(() => pane.emit({ id: ID, kind: 'download-refused' }));
    await show();
    expect(prompt()).toBeNull();

    moved();
    act(() => pane.emit({ id: ID, kind: 'download-refused' }));
    expect(prompt()!.textContent).toContain('tried to download a file');
    expect(lastPlace()).toEqual(['place', ID, null]);
    act(() => prompt()!.querySelector('button')!.click());
    expect(prompt()).toBeNull();
    expect(pane.of('answer')).toEqual([]);
  });

  it('answers no at once to a dialog from a page off screen, and takes no keyboard from another pane', async () => {
    await show({ parked: true });
    act(() => pane.emit(dialogEvent('confirm')));
    expect(pane.of('answer')).toEqual([['answer', ID, false, undefined]]);
    await show();
    expect(prompt()).toBeNull();

    act(() => pane.emit(dialogEvent('prompt')));
    expect(prompt()).not.toBeNull();
    expect(document.activeElement).not.toBe(prompt()!.querySelector('input'));
    // Still asked, but shown only while its pane is in sight.
    await show({ parked: true });
    expect(prompt()).toBeNull();
    await show();
    expect(prompt()).not.toBeNull();
    expect(pane.of('answer')).toHaveLength(1);
  });

  it('answers a pending dialog no before the header navigates, and when the panel unmounts or its view closes', async () => {
    await show();
    const ask = () => act(() => pane.emit(dialogEvent('confirm')));
    const chrome = () => getAgentBrowserScreenController(ID)!.chromeActions;
    const answered = () => pane.calls.filter(([verb]) => verb === 'answer' || verb === 'navigate' || verb === 'history' || verb === 'close');
    for (const leave of [() => chrome().navigate('https://example.com/typed'), () => chrome().back(), () => chrome().forward(), () => chrome().reload()]) {
      ask();
      act(leave);
    }
    expect(answered()).toEqual([
      ['answer', ID, false, undefined], ['navigate', ID, 'https://example.com/typed'],
      ['answer', ID, false, undefined], ['history', ID, 'back'],
      ['answer', ID, false, undefined], ['history', ID, 'forward'],
      ['answer', ID, false, undefined], ['history', ID, 'reload'],
    ]);

    ask();
    act(() => root.unmount());
    root = createRoot(container);
    expect(answered().at(-1)).toEqual(['answer', ID, false, undefined]);

    await show();
    ask();
    act(() => pane.emit({ id: ID, kind: 'page', url: '', title: '', canGoBack: false, canGoForward: false, loading: false }));
    expect(answered().slice(-2)).toEqual([['answer', ID, false, undefined], ['close', ID]]);
    expect(prompt()).toBeNull();
  });

  it('drives the view from the header', async () => {
    const onSwapRenderMode = vi.fn();
    await show({ actions: stubWallActions({ onSwapRenderMode }) });
    const screen = getAgentBrowserScreenController(ID)!;
    expect(screen.snapshot().renderMode).toBe('webview');
    screen.chromeActions.navigate('https://example.com/typed');
    screen.chromeActions.back();
    screen.chromeActions.reload();
    expect(pane.calls.filter(([verb]) => verb !== 'open' && verb !== 'place')).toEqual([
      ['navigate', ID, 'https://example.com/typed'],
      ['history', ID, 'back'],
      ['history', ID, 'reload'],
    ]);

    screen.actions.setRenderMode?.('webview');
    screen.actions.setRenderMode?.('iframe');
    expect(onSwapRenderMode).toHaveBeenCalledExactlyOnceWith(ID, 'iframe');
  });

  it('gives its view the keyboard only while its pane is the one in passthrough', async () => {
    // The keyboard calls in order, each naming this pane.
    const keyboard = () => pane.calls.filter(([verb]) => verb === 'focus' || verb === 'blur');
    await show();
    expect(keyboard()).toEqual([]);
    // A focus the Wall deferred from before this pane lost passthrough.
    focusSession(ID, true);
    expect(keyboard()).toEqual([]);

    await show({ passthrough: ID });
    expect(keyboard().at(-1)).toEqual(['focus', ID]);
    const taken = keyboard().length;
    focusSession(ID, true);
    expect(keyboard().slice(taken)).toEqual([['focus', ID]]);

    // Passthrough moved to another pane with no press in the app webview.
    await show({ passthrough: 'surface:other' });
    expect(keyboard().at(-1)).toEqual(['blur', ID]);
    await show({ passthrough: ID, extra: <Occluder /> });
    expect(keyboard().at(-1)).toEqual(['blur', ID]);
    const released = keyboard().length;
    focusSession(ID, false);
    expect(keyboard().slice(released)).toEqual([['blur', ID]]);
  });

  it('closes a view whose first load failed, and says so', async () => {
    await show();
    act(() => pane.emit({ id: ID, kind: 'page', url: '', title: '', canGoBack: false, canGoForward: false, loading: true }));
    expect(pane.of('close')).toEqual([]);
    act(() => pane.emit({ id: ID, kind: 'page', url: '', title: '', canGoBack: false, canGoForward: false, loading: false }));
    expect(pane.of('close')).toEqual([['close', ID]]);
    expect(container.textContent).toContain('Couldn’t open the page — it did not load.');
    expect(getAgentBrowserScreenController(ID)!.chrome().url).toBe(URL);
  });

  it('closes a view whose load failed before its open was answered', async () => {
    let answer!: (result: Awaited<ReturnType<typeof pane.host.open>>) => void;
    vi.mocked(pane.host.open).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await show();
    act(() => pane.emit({ id: ID, kind: 'page', url: '', title: '', canGoBack: false, canGoForward: false, loading: false }));
    expect(pane.of('close')).toEqual([]);
    await act(async () => answer({ ok: true, page: { url: URL, title: '', canGoBack: false, canGoForward: false, loading: true } }));
    expect(pane.of('close')).toEqual([['close', ID]]);
    expect(container.textContent).toContain('it did not load');
  });

  it('retakes the still once its pane has stopped moving, since the page lays out for its size', async () => {
    vi.useFakeTimers();
    try {
      await show();
      moved();
      await act(async () => { vi.advanceTimersByTime(1000); });
      const before = pane.of('snapshot').length;
      rect = { ...RECT, width: 500 };
      moved();
      await act(async () => { vi.advanceTimersByTime(100); });
      rect = { ...RECT, width: 520 };
      moved();
      await act(async () => { vi.advanceTimersByTime(250); });
      expect(pane.of('snapshot').length).toBe(before);
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(pane.of('snapshot').length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes a still when a page finishes loading, so a pane nobody touched has one to hide behind', async () => {
    await show();
    moved();
    const before = pane.of('snapshot').length;
    act(() => pane.emit({ id: ID, kind: 'page', url: URL, title: 'Loading', canGoBack: false, canGoForward: false, loading: true }));
    expect(pane.of('snapshot').length).toBe(before);
    act(() => pane.emit({ id: ID, kind: 'page', url: URL, title: 'Loaded', canGoBack: false, canGoForward: false, loading: false }));
    expect(pane.of('snapshot').length).toBe(before + 1);
  });

  it('opens the view where a URL-bar entry names, when it had none', async () => {
    await show({ params: { surfaceType: 'browser', renderMode: 'webview' } });
    expect(container.textContent).toContain('No URL was provided.');
    getAgentBrowserScreenController(ID)!.chromeActions.navigate(URL);
    expect(paneWrite.updateParams).toHaveBeenCalledWith(ID, { url: URL });
    expect(pane.of('navigate')).toEqual([]);
  });

  it('takes a URL-bar entry made while the view is still opening once it has opened', async () => {
    let opened = (_: { ok: true; page: { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean } }) => {};
    vi.mocked(pane.host.open).mockImplementation(() => new Promise((resolve) => { opened = resolve; }));
    await show();
    getAgentBrowserScreenController(ID)!.chromeActions.navigate('https://example.com/typed');
    expect(pane.of('navigate')).toEqual([]);
    await act(async () => { opened({ ok: true, page: { url: URL, title: '', canGoBack: false, canGoForward: false, loading: false } }); });
    expect(pane.of('navigate')).toEqual([['navigate', ID, 'https://example.com/typed']]);
  });

  it('opens no view for a URL that is not http(s), and says why an open failed', async () => {
    await show({ params: { surfaceType: 'browser', renderMode: 'webview', url: 'javascript:alert(1)' } });
    expect(container.textContent).toContain('http:// and https:// pages only');
    expect(pane.of('open')).toEqual([]);

    vi.mocked(pane.host.open).mockResolvedValue({ ok: false, error: 'no window' });
    await show();
    expect(container.textContent).toContain('Couldn’t open the page — no window.');
    moved();
    expect(pane.of('place')).toEqual([]);
  });

  describe('the still that stands in for a hidden view', () => {
    const still = () => container.querySelector('canvas');
    // A decoded still is as wide as its JPEG's bytes, so its canvas names it.
    beforeEach(() => {
      vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) => ({ width: blob.size, height: 1, close: vi.fn() })));
      return () => vi.unstubAllGlobals();
    });
    const page = (url: string) => ({ id: ID, kind: 'page' as const, url, title: '', canGoBack: false, canGoForward: false, loading: false });
    /** A snapshot answer the test releases. */
    function deferSnapshot(): (image: string | null) => Promise<void> {
      let answer = (_: string | null) => {};
      vi.mocked(pane.host.snapshot).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
      return async (image) => { await act(async () => answer(image)); };
    }

    it('shows the latest snapshot while the view is hidden, never while it is shown', async () => {
      await show();
      moved();
      await act(async () => pane.emit({ id: ID, kind: 'pointerleave' }));
      expect(pane.of('snapshot')).toEqual([['snapshot', ID]]);
      expect(still()).toBeNull();

      await show({ extra: <Occluder /> });
      expect(createImageBitmap).toHaveBeenCalledOnce();
      expect(still()?.getAttribute('aria-hidden')).toBe('true');
      expect(still()?.className).toContain('pointer-events-none');

      await show();
      expect(lastPlace()).toEqual(['place', ID, RECT]);
      expect(still()).toBeNull();
    });

    it('hides the view at once, without waiting for a snapshot', async () => {
      const answer = deferSnapshot();
      await show();
      moved();
      act(() => pane.emit({ id: ID, kind: 'focus', focused: false }));
      expect(pane.host.snapshot).toHaveBeenCalledExactlyOnceWith(ID);

      await show({ extra: <Occluder /> });
      expect(lastPlace()).toEqual(['place', ID, null]);
      expect(still()).toBeNull();
      await answer(`data:image/jpeg;base64,${btoa('late')}`);
      expect(still()?.width).toBe('late'.length);
    });

    it('snapshots as the pointer leaves the view or the view loses the keyboard, only while it is shown', async () => {
      await show({ extra: <Occluder /> });
      act(() => pane.emit({ id: ID, kind: 'pointerleave' }));
      act(() => pane.emit({ id: ID, kind: 'focus', focused: false }));
      expect(pane.of('snapshot')).toEqual([]);

      await show();
      moved();
      act(() => pane.emit({ id: 'surface:other', kind: 'pointerleave' }));
      act(() => pane.emit({ id: ID, kind: 'focus', focused: true }));
      expect(pane.of('snapshot')).toEqual([]);
      await act(async () => pane.emit({ id: ID, kind: 'pointerleave' }));
      expect(pane.of('snapshot')).toHaveLength(1);
      await act(async () => pane.emit({ id: ID, kind: 'focus', focused: false }));
      expect(pane.of('snapshot')).toHaveLength(2);
    });

    it('drops the still when the page moves to another URL, even one snapshotted before it moved', async () => {
      await show();
      moved();
      await act(async () => pane.emit({ id: ID, kind: 'pointerleave' }));
      await show({ extra: <Occluder /> });
      act(() => pane.emit({ ...page(URL), title: 'Retitled' }));
      expect(still()).not.toBeNull();
      act(() => pane.emit(page('https://example.com/next')));
      expect(still()).toBeNull();

      const answer = deferSnapshot();
      await show();
      act(() => pane.emit({ id: ID, kind: 'pointerleave' }));
      // Still loading, so the new page asks for no still of its own yet.
      act(() => pane.emit({ ...page('https://example.com/later'), loading: true }));
      await answer(`data:image/jpeg;base64,${btoa('next')}`);
      await show({ extra: <Occluder /> });
      expect(still()).toBeNull();
    });

    it('drops the still when the view closes', async () => {
      await show();
      moved();
      await act(async () => pane.emit({ id: ID, kind: 'pointerleave' }));
      act(() => pane.emit({ ...page(''), loading: false }));
      expect(pane.of('close')).toEqual([['close', ID]]);
      await act(async () => getAgentBrowserScreenController(ID)!.chromeActions.reload());
      await show({ extra: <Occluder /> });
      expect(container.textContent).not.toContain('Couldn’t open');
      expect(still()).toBeNull();
    });
  });

  it('is no real blur while its view holds the keyboard, until that ends or the panel goes', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await show();
    act(() => pane.emit({ id: ID, kind: 'focus', focused: true }));
    expect(isRealBlur()).toBe(false);
    act(() => pane.emit({ id: ID, kind: 'focus', focused: false }));
    expect(isRealBlur()).toBe(true);

    act(() => pane.emit({ id: ID, kind: 'focus', focused: true }));
    act(() => root.unmount());
    root = createRoot(container);
    expect(isRealBlur()).toBe(true);
  });
});
