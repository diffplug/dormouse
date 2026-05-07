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
  private readonly listeners = new Map<string, Array<(ev: MouseEvent) => void>>();

  addEventListener(type: string, listener: (ev: MouseEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (ev: MouseEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((l) => l !== listener));
  }

  emit(type: string, ev: FakeMouseEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(ev);
    }
  }
}

class FakeElement extends ListenerHost {
  getBoundingClientRect(): Pick<DOMRect, 'left' | 'top'> {
    return { left: 0, top: 0 };
  }
}

type FakeMouseEvent = MouseEvent & {
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
  stopImmediatePropagation: ReturnType<typeof vi.fn>;
};

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
});
