/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileTerminalUi, paneMouseOverride, type MobileTerminalSessionItem, type MobileTerminalTouchMode, type MobileTerminalUiProps } from './MobileTerminalUi';
import { setNativeFieldValue } from '../lib/dom';
import { pointerEvent } from './wall/wall-test-utils';
import * as registry from '../lib/terminal-registry';
import type { Terminal } from '@xterm/xterm';

const EPISODE = { id: 'episode-1', startedAt: Date.now() };

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function renderMobileTerminal({
  touchMode,
  onMouseEvent,
}: {
  touchMode: MobileTerminalTouchMode;
  onMouseEvent: (event: MouseEvent) => void;
}): { terminal: HTMLDivElement; setTouchMode: (mode: MobileTerminalTouchMode) => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  const renderWith = (mode: MobileTerminalTouchMode) => {
    act(() => {
      root.render(
        <StrictMode>
          <MobileTerminalUi
            activeTouchMode={mode}
            cursorTouchAvailable
            terminal={<div data-testid="terminal" />}
          />
        </StrictMode>,
      );
    });
  };

  renderWith(touchMode);

  const terminal = container.querySelector<HTMLDivElement>('[data-testid="terminal"]');
  if (!terminal) throw new Error('missing terminal test node');
  terminal.addEventListener('mousedown', onMouseEvent);
  terminal.addEventListener('mousemove', onMouseEvent);
  terminal.addEventListener('mouseup', onMouseEvent);

  return { terminal, setTouchMode: renderWith };
}

let roots: Root[] = [];
let setPointerCapture: ReturnType<typeof vi.fn>;
let releasePointerCapture: ReturnType<typeof vi.fn>;

function mockElementFromPoint(element: Element): void {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => element),
  });
}

beforeEach(() => {
  setPointerCapture = vi.fn();
  releasePointerCapture = vi.fn();
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null),
  });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: setPointerCapture,
  });
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value: releasePointerCapture,
  });
});

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  roots = [];
  document.body.replaceChildren();
  delete (document as Document & { elementFromPoint?: unknown }).elementFromPoint;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** One mount of the whole composition, shared by every suite below: the input
 *  tests reach for the textarea, the session-list ones for the container. */
function renderUi(props: Partial<MobileTerminalUiProps> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const renderWith = (nextProps: Partial<MobileTerminalUiProps>) => act(() => root.render(
    <StrictMode>
      <MobileTerminalUi terminal={<div data-testid="terminal" />} {...nextProps} />
    </StrictMode>,
  ));
  renderWith(props);
  return {
    container,
    input: container.querySelector<HTMLTextAreaElement>('textarea')!,
    terminal: container.querySelector<HTMLDivElement>('[data-testid="terminal"]')!,
    typeButton: container.querySelector<HTMLButtonElement>('[aria-label="Type input mode"]')!,
    renderWith,
  };
}

describe('MobileTerminalUi keyboard input', () => {
  it('leaves IME editing keys to the composition and sends committed text once', () => {
    const onSendInput = vi.fn();
    const { input } = renderUi({ onSendInput });
    act(() => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      setNativeFieldValue(input, '日本');
    });
    for (const key of ['Backspace', 'ArrowLeft', 'Enter']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => input.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onSendInput).not.toHaveBeenCalled();
    expect(input.value).toBe('日本');
    act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' })));
    expect(onSendInput.mock.calls).toEqual([['日本']]);
    expect(input.value).toBe('');
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('ignores IME confirmation keydown with %j', (imeState) => {
    const onSendInput = vi.fn();
    const { input } = renderUi({ onSendInput });
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...imeState });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it('sends software-keyboard Backspace and Enter without keydown or a textarea change', () => {
    const onSendInput = vi.fn();
    const { input } = renderUi({ onSendInput });
    for (const inputType of ['deleteContentBackward', 'insertLineBreak', 'insertParagraph']) {
      const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
      act(() => input.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    }
    expect(onSendInput.mock.calls).toEqual([['\x7f'], ['\r'], ['\r']]);
    expect(input.value).toBe('');
  });

  it('leaves software-keyboard deletion inside an IME composition alone', () => {
    const onSendInput = vi.fn();
    const { input } = renderUi({ onSendInput });
    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    const event = new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(onSendInput).not.toHaveBeenCalled();
  });

  it('cancels pending focus when a pane touch dismisses the keyboard', () => {
    vi.useFakeTimers();
    const { input, terminal, typeButton } = renderUi();
    act(() => typeButton.click());
    expect(document.activeElement).toBe(input);
    act(() => terminal.dispatchEvent(pointerEvent('pointerdown')));
    act(() => vi.advanceTimersByTime(600));
    expect(document.activeElement).not.toBe(input);
  });

  it('cancels pending pane blur when Type is tapped again', () => {
    vi.useFakeTimers();
    const { input, terminal, typeButton } = renderUi();
    act(() => vi.advanceTimersByTime(600));
    act(() => terminal.dispatchEvent(pointerEvent('pointerdown')));
    act(() => typeButton.click());
    expect(document.activeElement).toBe(input);
    act(() => vi.advanceTimersByTime(600));
    expect(document.activeElement).toBe(input);
  });

  it('blurs when the consumer switches from Type to Sessions', () => {
    vi.useFakeTimers();
    const { input, typeButton, renderWith } = renderUi({ activeKeyboardMode: 'type' });
    act(() => typeButton.click());
    expect(document.activeElement).toBe(input);
    renderWith({ activeKeyboardMode: 'sessions' });
    act(() => vi.advanceTimersByTime(600));
    expect(document.activeElement).not.toBe(input);
  });
});

describe('MobileTerminalUi touch modes', () => {
  it('sends primary touch pointers as left-button mouse events in Mouse mode', () => {
    const received: string[] = [];
    const { terminal } = renderMobileTerminal({
      touchMode: 'cursor',
      onMouseEvent: (event) => {
        received.push(`${event.type}:${event.button}:${event.buttons}:${event.clientX}:${event.clientY}`);
      },
    });
    mockElementFromPoint(terminal);

    const down = pointerEvent('pointerdown');
    const move = pointerEvent('pointermove', { clientX: 18, clientY: 20 });
    const up = pointerEvent('pointerup', { clientX: 18, clientY: 20 });

    terminal.dispatchEvent(down);
    terminal.dispatchEvent(move);
    terminal.dispatchEvent(up);

    expect(down.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(received).toEqual([
      'mousedown:0:1:10:12',
      'mousemove:0:1:18:20',
      'mouseup:0:0:18:20',
    ]);
  });

  it('keeps synthesizing the full mouse sequence after switching into Mouse mode at runtime', () => {
    const received: string[] = [];
    const { terminal, setTouchMode } = renderMobileTerminal({
      touchMode: 'gestures',
      onMouseEvent: (event) => {
        received.push(`${event.type}:${event.button}:${event.buttons}:${event.clientX}:${event.clientY}`);
      },
    });
    mockElementFromPoint(terminal);

    // User switches Gestures -> Mouse after the handlers were first created.
    setTouchMode('cursor');

    terminal.dispatchEvent(pointerEvent('pointerdown'));
    terminal.dispatchEvent(pointerEvent('pointermove', { clientX: 18, clientY: 20 }));
    terminal.dispatchEvent(pointerEvent('pointerup', { clientX: 18, clientY: 20 }));

    expect(received).toEqual([
      'mousedown:0:1:10:12',
      'mousemove:0:1:18:20',
      'mouseup:0:0:18:20',
    ]);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it('sends a mouse release when a Mouse mode touch is cancelled', () => {
    const received: string[] = [];
    const { terminal } = renderMobileTerminal({
      touchMode: 'cursor',
      onMouseEvent: (event) => {
        received.push(`${event.type}:${event.buttons}`);
      },
    });
    mockElementFromPoint(terminal);

    terminal.dispatchEvent(pointerEvent('pointerdown'));
    const cancel = pointerEvent('pointercancel');
    terminal.dispatchEvent(cancel);

    expect(cancel.defaultPrevented).toBe(true);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(received).toEqual(['mousedown:1', 'mouseup:0']);
  });

  it('releases a tracked mouse press even after leaving Mouse mode', () => {
    const received: string[] = [];
    const { terminal, setTouchMode } = renderMobileTerminal({
      touchMode: 'cursor',
      onMouseEvent: (event) => received.push(event.type),
    });
    mockElementFromPoint(terminal);
    terminal.dispatchEvent(pointerEvent('pointerdown'));
    setTouchMode('gestures');
    terminal.dispatchEvent(pointerEvent('pointerup'));
    expect(received).toEqual(['mousedown', 'mouseup']);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it('targets mouse release at the final pointer position without requiring a last move', () => {
    const { terminal } = renderMobileTerminal({ touchMode: 'cursor', onMouseEvent: () => {} });
    const other = document.createElement('div');
    terminal.appendChild(other);
    const mouseup = vi.fn();
    other.addEventListener('mouseup', mouseup);
    mockElementFromPoint(terminal);
    terminal.dispatchEvent(pointerEvent('pointerdown'));
    mockElementFromPoint(other);
    terminal.dispatchEvent(pointerEvent('pointerup', { clientX: 25 }));
    expect(mouseup).toHaveBeenCalledOnce();
  });

  it('suppresses native touch events in Mouse mode', () => {
    const documentTouchMove = vi.fn();
    document.addEventListener('touchmove', documentTouchMove);
    try {
      const { terminal } = renderMobileTerminal({
        touchMode: 'cursor',
        onMouseEvent: () => {},
      });

      const touchMove = new Event('touchmove', { bubbles: true, cancelable: true });
      terminal.dispatchEvent(touchMove);

      expect(touchMove.defaultPrevented).toBe(true);
      expect(documentTouchMove).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('touchmove', documentTouchMove);
    }
  });

  it('does not synthesize mouse events for touch pointers in Select mode', () => {
    const received: string[] = [];
    const { terminal } = renderMobileTerminal({
      touchMode: 'selection',
      onMouseEvent: (event) => {
        received.push(event.type);
      },
    });
    mockElementFromPoint(terminal);

    terminal.dispatchEvent(pointerEvent('pointerdown'));
    terminal.dispatchEvent(pointerEvent('pointermove'));
    terminal.dispatchEvent(pointerEvent('pointerup'));

    expect(received).toEqual([]);
  });
});

describe('MobileTerminalUi session list', () => {
  const renderSessions = (sessions: MobileTerminalSessionItem[]) =>
    renderUi({ activeKeyboardMode: 'sessions', sessions }).container;

  const inset = (container: HTMLElement, title: string): string | null =>
    [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes(title))!
      .querySelector('[data-alert-ring-inset]')
      ?.getAttribute('data-alert-ring-inset') ?? null;

  /** The row is the alarm's only carrier now (`docs/specs/alert.md` -> Pane Header). */
  it('wears the alarm inset only on a ringing row, on its own ground', () => {
    const container = renderSessions([
      { id: 'a', title: 'ringing-active', active: true, status: 'ALERT_RINGING', episode: EPISODE },
      { id: 'b', title: 'ringing-idle', status: 'ALERT_RINGING', episode: EPISODE },
      { id: 'c', title: 'quiet', status: 'BUSY', episode: null },
    ]);

    expect(inset(container, 'ringing-active')).toBe('header-active');
    expect(inset(container, 'ringing-idle')).toBe('door');
    expect(inset(container, 'quiet')).toBeNull();
  });
});

describe('paneMouseOverride', () => {
  it('overrides a reporting pane only in Select mode', () => {
    expect(paneMouseOverride('selection', 'vt200')).toBe('permanent');
    expect(paneMouseOverride('selection', 'any')).toBe('permanent');
  });

  it('leaves a pane that reports nothing alone, Select mode included', () => {
    expect(paneMouseOverride('selection', 'none')).toBe('off');
  });

  it('never overrides outside Select mode', () => {
    for (const mode of ['gestures', 'cursor'] as const) {
      for (const reporting of ['none', 'x10', 'vt200', 'drag', 'any'] as const) {
        expect(paneMouseOverride(mode, reporting)).toBe('off');
      }
    }
  });
});

describe('MobileTerminalUi edge scroll', () => {
  function setup(capturing = false) {
    const onSendInput = vi.fn();
    const onGestureInput = vi.fn();
    const onGestureScroll = vi.fn();
    const scrollLines = vi.fn();
    const props: Partial<MobileTerminalUiProps> = {
      onSendInput, onGestureInput, onGestureScroll,
      sessions: [{ id: 'scroll-test', title: 'terminal', active: true, episode: null }],
    };
    const ui = renderUi(props);
    const host = ui.terminal.parentElement!.parentElement!;
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 390, bottom: 500, width: 390, height: 500 } as DOMRect);
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    ui.terminal.appendChild(screen);
    vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 32, right: 370, bottom: 500, width: 370, height: 468 } as DOMRect);
    vi.spyOn(registry, 'getTerminalInstance').mockReturnValue({
      element: ui.terminal, modes: { mouseTrackingMode: capturing ? 'any' : 'none' }, scrollLines,
    } as unknown as Terminal);
    const pointer = (type: string, x: number, y: number) => act(() => {
      ui.terminal.dispatchEvent(pointerEvent(type, { clientX: x, clientY: y }));
    });
    return { ...ui, props, onSendInput, onGestureInput, onGestureScroll, scrollLines, pointer };
  }

  it.each([10, 380])('scrolls history in both directions from x=%i and keeps an edge drag out of the compass', (edgeX) => {
    const { pointer, scrollLines, onSendInput, onGestureScroll } = setup();
    pointer('pointerdown', edgeX, 100);
    pointer('pointermove', edgeX, 90);
    expect(scrollLines).not.toHaveBeenCalled();
    pointer('pointermove', edgeX, 64);
    // Crossing into the compass region does not change the owner of this drag.
    pointer('pointermove', 100, 118);
    expect(scrollLines.mock.calls).toEqual([[2], [-3]]);
    expect(onGestureScroll.mock.calls).toEqual([[2], [-3]]);
    expect(onSendInput).not.toHaveBeenCalled();
    pointer('pointerup', 100, 118);
    pointer('pointermove', 100, 200);
    expect(scrollLines).toHaveBeenCalledTimes(2);
  });

  it.each([[0, 1], [380, 369]])('routes synthesized wheels from x=%i into the capturing terminal at x=%i', (edgeX, cellX) => {
    const { pointer, terminal, scrollLines, onSendInput } = setup(true);
    const wheels: WheelEvent[] = [];
    terminal.addEventListener('wheel', (event) => wheels.push(event));
    terminal.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 10 }));
    expect(wheels).toHaveLength(0);
    pointer('pointerdown', edgeX, 100);
    pointer('pointermove', edgeX, 64);
    pointer('pointermove', edgeX, 100);
    expect(wheels.map((event) => [event.deltaY, event.deltaMode, event.clientX])).toEqual([
      [1, 1, cellX], [1, 1, cellX], [-1, 1, cellX], [-1, 1, cellX],
    ]);
    expect(scrollLines).not.toHaveBeenCalled();
    expect(onSendInput).not.toHaveBeenCalled();
    pointer('pointercancel', edgeX, 100);
    pointer('pointermove', edgeX, 200);
    expect(wheels).toHaveLength(4);
  });

  it('keeps a drag starting away from the edge in the compass, reporting the gesture before sending it', () => {
    const { pointer, scrollLines, onSendInput, onGestureInput } = setup();
    pointer('pointerdown', 100, 200);
    pointer('pointermove', 380, 200);
    pointer('pointerup', 380, 200);
    expect(scrollLines).not.toHaveBeenCalled();
    expect(onSendInput).toHaveBeenCalledWith('\x1b[C');
    expect(onGestureInput).toHaveBeenCalledWith('right', '\x1b[C');
    expect(onGestureInput.mock.invocationCallOrder[0]).toBeLessThan(onSendInput.mock.invocationCallOrder[0]);
  });

  it.each<Partial<MobileTerminalUiProps>>([
    { interactive: false },
    { activeTouchMode: 'selection' },
    { sessions: [{ id: 'other', title: 'other', active: true, episode: null }] },
  ])('cancels an edge drag when its context changes: %j', (change) => {
    const { pointer, props, renderWith, scrollLines } = setup();
    pointer('pointerdown', 380, 100);
    pointer('pointermove', 380, 64);
    expect(scrollLines).toHaveBeenCalledTimes(1);
    renderWith({ ...props, ...change });
    // Returning to the original context must not resurrect the old drag.
    renderWith(props);
    pointer('pointermove', 380, 20);
    expect(scrollLines).toHaveBeenCalledTimes(1);
  });
});
