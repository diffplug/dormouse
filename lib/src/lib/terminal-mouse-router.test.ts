import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachTerminalMouseRouter } from './terminal-mouse-router';
import {
  __resetMouseSelectionForTests,
  getMouseSelectionState,
  setMouseReporting,
  setOverride,
} from './mouse-selection';
import type { TerminalOverlayDims } from './terminal-store';

class ListenerHost {
  private readonly listeners = new Map<string, Array<(ev: MouseEvent | PointerEvent) => void>>();

  addEventListener(type: string, listener: (ev: MouseEvent | PointerEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (ev: MouseEvent | PointerEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((l) => l !== listener));
  }

  emit(type: string, ev: FakeMouseEvent | FakePointerEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(ev);
    }
  }
}

class FakeElement extends ListenerHost {
  setPointerCapture = vi.fn();
  releasePointerCapture = vi.fn();

  getBoundingClientRect(): Pick<DOMRect, 'left' | 'top'> {
    return { left: 0, top: 0 };
  }
}

type FakeMouseEvent = MouseEvent & {
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
  stopImmediatePropagation: ReturnType<typeof vi.fn>;
};

type FakePointerEvent = PointerEvent & FakeMouseEvent;

function mouseEvent(overrides: Partial<MouseEvent> = {}): FakeMouseEvent {
  return {
    button: 0,
    clientX: 5,
    clientY: 5,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides,
  } as FakeMouseEvent;
}

function pointerEvent(overrides: Partial<PointerEvent> = {}): FakePointerEvent {
  return {
    ...mouseEvent(overrides),
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    ...overrides,
  } as FakePointerEvent;
}

const dims: TerminalOverlayDims = {
  cols: 80,
  rows: 24,
  viewportY: 0,
  baseY: 0,
  elementWidth: 800,
  elementHeight: 240,
  cellWidth: 10,
  cellHeight: 10,
  gridLeft: 0,
  gridTop: 0,
};

function createHarness(windowHost: ListenerHost) {
  const element = new FakeElement();
  const terminal = {
    cols: 80,
    clearSelection: vi.fn(),
    focus: vi.fn(),
    buffer: {
      active: {
        getLine: vi.fn(() => ({ translateToString: () => '' })),
      },
    },
  };
  const cleanup = attachTerminalMouseRouter({
    id: 't1',
    terminal: terminal as never,
    element: element as never,
    getOverlayDims: () => dims,
    setSelectionBaseline: vi.fn(),
  });
  return { cleanup, element, terminal, windowHost };
}

let windowHost: ListenerHost;

beforeEach(() => {
  windowHost = new ListenerHost();
  vi.stubGlobal('window', windowHost);
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetMouseSelectionForTests();
});

describe('terminal-mouse-router: override suppression', () => {
  it('suppresses temporary override mousedown before xterm can handle it', () => {
    const { cleanup, element, terminal } = createHarness(windowHost);
    setMouseReporting('t1', 'vt200');
    setOverride('t1', 'temporary');

    const ev = mouseEvent();
    element.emit('mousedown', ev);

    expect(ev.preventDefault).toHaveBeenCalledOnce();
    expect(ev.stopPropagation).toHaveBeenCalledOnce();
    expect(ev.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(terminal.focus).toHaveBeenCalledOnce();
    cleanup();
  });

  it('does not suppress live-region mouse events while reporting is active without an override', () => {
    const { cleanup, element } = createHarness(windowHost);
    setMouseReporting('t1', 'vt200');

    const ev = mouseEvent();
    element.emit('mousedown', ev);

    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(ev.stopPropagation).not.toHaveBeenCalled();
    expect(ev.stopImmediatePropagation).not.toHaveBeenCalled();
    cleanup();
  });

  it('suppresses pre-drag movement and clears temporary override after the paired mouseup', async () => {
    const { cleanup, element } = createHarness(windowHost);
    setMouseReporting('t1', 'vt200');
    setOverride('t1', 'temporary');

    element.emit('mousedown', mouseEvent());

    const move = mouseEvent({ clientX: 6 });
    windowHost.emit('mousemove', move);
    expect(move.preventDefault).toHaveBeenCalledOnce();
    expect(getMouseSelectionState('t1').override).toBe('temporary');

    const up = mouseEvent();
    windowHost.emit('mouseup', up);
    expect(up.preventDefault).toHaveBeenCalledOnce();

    await Promise.resolve();
    expect(getMouseSelectionState('t1').override).toBe('off');
    cleanup();
  });

  it('suppresses sticky override mousemove without clearing the override on mouseup', async () => {
    const { cleanup, element } = createHarness(windowHost);
    setMouseReporting('t1', 'vt200');
    setOverride('t1', 'permanent');

    const move = mouseEvent();
    element.emit('mousemove', move);
    expect(move.preventDefault).toHaveBeenCalledOnce();

    element.emit('mousedown', mouseEvent());
    windowHost.emit('mouseup', mouseEvent());

    await Promise.resolve();
    expect(getMouseSelectionState('t1').override).toBe('permanent');
    cleanup();
  });

  it('suppresses wheel while an override is active', () => {
    const { cleanup, element } = createHarness(windowHost);
    setMouseReporting('t1', 'vt200');
    setOverride('t1', 'permanent');

    const wheel = mouseEvent();
    element.emit('wheel', wheel);

    expect(wheel.preventDefault).toHaveBeenCalledOnce();
    expect(wheel.stopPropagation).toHaveBeenCalledOnce();
    expect(wheel.stopImmediatePropagation).toHaveBeenCalledOnce();
    cleanup();
  });

  it('selects text from a touch pointer drag using the terminal selection path', () => {
    const { cleanup, element, terminal } = createHarness(windowHost);

    const down = pointerEvent({ clientX: 5, clientY: 5 });
    element.emit('pointerdown', down);
    expect(down.preventDefault).toHaveBeenCalledOnce();
    expect(down.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(element.setPointerCapture).toHaveBeenCalledWith(1);
    expect(terminal.focus).toHaveBeenCalledOnce();

    const move = pointerEvent({ clientX: 25, clientY: 15 });
    windowHost.emit('pointermove', move);
    expect(move.preventDefault).toHaveBeenCalledOnce();
    expect(terminal.clearSelection).toHaveBeenCalledOnce();

    const dragging = getMouseSelectionState('t1').selection;
    expect(dragging).toMatchObject({
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 2,
      dragging: true,
    });

    const up = pointerEvent({ clientX: 25, clientY: 15 });
    windowHost.emit('pointerup', up);
    expect(up.preventDefault).toHaveBeenCalledOnce();
    expect(element.releasePointerCapture).toHaveBeenCalledWith(1);

    expect(getMouseSelectionState('t1').selection).toMatchObject({
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 2,
      dragging: false,
    });
    cleanup();
  });

  it('starts a block selection from a double-tap-then-drag on touch', () => {
    const { cleanup, element } = createHarness(windowHost);

    // First tap: a quick press and release with no drag — leaves no selection.
    element.emit('pointerdown', pointerEvent({ clientX: 5, clientY: 5 }));
    windowHost.emit('pointerup', pointerEvent({ clientX: 5, clientY: 5 }));
    expect(getMouseSelectionState('t1').selection).toBeNull();

    // Second tap immediately after, in the same spot, then drag → block shape.
    element.emit('pointerdown', pointerEvent({ clientX: 5, clientY: 5 }));
    windowHost.emit('pointermove', pointerEvent({ clientX: 25, clientY: 15 }));

    expect(getMouseSelectionState('t1').selection).toMatchObject({
      shape: 'block',
      dragging: true,
    });
    cleanup();
  });

  it('keeps a single touch drag linewise when the taps are too far apart in time', () => {
    let now = 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { cleanup, element } = createHarness(windowHost);

    element.emit('pointerdown', pointerEvent({ clientX: 5, clientY: 5 }));
    windowHost.emit('pointerup', pointerEvent({ clientX: 5, clientY: 5 }));

    now += 1000; // well beyond the double-tap window
    element.emit('pointerdown', pointerEvent({ clientX: 5, clientY: 5 }));
    windowHost.emit('pointermove', pointerEvent({ clientX: 25, clientY: 15 }));

    expect(getMouseSelectionState('t1').selection).toMatchObject({
      shape: 'linewise',
      dragging: true,
    });
    nowSpy.mockRestore();
    cleanup();
  });

  it('does not treat two quick consecutive drags as a double-tap', () => {
    const { cleanup, element } = createHarness(windowHost);

    // First interaction is a DRAG (not a tap), so it must not arm block mode.
    element.emit('pointerdown', pointerEvent({ clientX: 5, clientY: 5 }));
    windowHost.emit('pointermove', pointerEvent({ clientX: 25, clientY: 15 }));
    windowHost.emit('pointerup', pointerEvent({ clientX: 25, clientY: 15 }));

    // A second drag right after, nearby, stays linewise.
    element.emit('pointerdown', pointerEvent({ clientX: 5, clientY: 5 }));
    windowHost.emit('pointermove', pointerEvent({ clientX: 25, clientY: 15 }));

    expect(getMouseSelectionState('t1').selection).toMatchObject({
      shape: 'linewise',
      dragging: true,
    });
    cleanup();
  });

  it('suppresses compatibility mouse events after a touch selection starts', () => {
    const { cleanup, element } = createHarness(windowHost);

    element.emit('pointerdown', pointerEvent());
    const mouseDown = mouseEvent();
    element.emit('mousedown', mouseDown);

    expect(mouseDown.preventDefault).toHaveBeenCalledOnce();
    expect(mouseDown.stopImmediatePropagation).toHaveBeenCalledOnce();
    cleanup();
  });

  it('does not select from non-primary touch pointers', () => {
    const { cleanup, element } = createHarness(windowHost);

    const down = pointerEvent({ isPrimary: false });
    element.emit('pointerdown', down);
    windowHost.emit('pointermove', pointerEvent({ clientX: 25, clientY: 15 }));

    expect(down.preventDefault).not.toHaveBeenCalled();
    expect(getMouseSelectionState('t1').selection).toBeNull();
    cleanup();
  });

  it('does not steal touch pointer drags from a mouse-reporting TUI without override', () => {
    const { cleanup, element } = createHarness(windowHost);
    setMouseReporting('t1', 'vt200');

    const down = pointerEvent();
    element.emit('pointerdown', down);
    windowHost.emit('pointermove', pointerEvent({ clientX: 25, clientY: 15 }));

    expect(down.preventDefault).not.toHaveBeenCalled();
    expect(getMouseSelectionState('t1').selection).toBeNull();
    cleanup();
  });
});
