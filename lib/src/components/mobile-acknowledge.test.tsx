/**
 * @vitest-environment jsdom
 *
 * The mobile composition as Pocket and the website playground ship it —
 * `MobileTerminalUi` around `MobileWall` around the real `TerminalPane` and its
 * xterm mouse router — so a touch meets every capture handler a real one
 * does (`docs/specs/alert.md` -> Engagement).
 */
import { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileTerminalUi, type MobileTerminalTouchMode } from './MobileTerminalUi';
import { MobileWall, useMobileWallSessionItems } from './MobileWall';
import { FakePtyAdapter, setPlatform } from '../lib/platform';
import { clearTerminalActivity, disposeAllSessions, getActivity, initAlertStateReceiver } from '../lib/terminal-registry';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no canvas to measure glyphs with, so only the xterm engine is a
// stand-in; the registry, `TerminalPane`, and the mouse router's capture
// listeners on the Session's element are the real ones.
vi.mock('@xterm/xterm', () => {
  class Terminal {
    element: HTMLElement | undefined;
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    modes = { mouseTrackingMode: 'none', bracketedPasteMode: false };
    parser = { registerCsiHandler: () => ({ dispose() {} }) };
    buffer = { active: { getLine: () => undefined, baseY: 0, cursorY: 0, cursorX: 0, viewportY: 0 } };
    private dataListeners = new Set<(data: string) => void>();
    loadAddon(): void {}
    open(host: HTMLElement): void {
      this.element = document.createElement('div');
      this.element.className = 'xterm';
      host.appendChild(this.element);
    }
    write(_data: string, callback?: () => void): void { callback?.(); }
    onData(listener: (data: string) => void) {
      this.dataListeners.add(listener);
      return { dispose: () => this.dataListeners.delete(listener) };
    }
    onResize() { return { dispose() {} }; }
    onRender() { return { dispose() {} }; }
    attachCustomKeyEventHandler(): void {}
    focus(): void {}
    blur(): void {}
    clearSelection(): void {}
    dispose(): void {}
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 }; } },
}));
vi.mock('@xterm/addon-image', () => ({ ImageAddon: class {} }));
vi.mock('@xterm/addon-unicode-graphemes', () => ({ UnicodeGraphemesAddon: class {} }));

const PANE = 'pane-a';
const SESSIONS = [{ id: PANE, title: 'remote shell' }];

let platform: FakePtyAdapter;
let container: HTMLDivElement;
let root: Root;

function touchDown(): PointerEvent {
  const event = new Event('pointerdown', { bubbles: true, cancelable: true }) as PointerEvent;
  const values: Partial<PointerEvent> = {
    pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1,
    clientX: 10, clientY: 12, screenX: 110, screenY: 112,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, get: () => value });
  }
  return event;
}

function Composition({ touchMode }: { touchMode: MobileTerminalTouchMode }) {
  const [active, setActive] = useState(PANE);
  const sessions = useMobileWallSessionItems(SESSIONS, active);
  return (
    <MobileTerminalUi
      interactive
      activeTouchMode={touchMode}
      activeKeyboardMode="type"
      cursorTouchAvailable
      sessions={sessions}
      onSendInput={(data) => platform.writePty(active, data)}
      terminal={<MobileWall sessions={SESSIONS} activeSessionId={active} onActiveSessionChange={setActive} showKillButton={false} />}
    />
  );
}

function render(touchMode: MobileTerminalTouchMode): void {
  act(() => {
    root.render(<StrictMode><Composition touchMode={touchMode} /></StrictMode>);
  });
}

/** Ring the pane: a bell from the program. */
function ring(): void {
  act(() => platform.sendOutput(PANE, '\x07'));
  expect(getActivity(PANE)).toMatchObject({ status: 'ALERT_RINGING', todo: true });
}

beforeEach(() => {
  platform = new FakePtyAdapter();
  platform.setDefaultScenario({ name: 'none', chunks: [] });
  setPlatform(platform);
  initAlertStateReceiver();
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => document.body) });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: vi.fn(() => null) });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  disposeAllSessions();
  clearTerminalActivity();
  delete (document as Document & { elementFromPoint?: unknown }).elementFromPoint;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mobile acknowledge', () => {
  it.each<MobileTerminalTouchMode>(['gestures', 'selection', 'cursor'])(
    'a tap on the terminal puts out a ring and keeps its TODO in %s mode',
    (mode) => {
      render(mode);
      ring();
      const screen = container.querySelector('.xterm');
      expect(screen).not.toBeNull();
      act(() => { screen!.dispatchEvent(touchDown()); });
      expect(getActivity(PANE)).toMatchObject({ status: 'WATCHING_DISABLED', todo: true });
    },
  );

  it('a keystroke from the input bar acknowledges with input, clearing the TODO', () => {
    render('gestures');
    ring();
    const bar = container.querySelector<HTMLTextAreaElement>('textarea[data-mobile-terminal-input], textarea');
    expect(bar).not.toBeNull();
    act(() => {
      bar!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(getActivity(PANE)).toMatchObject({ status: 'WATCHING_DISABLED', todo: false });
  });
});
