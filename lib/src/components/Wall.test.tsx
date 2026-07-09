/**
 * @vitest-environment jsdom
 *
 * Integration smoke for the Wall on the Lath engine: it renders panes through
 * LathHost, splits/kills through the engine, and persists the Lath layout on save.
 * jsdom has no real layout, so this asserts structure (leaf count, save shape), not
 * geometry — the acceptance matrix in tiling-engine.md is the live gate.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { Wall } from './Wall';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import * as terminalRegistry from '../lib/terminal-registry';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The real registry + fake platform are used; only the xterm-heavy TerminalPane is
// stubbed so panes mount cheaply. TerminalPanel still runs usePaneChrome (registering
// the leaf element) and renders this stub inside its animation div.
vi.mock('./TerminalPane', () => ({
  // `isFocused` is the Wall's focus decision for a pane (mode === 'passthrough' &&
  // selected) — the real component turns it into an xterm `.focus()`. Reflect it as
  // a data attribute so focus-transfer tests can assert on it without a live xterm.
  TerminalPane: ({ id, isFocused }: { id: string; isFocused?: boolean }) => (
    <div data-testid="terminal-pane" data-session-id={id} data-focused={isFocused ? 'true' : 'false'} />
  ),
}));

let container: HTMLDivElement;
let root: Root;
let fake: FakePtyAdapter;

function leafCount(): number {
  return container.querySelectorAll('[data-lath-leaf]').length;
}

beforeEach(() => {
  fake = new FakePtyAdapter();
  setPlatform(fake);
  // jsdom lacks these; Baseboard / dynamic-palette / reduced-motion need them.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // Reduced motion so the Lath engine runs a 0 duration: the two-phase kill's
  // deferred removal fires on a setTimeout(0) and completes within `flush()` — the
  // instant path is also stage 3's "reduced motion" acceptance requirement.
  globalThis.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  })) as unknown as typeof matchMedia;
  // The selection overlay's marching-ants path calls SVG getTotalLength (unimplemented in jsdom).
  (SVGElement.prototype as unknown as { getTotalLength?: () => number }).getTotalLength ??= () => 100;
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('Wall on the Lath engine', () => {
  it('renders a pane through LathHost, splits via wallActions, kills, and persists the Lath layout on save', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();

    // 1. A pane renders through LathHost (the stable Lath leaf div).
    expect(container.querySelector('.lath-host')).not.toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect(leafCount()).toBe(1);

    // 2. A split via wallActions (keyboard `|` → onSplitH → addSplitPanel) adds a leaf.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '|', bubbles: true }));
    });
    await flush();
    expect(leafCount()).toBe(2);

    // 3. Kill the second surface (dor kill, dangerously) → back to one leaf.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.kill,
          params: { surface: 'surface:2', confirmation: { mode: 'dangerously' } },
          respond: () => {},
        },
      }));
    });
    await flush();
    expect(leafCount()).toBe(1);

    // 4. A save (flushed via pagehide) writes the Lath layout only (no legacy
    //    dockview `layout` key).
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await flush();
    await flush();

    const saved = fake.getState() as { version?: number; lathLayout?: { version?: number; leafMeta?: Record<string, unknown> } } | null;
    expect(saved).not.toBeNull();
    expect(saved!.version).toBe(3);
    expect(saved!.lathLayout).toBeDefined();
    expect(saved!.lathLayout!.version).toBe(1);
    // The surviving pane is present in the Lath layout's leaf meta.
    expect(Object.keys(saved!.lathLayout!.leafMeta ?? {})).toContain('pane-a');
  });

  it('ignores zoom keyboard requests while a door is selected', async () => {
    const onEvent = vi.fn();
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard onEvent={onEvent} />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-door-id="pane-a"]')).not.toBeNull();

    onEvent.mockClear();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    });
    await flush();

    expect(onEvent).not.toHaveBeenCalledWith({ type: 'zoomChange', zoomed: true });
  });

  it('dor kill can target a minimized surface ref', async () => {
    let response: { ok: boolean; error?: string } | undefined;
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-door-id="pane-a"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.kill,
          params: { surface: 'surface:1', confirmation: { mode: 'dangerously' } },
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();

    expect(response?.ok).toBe(true);
    expect(response?.error).toBeUndefined();
    expect(container.querySelector('[data-door-id="pane-a"]')).toBeNull();
  });

  it('dor action targets reject bare numeric refs', async () => {
    let response: { ok: boolean; error?: string } | undefined;
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.kill,
          params: { surface: '1', confirmation: { mode: 'dangerously' } },
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();

    expect(response?.ok).toBe(false);
    expect(response?.error).toContain("surface '1' was not found");
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
  });

  it('dor action targets can resolve surface:self from the caller id', async () => {
    let response: { ok: boolean; error?: string } | undefined;
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.kill,
          surfaceId: 'pane-a',
          params: { surface: 'surface:self', confirmation: { mode: 'dangerously' } },
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();

    expect(response?.ok).toBe(true);
    expect(response?.error).toBeUndefined();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).toBeNull();
  });

  it('keeps visible terminal sessions mounted until the kill fade completes', async () => {
    globalThis.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() { return false; },
    })) as unknown as typeof matchMedia;
    const disposeSpy = vi.spyOn(terminalRegistry, 'disposeSession');

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
      });
      await flush();

      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.kill,
            params: { surface: 'surface:1', confirmation: { mode: 'dangerously' } },
            respond: () => {},
          },
        }));
      });

      expect(disposeSpy).not.toHaveBeenCalledWith('pane-a');

      await act(async () => {
        await new Promise((r) => setTimeout(r, 500));
      });

      expect(disposeSpy).toHaveBeenCalledWith('pane-a');
    } finally {
      disposeSpy.mockRestore();
    }
  });

  // The focus decision the Wall makes for a pane: `data-focused` on the mocked
  // TerminalPane mirrors `mode === 'passthrough' && selected`.
  const focusOf = (id: string): string | null =>
    container.querySelector(`[data-session-id="${id}"]`)?.getAttribute('data-focused') ?? null;

  async function dispatchSplit(params: Record<string, unknown>): Promise<string> {
    let response: { ok: boolean; result?: { surfaceId?: string } } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.split,
          params,
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();
    expect(response?.ok).toBe(true);
    return response!.result!.surfaceId!;
  }

  it('dor split transfers focus to the new surface (passthrough)', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" showBaseboard />);
    });
    await flush();
    // The seeded pane starts focused (passthrough + selected).
    expect(focusOf('pane-a')).toBe('true');

    const newId = await dispatchSplit({ direction: 'right' });

    // Focus moves to the freshly split surface; the caller is no longer focused.
    expect(focusOf(newId)).toBe('true');
    expect(focusOf('pane-a')).toBe('false');
  });

  it('dor split -- <command> keeps focus on the calling surface (passthrough)', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" showBaseboard />);
    });
    await flush();
    expect(focusOf('pane-a')).toBe('true');

    const newId = await dispatchSplit({ direction: 'right', command: ['echo', 'hi'] });

    // The initial command runs in the background: the caller keeps focus and the
    // new surface is not focused.
    expect(focusOf('pane-a')).toBe('true');
    expect(focusOf(newId)).toBe('false');
  });

  it('seeds multiple initial panes with the aspect-aware layout (geometry is measured before the seed)', async () => {
    // jsdom has no layout, so stub the container measurement wide. The seed reads the
    // store's geometry via `autoEdge`; if that geometry lags behind the measurement
    // (the old passive-effect report left it at the initial 0×0 on mount), the aspect
    // heuristic sees a square and stacks every pane vertically. A wide container must
    // instead produce `row[A, col[B,C]]`: A is the full-height left column.
    const origRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 740, width: 1200, height: 740, toJSON() {} } as DOMRect;
    };
    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a', 'pane-b', 'pane-c']} initialMode="command" showBaseboard />);
      });
      await flush();

      const leafOf = (id: string) => container.querySelector<HTMLElement>(`[data-lath-leaf="${id}"]`);
      const heightOf = (id: string) => parseFloat(leafOf(id)!.style.height);
      const leftOf = (id: string) => parseFloat(leafOf(id)!.style.left);

      expect(leafCount()).toBe(3);
      // A is the left column: full container height and flush to the left edge.
      expect(heightOf('pane-a')).toBeGreaterThan(700);
      expect(leftOf('pane-a')).toBe(0);
      // B and C share the right column: offset right and each roughly half-height —
      // i.e. NOT a pure vertical stack (which would leave all three at left:0).
      expect(leftOf('pane-b')).toBeGreaterThan(0);
      expect(leftOf('pane-c')).toBeGreaterThan(0);
      expect(heightOf('pane-b')).toBeLessThan(500);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origRect;
    }
  });
});
