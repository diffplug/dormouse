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

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The real registry + fake platform are used; only the xterm-heavy TerminalPane is
// stubbed so panes mount cheaply. TerminalPanel still runs usePaneChrome (registering
// the leaf element) and renders this stub inside its animation div.
vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ id }: { id: string }) => <div data-testid="terminal-pane" data-session-id={id} />,
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
          params: { surface: '2', confirmation: { mode: 'dangerously' } },
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

    const saved = fake.getState() as { version?: number; layout?: unknown; lathLayout?: { version?: number; leafMeta?: Record<string, unknown> } } | null;
    expect(saved).not.toBeNull();
    expect(saved!.version).toBe(3);
    expect(saved!.layout).toBeUndefined();
    expect(saved!.lathLayout).toBeDefined();
    expect(saved!.lathLayout!.version).toBe(1);
    // The surviving pane is present in the Lath layout's leaf meta.
    expect(Object.keys(saved!.lathLayout!.leafMeta ?? {})).toContain('pane-a');
  });
});
