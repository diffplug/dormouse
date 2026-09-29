/**
 * A stand-in for `@xterm/xterm` and the addons the terminal registry loads, for
 * suites that run the real registry where no canvas can measure glyphs. Point
 * each module at it: `vi.mock('@xterm/xterm', () => import('./xterm-test-mock'))`.
 */

type Listener<T> = (value: T) => void;

function listen<T>(listeners: Set<Listener<T>>, listener: Listener<T>): { dispose: () => void } {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}

export class Terminal {
  element: HTMLElement | undefined;
  cols = 80;
  rows = 24;
  options: Record<string, unknown> = {};
  /** Everything written to the screen, in order. */
  writes: string[] = [];
  addons: unknown[] = [];
  parser = { registerCsiHandler: () => ({ dispose: () => {} }) };
  modes = { mouseTrackingMode: 'none' as const, bracketedPasteMode: false };
  unicode = { activeVersion: '11' };
  buffer = { active: { getLine: () => undefined, baseY: 0, cursorY: 0, cursorX: 0, viewportY: 0 } };
  private dataListeners = new Set<Listener<string>>();
  private resizeListeners = new Set<Listener<{ cols: number; rows: number }>>();

  loadAddon(addon: unknown): void {
    this.addons.push(addon);
  }

  /** A DOM host gets xterm's `.xterm` root, so listeners on it see real events. */
  open(host: HTMLElement): void {
    if (typeof HTMLElement === 'undefined' || !(host instanceof HTMLElement)) return;
    this.element = document.createElement('div');
    this.element.className = 'xterm';
    host.appendChild(this.element);
  }

  /** Never parses, so a write never completes: its callback is not called. */
  write(data: string): void {
    this.writes.push(data);
  }

  onData(listener: Listener<string>): { dispose: () => void } {
    return listen(this.dataListeners, listener);
  }

  onResize(listener: Listener<{ cols: number; rows: number }>): { dispose: () => void } {
    return listen(this.resizeListeners, listener);
  }

  onRender(): { dispose: () => void } {
    return { dispose: () => {} };
  }

  attachCustomKeyEventHandler(): void {}
  focus(): void {}
  blur(): void {}
  clearSelection(): void {}
  dispose(): void {}

  /** The user typed `data`: what xterm's `onData` hands the registry. */
  emitInput(data: string): void {
    this.dataListeners.forEach((listener) => listener(data));
  }

  emitResize(cols: number, rows: number): void {
    this.resizeListeners.forEach((listener) => listener({ cols, rows }));
  }
}

export class FitAddon {
  fit(): void {}

  proposeDimensions(): { cols: number; rows: number } {
    return { cols: 80, rows: 24 };
  }
}

export class ImageAddon {
  constructor(readonly options?: Record<string, unknown>) {}
}

export class UnicodeGraphemesAddon {}

export class SerializeAddon {
  serialize(): string {
    return '';
  }
}
