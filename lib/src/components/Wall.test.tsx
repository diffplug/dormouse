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

async function flushFrame(): Promise<void> {
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(undefined))); });
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
    const focusedAfterSplit = Array.from(container.querySelectorAll<HTMLElement>('[data-session-id]'))
      .filter((el) => el.dataset.focused === 'true');
    expect(focusedAfterSplit).toHaveLength(1);
    expect(focusedAfterSplit[0].dataset.sessionId).not.toBe('pane-a');

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

  it('manual keyboard splits enter passthrough on the new pane immediately', async () => {
    const onEvent = vi.fn();
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard onEvent={onEvent} />);
    });
    await flush();
    onEvent.mockClear();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '|', bubbles: true }));
    });
    await flush();

    const panes = Array.from(container.querySelectorAll<HTMLElement>('[data-session-id]'));
    const newPane = panes.find((pane) => pane.dataset.sessionId !== 'pane-a');
    expect(newPane?.dataset.focused).toBe('true');
    expect(panes.find((pane) => pane.dataset.sessionId === 'pane-a')?.dataset.focused).toBe('false');
    expect(onEvent).toHaveBeenCalledWith({ type: 'modeChange', mode: 'passthrough' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'selectionChange', id: newPane?.dataset.sessionId, kind: 'pane' });
  });

  it('host New Terminal actions enter passthrough on the spawned pane', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:new-terminal', {
        detail: { shell: '/bin/zsh', name: 'zsh' },
      }));
    });
    await flush();

    const panes = Array.from(container.querySelectorAll<HTMLElement>('[data-session-id]'));
    const newPane = panes.find((pane) => pane.dataset.sessionId !== 'pane-a');
    expect(newPane?.dataset.focused).toBe('true');
    expect(panes.find((pane) => pane.dataset.sessionId === 'pane-a')?.dataset.focused).toBe('false');
  });

  it('retires a killed surface ref instead of reusing its number, and persists the counter', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();

    // Split → the new pane gets surface:2.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '|', bubbles: true }));
    });
    await flush();

    // Kill surface:2 → its ref is retired, not recycled.
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

    // Manual split entered passthrough; return to command mode before splitting
    // again. The fresh pane must be surface:3, never a reused surface:2.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 1, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 2, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '|', bubbles: true }));
    });
    await flush();

    let listed: { result?: { surfaces: Array<{ ref: string }> } } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.list,
          params: {},
          respond: (r: { result?: { surfaces: Array<{ ref: string }> } }) => { listed = r; },
        },
      }));
    });
    await flush();
    expect(listed?.result?.surfaces.map((s) => s.ref)).toEqual(['surface:1', 'surface:3']);

    // The save drops the killed surface:2 entry but keeps the counter past it, so a
    // later restore still can't hand surface:2 to a different Surface.
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await flush();
    await flush();

    const saved = fake.getState() as { surfaceRefs?: Record<string, string>; surfaceRefsNext?: number } | null;
    expect(Object.values(saved!.surfaceRefs ?? {})).toEqual(['surface:1', 'surface:3']);
    expect(saved!.surfaceRefsNext).toBe(4);
  });

  it('preserves the surface ref when an iframe replaces an untouched terminal', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'pane-a');

    try {
      let response: {
        ok: boolean;
        error?: string;
        result?: { status: string; surfaceId: string; surfaceRef: string };
      } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.iframe,
            params: { url: 'http://localhost:5173/' },
            respond: (r: typeof response) => { response = r; },
          },
        }));
      });
      await flush();

      expect(response?.ok).toBe(true);
      expect(response?.error).toBeUndefined();
      expect(response?.result?.status).toBe('replaced');
      expect(response?.result?.surfaceRef).toBe('surface:1');
      const newId = response!.result!.surfaceId;
      expect(newId).not.toBe('pane-a');

      let listed: { result?: { surfaces: Array<{ id: string; ref: string }> } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.list,
            params: {},
            respond: (r: typeof listed) => { listed = r; },
          },
        }));
      });
      await flush();
      expect(listed?.result?.surfaces.map((surface) => [surface.id, surface.ref])).toEqual([[newId, 'surface:1']]);

      await act(async () => {
        window.dispatchEvent(new Event('pagehide'));
      });
      await flush();
      await flush();

      const saved = fake.getState() as { surfaceRefs?: Record<string, string>; surfaceRefsNext?: number } | null;
      expect(saved!.surfaceRefs).toEqual({ [newId]: 'surface:1' });
      expect(saved!.surfaceRefsNext).toBe(2);
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('retires the old ref when shell selection replaces an untouched pane', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'pane-a');

    try {
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:new-terminal', {
          detail: {
            shell: '/bin/zsh',
            name: 'zsh',
            replaceUntouched: true,
          },
        }));
      });
      await flush();

      let listed: { result?: { surfaces: Array<{ id: string; ref: string }> } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.list,
            params: {},
            respond: (r: typeof listed) => { listed = r; },
          },
        }));
      });
      await flush();

      expect(listed?.result?.surfaces).toHaveLength(1);
      const replacement = listed!.result!.surfaces[0];
      expect(replacement.id).not.toBe('pane-a');
      expect(replacement.ref).toBe('surface:2');

      await act(async () => {
        window.dispatchEvent(new Event('pagehide'));
      });
      await flush();
      await flush();

      const saved = fake.getState() as { surfaceRefs?: Record<string, string>; surfaceRefsNext?: number } | null;
      expect(saved!.surfaceRefs).toEqual({ [replacement.id]: 'surface:2' });
      expect(saved!.surfaceRefsNext).toBe(3);
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('retires the old ref when shell selection replaces an untouched selected door', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'pane-a');

    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
      });
      await flush();
      expect(container.querySelector('[data-door-id="pane-a"]')).not.toBeNull();

      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:new-terminal', {
          detail: {
            shell: '/bin/zsh',
            name: 'zsh',
            replaceUntouched: true,
          },
        }));
      });
      await flush();
      await flushFrame();
      await flush();

      let listed: { result?: { surfaces: Array<{ id: string; ref: string }> } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.list,
            params: {},
            respond: (r: typeof listed) => { listed = r; },
          },
        }));
      });
      await flush();

      expect(listed?.result?.surfaces).toHaveLength(2);
      expect(listed!.result!.surfaces.map((surface) => surface.ref)).toEqual(['surface:2', 'surface:3']);
      expect(listed!.result!.surfaces.some((surface) => surface.id === 'pane-a')).toBe(false);
      expect(container.querySelector('[data-door-id="pane-a"]')).toBeNull();

      await act(async () => {
        window.dispatchEvent(new Event('pagehide'));
      });
      await flush();
      await flush();

      const saved = fake.getState() as { surfaceRefs?: Record<string, string>; surfaceRefsNext?: number } | null;
      expect(saved!.surfaceRefs).not.toHaveProperty('pane-a');
      expect(Object.values(saved!.surfaceRefs ?? {})).toEqual(['surface:2', 'surface:3']);
      expect(saved!.surfaceRefsNext).toBe(4);
    } finally {
      untouchedSpy.mockRestore();
    }
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

  it('gives passthrough focus to a pane when it gains zoom, and unzooms when passthrough focus ends', async () => {
    const onEvent = vi.fn();
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard onEvent={onEvent} />);
    });
    await flush();
    onEvent.mockClear();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    });
    await flush();

    expect(onEvent).toHaveBeenCalledWith({ type: 'zoomChange', zoomed: true });
    expect(onEvent).toHaveBeenCalledWith({ type: 'modeChange', mode: 'passthrough' });
    expect(container.querySelector('[data-session-id="pane-a"]')?.getAttribute('data-focused')).toBe('true');
    const unzoom = container.querySelector<HTMLButtonElement>('button[aria-label="Unzoom"]');
    expect(unzoom).not.toBeNull();
    // jsdom's document is not window-focused, so Wall renders the inactive
    // header palette here; the surface-header unit test covers the active pair.
    expect(unzoom?.className).toContain('bg-header-inactive-fg');
    expect(unzoom?.className).toContain('text-header-inactive-bg');

    // The normal passthrough-exit gesture gives focus back to command mode; zoom
    // follows focus and begins its return to the tiled layout in the same action.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 1, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 2, bubbles: true }));
    });
    await flush();

    expect(onEvent).toHaveBeenCalledWith({ type: 'zoomChange', zoomed: false });
    expect(onEvent).toHaveBeenCalledWith({ type: 'modeChange', mode: 'command' });
    expect(container.querySelector('[data-session-id="pane-a"]')?.getAttribute('data-focused')).toBe('false');
  });

  it('unzooms the focused pane when another pane gains focus', async () => {
    const onEvent = vi.fn();
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard onEvent={onEvent} />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-session-id="pane-a"]')?.getAttribute('data-focused')).toBe('true');
    expect(container.querySelectorAll('button[aria-label="Unzoom"]')).toHaveLength(1);
    expect(container.querySelector('[data-lath-leaf="pane-a"] button[aria-label="Unzoom"]')).not.toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-b"] button[aria-label="Zoom"]')).not.toBeNull();

    onEvent.mockClear();
    const paneBHeader = container.querySelector<HTMLElement>('[data-lath-leaf="pane-b"] .lath-leaf-header > div');
    expect(paneBHeader).not.toBeNull();
    await act(async () => {
      paneBHeader!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flush();

    expect(onEvent).toHaveBeenCalledWith({ type: 'zoomChange', zoomed: false });
    expect(onEvent).toHaveBeenCalledWith({ type: 'selectionChange', id: 'pane-b', kind: 'pane' });
    expect(container.querySelector('[data-session-id="pane-a"]')?.getAttribute('data-focused')).toBe('false');
    expect(container.querySelector('[data-session-id="pane-b"]')?.getAttribute('data-focused')).toBe('true');
  });

  it('hands zoom over when a partially exposed pane\'s Zoom control is clicked', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-lath-leaf="pane-a"] button[aria-label="Unzoom"]')).not.toBeNull();

    // The elevated pane exposes a perimeter, so pane-b's Zoom control is reachable
    // while pane-a is zoomed. HeaderActionButton stops mousedown, so no selection
    // runs first: onZoom itself must hand zoom over rather than only unzoom pane-a.
    const zoomB = container.querySelector<HTMLButtonElement>('[data-lath-leaf="pane-b"] button[aria-label="Zoom"]');
    expect(zoomB).not.toBeNull();
    await act(async () => {
      zoomB!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[data-lath-leaf="pane-b"] button[aria-label="Unzoom"]')).not.toBeNull();
    expect(container.querySelectorAll('button[aria-label="Unzoom"]')).toHaveLength(1);
    expect(container.querySelector('[data-session-id="pane-b"]')?.getAttribute('data-focused')).toBe('true');
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

  it('dor split can target a minimized surface and creates a sibling door', async () => {
    let response: {
      ok: boolean;
      error?: string;
      result?: { surfaceId: string; surfaceRef: string; direction: string; minimized: boolean };
    } | undefined;
    const getTerminalSpy = vi
      .spyOn(terminalRegistry, 'getOrCreateTerminal')
      .mockImplementation(() => ({}) as ReturnType<typeof terminalRegistry.getOrCreateTerminal>);
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />);
    });
    await flush();

    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
      });
      await flush();
      expect(Array.from(container.querySelectorAll('[data-door-id]')).map((el) => el.getAttribute('data-door-id'))).toEqual(['pane-a']);
      expect(leafCount()).toBe(1);

      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.split,
            params: { surface: 'surface:1' },
            respond: (r: typeof response) => { response = r; },
          },
        }));
      });
      await flush();

      expect(response?.ok).toBe(true);
      expect(response?.error).toBeUndefined();
      expect(response?.result?.surfaceRef).toBe('surface:3');
      expect(response?.result?.direction).toBe('right');
      expect(response?.result?.minimized).toBe(true);
      expect(getTerminalSpy).toHaveBeenCalledWith(response!.result!.surfaceId);
      expect(leafCount()).toBe(1);
      await act(async () => {
        window.dispatchEvent(new Event('pagehide'));
      });
      await flush();
      await flush();
      const saved = fake.getState() as { doors?: Array<{ id: string }> } | null;
      expect(saved?.doors?.map((door) => door.id)).toEqual(['pane-a', response!.result!.surfaceId]);
    } finally {
      getTerminalSpy.mockRestore();
    }
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

    // The CLI marks a `-- <command>` split focus-neutral (it always sends
    // focusNeutral when `--` or a command is present).
    const newId = await dispatchSplit({ direction: 'right', command: ['echo', 'hi'], focusNeutral: true });

    // The initial command runs in the background: the caller keeps focus and the
    // new surface is not focused.
    expect(focusOf('pane-a')).toBe('true');
    expect(focusOf(newId)).toBe('false');
  });

  it('dor split -- (empty tail) opens a blank surface without stealing focus', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" showBaseboard />);
    });
    await flush();
    expect(focusOf('pane-a')).toBe('true');

    // No command, but focusNeutral marks the `--` tail: a blank terminal that
    // does not grab the user's keystrokes (unlike a bare `dor split`).
    const newId = await dispatchSplit({ direction: 'right', focusNeutral: true });

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
