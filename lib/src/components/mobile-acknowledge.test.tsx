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
import { clearTerminalActivity, disposeAllSessions, getActivity, initAlertStateReceiver, writeUserInput } from '../lib/terminal-registry';
import { ensureResizeObserver, pointerEvent } from './wall/wall-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no canvas to measure glyphs with, so only the xterm engine is a
// stand-in; the registry, `TerminalPane`, and the mouse router's capture
// listeners on the Session's element are the real ones.
vi.mock('@xterm/xterm', () => import('../lib/xterm-test-mock'));
vi.mock('@xterm/addon-fit', () => import('../lib/xterm-test-mock'));
vi.mock('@xterm/addon-image', () => import('../lib/xterm-test-mock'));
vi.mock('@xterm/addon-unicode-graphemes', () => import('../lib/xterm-test-mock'));

const PANE = 'pane-a';
const SESSIONS = [{ id: PANE, title: 'remote shell' }];

let platform: FakePtyAdapter;
let container: HTMLDivElement;
let root: Root;

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
      onSendInput={(data) => writeUserInput(active, data)}
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
  ensureResizeObserver();
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
      act(() => { screen!.dispatchEvent(pointerEvent('pointerdown')); });
      expect(getActivity(PANE)).toMatchObject({ status: 'WATCHING_DISABLED', todo: true });
    },
  );

  it('a keystroke from the input bar acknowledges with input, clearing the TODO', () => {
    render('gestures');
    ring();
    const bar = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Terminal input"]');
    expect(bar).not.toBeNull();
    act(() => {
      bar!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(getActivity(PANE)).toMatchObject({ status: 'WATCHING_DISABLED', todo: false });
  });
});
