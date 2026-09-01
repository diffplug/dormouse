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
import { sessionForKey } from 'dor-lib-common/agent-browser';
import { Wall } from './Wall';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import type { PlatformAdapter } from '../lib/platform/types';
import * as terminalRegistry from '../lib/terminal-registry';
import { UNNAMED_PANEL_TITLE } from '../lib/terminal-registry';
import { pendingShellOpts } from '../lib/terminal-store';
import { setToolsEnabled } from '../lib/feature-flags';

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

  it('validates a dor await and parks it on the host alert manager', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();

    // These hand-built events carry no `signal`, like every other control request
    // in this file — the await handler has to tolerate that.
    type AwaitResult = { ok: boolean; error?: string; result?: Record<string, unknown> };
    const request = (params: Record<string, unknown>): Promise<AwaitResult> => new Promise((resolve) => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.await,
          params,
          respond: (r: AwaitResult) => resolve(r),
        },
      }));
    });

    // The wake condition and the ceiling are both rejected before anything parks.
    let invalidUntil: AwaitResult | undefined;
    await act(async () => { invalidUntil = await request({ surface: 'surface:1', until: 'soon', timeoutMs: 5 }); });
    expect(invalidUntil).toEqual({ ok: false, error: "invalid await condition 'soon'" });

    const ceilingError = 'timeoutMs must be a positive number no greater than 86400000';

    let noCeiling: AwaitResult | undefined;
    await act(async () => { noCeiling = await request({ surface: 'surface:1', until: 'quiet' }); });
    expect(noCeiling).toEqual({ ok: false, error: ceilingError });

    // Above the 24h cap the ceiling would overflow `setTimeout`'s signed 32-bit
    // delay and fire at once, so it is refused rather than silently instant.
    let hugeCeiling: AwaitResult | undefined;
    await act(async () => { hugeCeiling = await request({ surface: 'surface:1', until: 'quiet', timeoutMs: 3_000_000_000 }); });
    expect(hugeCeiling).toEqual({ ok: false, error: ceilingError });

    // A real park against the fake adapter's AlertManager. Nothing is running, so
    // the 5ms ceiling beats the 2s grace window and the host reports `timeout` —
    // with its own measurement of the wait, which the handler passes through.
    let timedOut: AwaitResult | undefined;
    await act(async () => { timedOut = await request({ surface: 'surface:1', until: 'quiet', timeoutMs: 5 }); });
    expect(timedOut?.ok).toBe(true);
    expect(timedOut?.result).toMatchObject({
      workspaceRef: 'workspace:1',
      surfaceRef: 'surface:1',
      outcome: 'timeout',
    });
    expect(timedOut?.result?.cause).toBeUndefined();
    expect(typeof timedOut?.result?.waitedMs).toBe('number');
  });

  it('parks a minimized browser surface so its DOM survives, and unparks it on kill', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'pane-a');

    try {
      const surfaceId = (await dispatchIframe('http://localhost:5173/')).id;
      const leaf0 = container.querySelector(`[data-lath-leaf="${surfaceId}"]`);
      expect(leaf0).toBeTruthy();

      const minimize = leaf0!.querySelector<HTMLElement>('[aria-label="Minimize"]');
      expect(minimize).toBeTruthy();
      await act(async () => { minimize!.click(); });
      await flush();

      // Minimized, but NOT unmounted: the same node stays in place with its document
      // (an <iframe>'s state) intact, which is the whole reason browser Surfaces park
      // instead of being removed (docs/specs/tiling-engine.md → "Parked leaves").
      const parked = container.querySelector(`[data-lath-leaf="${surfaceId}"]`);
      expect(parked).toBe(leaf0);
      expect((parked as HTMLElement).dataset.lathParked).toBe('');
      // It is a door now, so it is not a visible pane.
      expect(container.querySelectorAll('[data-lath-leaf]:not([data-lath-parked])').length).toBe(1);

      // Killing the door releases the Surface for real — the parked DOM goes with it.
      expect((await dispatchKill(surfaceId))?.ok).toBe(true);
      expect(container.querySelector(`[data-lath-leaf="${surfaceId}"]`)).toBeNull();
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('reuses and closes a parked browser that gains its session after minimization', async () => {
    const defaultSession = sessionForKey('default');
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    let resolveOpen!: (result: { exitCode: number; stdout: string; stderr: string }) => void;
    const openResult = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      resolveOpen = resolve;
    });
    const agentBrowserCommand = vi.fn(async (_session: string, args: string[]) => {
      if (args[0] === 'open') return openResult;
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    (fake as PlatformAdapter).agentBrowserCommand = agentBrowserCommand;
    (fake as PlatformAdapter).agentBrowserStreamStatus = vi.fn(async () => ({ ok: true, wsPort: 4321 }));

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
      });
      await flush();
      if (!fake.hasPty('pane-a')) fake.spawnPty('pane-a');
      fake.setOpenPorts('pane-a', [{
        protocol: 'tcp',
        family: 'IPv4',
        address: '127.0.0.1',
        port: 5173,
        pid: 100,
        processName: 'vite',
      }]);

      // The context-menu path creates an eager, session-less browser before its
      // asynchronous daemon boot completes.
      const header = container.querySelector<HTMLElement>('[data-pane-header-for="pane-a"]')!;
      await act(async () => {
        header.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }));
      });
      await flush();
      const portRow = document.querySelector<HTMLButtonElement>(
        '[data-pane-context-menu-for="pane-a"] button[data-port-entry="5173"]',
      )!;
      await act(async () => { portRow.click(); });
      await flush();

      const browserLeaf = Array.from(container.querySelectorAll<HTMLElement>('[data-lath-leaf]'))
        .find((leaf) => leaf.dataset.lathLeaf !== 'pane-a')!;
      const browserId = browserLeaf.dataset.lathLeaf!;
      await act(async () => {
        browserLeaf.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!.click();
      });
      await flush();
      expect(container.querySelector(`[data-lath-leaf="${browserId}"]`)?.hasAttribute('data-lath-parked')).toBe(true);

      // Until the boot names it, `dor ab --surface` has nothing to drive.
      expect(await dispatchResolveAgentBrowser(browserId)).toEqual({
        ok: false,
        error: `surface 'surface:2' has no agent-browser session yet`,
      });

      // Boot completion writes `session` only to live parked metadata. The Door
      // record is intentionally still the session-less minimize-time snapshot.
      await act(async () => {
        resolveOpen({ exitCode: 0, stdout: '', stderr: '' });
        await openResult;
      });
      await flush();

      let reused: { ok: boolean; result?: { status: string; surfaceId: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.agentBrowser,
            params: { session: defaultSession, surface: 'surface:1' },
            respond: (r: typeof reused) => { reused = r; },
          },
        }));
      });
      await flush();
      expect(reused).toMatchObject({ ok: true, result: { status: 'existing', surfaceId: browserId } });
      expect(container.querySelectorAll('[data-door-id]')).toHaveLength(1);

      expect((await dispatchKill(browserId))?.ok).toBe(true);
      expect(agentBrowserCommand).toHaveBeenCalledWith(defaultSession, ['close'], undefined);
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('resolves a browser surface handle to its agent-browser session, and gates the rest', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    (fake as PlatformAdapter).agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
      });
      await flush();

      // An ab-rendered surface bound to a GUI-minted session — the name no
      // `--key` can produce, which is the point of addressing by handle.
      const abId = await dispatchAgentBrowser({ session: 'dormouse.1.gui-a1b2c3', surface: 'surface:1' });
      const iframeRef = (await dispatchIframe('http://localhost:5173/')).ref;

      expect(await dispatchResolveAgentBrowser(abId)).toEqual({
        ok: true,
        result: { surfaceId: abId, surfaceRef: 'surface:2', session: 'dormouse.1.gui-a1b2c3' },
      });
      // A parked ab surface keeps its daemon session, so a minimized target resolves.
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`[data-lath-leaf="${abId}"] [aria-label="Minimize"]`)!.click();
      });
      await flush();
      expect(await dispatchResolveAgentBrowser(abId)).toMatchObject({ ok: true });

      // Gate 1: a terminal has no browser at all.
      expect(await dispatchResolveAgentBrowser('surface:1')).toEqual({
        ok: false,
        error: "surface 'surface:1' has no browser (kind: terminal)",
      });
      // Gate 2: an iframe renderer has a browser but no agent-browser session.
      expect(await dispatchResolveAgentBrowser(iframeRef)).toEqual({
        ok: false,
        error: `surface '${iframeRef}' is not agent-browser rendered (render_mode: iframe)`,
      });
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('drags a parked browser out with its current metadata', async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON() {},
    }) as DOMRect;
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    const agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    (fake as PlatformAdapter).agentBrowserCommand = agentBrowserCommand;

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
      });
      await flush();
      const browserId = await dispatchAgentBrowser({
        session: 'browser-session',
        binaryPath: '/old/agent-browser',
        surface: 'surface:1',
      });
      const browserLeaf = container.querySelector<HTMLElement>(`[data-lath-leaf="${browserId}"]`)!;
      await act(async () => {
        browserLeaf.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!.click();
      });
      await flush();

      // Refresh only the live parked metadata; the Door snapshot retains the old
      // binary path, making teardown after drag-out expose which copy was restored.
      expect(await dispatchAgentBrowser({
        session: 'browser-session',
        binaryPath: '/new/agent-browser',
        surface: 'surface:1',
      })).toBe(browserId);

      const door = container.querySelector<HTMLElement>(`[data-door-id="${browserId}"]`)!;
      await act(async () => {
        door.dispatchEvent(new MouseEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 100,
          clientY: 650,
        }));
      });
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 5, clientY: 300 }));
      });
      await flushFrame();
      act(() => {
        window.dispatchEvent(new MouseEvent('pointerup'));
      });
      await flush();
      expect(container.querySelector(`[data-door-id="${browserId}"]`)).toBeNull();
      expect(container.querySelector(`[data-lath-leaf="${browserId}"]`)?.hasAttribute('data-lath-parked')).toBe(false);

      await dispatchKill(browserId);
      expect(agentBrowserCommand).toHaveBeenCalledWith(
        'browser-session',
        ['close'],
        '/new/agent-browser',
      );
    } finally {
      untouchedSpy.mockRestore();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  it('removes a minimized terminal outright — only DOM-resident surfaces park', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />);
    });
    await flush();
    expect(leafCount()).toBe(2);

    const leafA = container.querySelector('[data-lath-leaf="pane-a"]')!;
    const minimize = leafA.querySelector<HTMLElement>('[aria-label="Minimize"]');
    expect(minimize).toBeTruthy();
    await act(async () => { minimize!.click(); });
    await flush();

    // A terminal's state lives in the PTY and replays on reattach, so parking it
    // would only cost memory.
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).toBeNull();
    expect(leafCount()).toBe(1);
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

  it('requires confirmation before killing an untouched tool', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'tool-a');
    try {
      await act(async () => {
        root.render(<Wall
          restoredLathLayout={{
            version: 1,
            tree: { root: { kind: 'leaf', id: 'tool-a' } },
            leafMeta: {
              'tool-a': {
                component: 'tool',
                tabComponent: 'tool',
                title: 'storybook',
                params: {
                  surfaceType: 'tool',
                  command: 'pnpm storybook',
                  cwd: '/repo',
                  toolName: 'storybook',
                  toolRender: 'iframe',
                  toolPort: 'announced',
                },
              },
            },
          }}
          initialMode="command"
          showBaseboard
        />);
      });
      await flush();

      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-lath-leaf="tool-a"] [aria-label="Kill"]')!.click();
      });
      await flush();

      expect(container.textContent).toContain('Confirm kill');
      expect(container.querySelector('[data-lath-leaf="tool-a"]')).not.toBeNull();
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('does not shell-replace an untouched tool', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'tool-a');
    try {
      await act(async () => {
        root.render(<Wall
          restoredLathLayout={{
            version: 1,
            tree: { root: { kind: 'leaf', id: 'tool-a' } },
            leafMeta: {
              'tool-a': {
                component: 'tool',
                tabComponent: 'tool',
                title: 'storybook',
                params: {
                  surfaceType: 'tool',
                  command: 'pnpm storybook',
                  cwd: '/repo',
                  toolName: 'storybook',
                  toolRender: 'iframe',
                  toolPort: 'announced',
                },
              },
            },
          }}
          initialMode="command"
          showBaseboard
        />);
      });
      await flush();

      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:new-terminal', {
          detail: { name: 'zsh', replaceUntouched: true },
        }));
      });
      await flush();

      expect(container.querySelector('[data-lath-leaf="tool-a"]')).not.toBeNull();
      expect(leafCount()).toBe(2);
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

  it('keeps an approved tool deferred until trust lookup and shell staging finish', async () => {
    setToolsEnabled(true);
    let toolId: string | undefined;
    const trustGate = Promise.withResolvers<{ status: 'trust-recorded' }>();
    const resolvedGate = Promise.withResolvers<{
      status: 'ok';
      projectRoot: string;
      path: string;
      name: string;
      run: string;
      render: 'iframe';
      port: 'announced';
      key: null;
      warnings: string[];
    }>();
    const toolControl = vi.fn((request: { op: 'lookup' | 'trust' }) => {
      if (request.op === 'trust') return trustGate.promise;
      if (toolControl.mock.calls.length === 1) {
        return Promise.resolve({
          status: 'untrusted' as const,
          projectRoot: '/repo',
          path: '/repo/dormouse.yml',
          name: 'storybook',
          run: 'pnpm storybook',
          upstreamUrl: null,
        });
      }
      return resolvedGate.promise;
    });
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = toolControl;

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
      });
      await flush();

      let response: { ok: boolean; result?: { surfaceId: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();
      expect(response?.ok).toBe(true);
      toolId = response!.result!.surfaceId;
      expect(container.querySelector(`[data-session-id="${toolId}"]`)).toBeNull();

      const allow = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Always allow for folder'));
      expect(allow).toBeDefined();
      await act(async () => {
        allow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        allow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(toolControl.mock.calls.filter(([request]) => request.op === 'trust')).toHaveLength(1);
      expect(container.querySelector(`[data-session-id="${toolId}"]`)).toBeNull();

      await act(async () => { trustGate.resolve({ status: 'trust-recorded' }); });
      await flush();
      expect(container.querySelector(`[data-session-id="${toolId}"]`)).toBeNull();

      await act(async () => {
        resolvedGate.resolve({
          status: 'ok',
          projectRoot: '/repo',
          path: '/repo/dormouse.yml',
          name: 'storybook',
          run: 'pnpm storybook',
          render: 'iframe',
          port: 'announced',
          key: null,
          warnings: [],
        });
      });
      await flush();
      expect(container.querySelector(`[data-session-id="${toolId}"]`)).not.toBeNull();
      expect(pendingShellOpts.get(toolId)?.untouched).toBe(true);
    } finally {
      if (toolId) pendingShellOpts.delete(toolId);
      setToolsEnabled(false);
    }
  });

  it('starts an approved tool before applying its deferred minimize', async () => {
    setToolsEnabled(true);
    let toolId: string | undefined;
    let consumedOpts: (typeof pendingShellOpts extends Map<string, infer T> ? T : never) | undefined;
    const getTerminalSpy = vi.spyOn(terminalRegistry, 'getOrCreateTerminal').mockImplementation((id) => {
      consumedOpts = pendingShellOpts.get(id);
      pendingShellOpts.delete(id);
      fake.spawnPty(id);
      return {} as ReturnType<typeof terminalRegistry.getOrCreateTerminal>;
    });
    let lookupCount = 0;
    const toolControl = vi.fn(async (request: { op: 'lookup' | 'trust' }) => {
      if (request.op === 'trust') return { status: 'trust-recorded' as const };
      lookupCount += 1;
      if (lookupCount === 1) {
        return {
          status: 'untrusted' as const,
          projectRoot: '/repo',
          path: '/repo/dormouse.yml',
          name: 'storybook',
          run: 'pnpm storybook',
          upstreamUrl: null,
        };
      }
      return {
        status: 'ok' as const,
        projectRoot: '/repo',
        path: '/repo/dormouse.yml',
        name: 'storybook',
        run: 'pnpm storybook',
        render: 'iframe' as const,
        port: 'announced' as const,
        key: null,
        warnings: [],
      };
    });
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = toolControl;

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
      });
      await flush();

      let response: { ok: boolean; result?: { surfaceId: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            params: { name: 'storybook', cwd: '/repo', minimized: true, fresh: false },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();
      toolId = response!.result!.surfaceId;
      expect(fake.hasPty(toolId)).toBe(false);

      const allow = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Always allow for folder'))!;
      await act(async () => { allow.click(); });
      await flush();

      expect(fake.hasPty(toolId)).toBe(true);
      expect(getTerminalSpy).toHaveBeenCalledWith(toolId);
      expect(consumedOpts).toMatchObject({ cwd: '/repo', command: 'pnpm storybook', untouched: true });
      expect(pendingShellOpts.has(toolId)).toBe(false);
      expect(container.querySelector(`[data-door-id="${toolId}"]`)).not.toBeNull();
      expect(container.querySelector(`[data-lath-leaf="${toolId}"]`)?.hasAttribute('data-lath-parked')).toBe(true);
    } finally {
      if (toolId && fake.hasPty(toolId)) act(() => fake.killPty(toolId));
      getTerminalSpy.mockRestore();
      setToolsEnabled(false);
    }
  });

  it('reveals a pending approval created against a minimized reference', async () => {
    setToolsEnabled(true);
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = vi.fn(async () => ({
      status: 'untrusted' as const,
      projectRoot: '/repo',
      path: '/repo/dormouse.yml',
      name: 'storybook',
      run: 'pnpm storybook',
      upstreamUrl: null,
    }));

    try {
      await act(async () => {
        root.render(
          <Wall
            initialPaneIds={['pane-a']}
            initialDoors={[{ id: 'reference-door', title: 'Reference' }]}
            initialMode="command"
            showBaseboard
          />,
        );
      });
      await flush();

      let response: { ok: boolean; result?: { surfaceId: string; minimized: boolean } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            params: {
              name: 'storybook',
              cwd: '/repo',
              surface: 'surface:2',
              minimized: false,
              fresh: false,
            },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();

      expect(response).toMatchObject({ ok: true, result: { minimized: false } });
      const toolId = response!.result!.surfaceId;
      expect(container.querySelector(`[data-door-id="${toolId}"]`)).toBeNull();
      expect(container.querySelector(`[data-lath-leaf="${toolId}"]`)?.hasAttribute('data-lath-parked')).toBe(false);
      expect(container.textContent).toContain('Always allow for folder');
    } finally {
      setToolsEnabled(false);
    }
  });

  it('reports a reused pending tool as visible after reattaching it', async () => {
    setToolsEnabled(true);
    const toolId = 'pending-tool-door';
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = vi.fn(async () => ({
      status: 'untrusted' as const,
      projectRoot: '/repo',
      path: '/repo/dormouse.yml',
      name: 'storybook',
      run: 'pnpm storybook',
      upstreamUrl: null,
    }));

    try {
      await act(async () => {
        root.render(
          <Wall
            initialPaneIds={['pane-a']}
            initialDoors={[{
              id: toolId,
              title: 'storybook',
              component: 'tool',
              tabComponent: 'tool',
              params: {
                surfaceType: 'tool',
                command: 'pnpm storybook',
                cwd: '/repo',
                toolName: 'storybook',
                toolPending: {
                  name: 'storybook',
                  run: 'pnpm storybook',
                  path: '/repo/dormouse.yml',
                  projectRoot: '/repo',
                  cwd: '/repo',
                  minimized: false,
                  upstreamUrl: null,
                },
              },
            }]}
            initialMode="command"
            showBaseboard
          />,
        );
      });
      await flush();
      expect(container.querySelector(`[data-door-id="${toolId}"]`)).not.toBeNull();

      let response: { ok: boolean; result?: { status: string; surfaceId: string; minimized: boolean } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();

      expect(response).toMatchObject({
        ok: true,
        result: { status: 'pending', surfaceId: toolId, minimized: false },
      });
      expect(container.querySelector(`[data-door-id="${toolId}"]`)).toBeNull();
      expect(container.querySelector(`[data-lath-leaf="${toolId}"]`)).not.toBeNull();
    } finally {
      setToolsEnabled(false);
    }
  });

  it('reports a reused minimized tool as visible after reattaching it', async () => {
    setToolsEnabled(true);
    const toolId = 'tool-door';
    terminalRegistry.applyTerminalSemanticEvents(toolId, [
      { type: 'commandLine', commandLine: 'pnpm storybook' },
      { type: 'commandStart' },
    ]);
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = vi.fn(async () => ({
      status: 'ok' as const,
      projectRoot: '/repo',
      path: '/repo/dormouse.yml',
      name: 'storybook',
      run: 'pnpm storybook',
      render: 'iframe' as const,
      port: 'announced' as const,
      key: ['/repo'],
      warnings: [],
    }));

    try {
      await act(async () => {
        root.render(
          <Wall
            initialPaneIds={['pane-a']}
            initialDoors={[{
              id: toolId,
              title: 'storybook',
              component: 'tool',
              tabComponent: 'tool',
              params: {
                surfaceType: 'tool',
                command: 'pnpm storybook',
                cwd: '/repo',
                toolName: 'storybook',
                toolRender: 'iframe',
                toolPort: 'announced',
                toolKey: ['storybook', '/repo'],
              },
            }]}
            initialMode="command"
            showBaseboard
          />,
        );
      });
      await flush();
      expect(container.querySelector(`[data-door-id="${toolId}"]`)).not.toBeNull();

      let response: { ok: boolean; result?: { status: string; surfaceId: string; minimized: boolean } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();

      expect(response).toMatchObject({
        ok: true,
        result: { status: 'existing', surfaceId: toolId, minimized: false },
      });
      expect(container.querySelector(`[data-door-id="${toolId}"]`)).toBeNull();
      expect(container.querySelector(`[data-lath-leaf="${toolId}"]`)).not.toBeNull();
    } finally {
      act(() => terminalRegistry.removeTerminalPaneState(toolId));
      setToolsEnabled(false);
    }
  });

  // Pane take-over: `dor tool` typed alone at a prompt runs in that pane rather
  // than splitting (docs/specs/dor-tool.md -> Take-over). The handshake is the
  // point — `dor` is the pane's foreground process when the host answers, so the
  // command may only be typed once its own shell is back at a prompt.
  it('takes over the calling pane when `dor tool` is typed alone at a prompt', async () => {
    setToolsEnabled(true);
    const typed: string[] = [];
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = vi.fn(async () => ({
      status: 'ok' as const,
      projectRoot: '/repo',
      path: '/repo/dormouse.yml',
      name: 'storybook',
      run: 'pnpm storybook',
      render: 'iframe' as const,
      port: 'announced' as const,
      key: ['/repo'],
      warnings: [],
    }));

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
      });
      await flush();
      act(() => fake.spawnPty('pane-a'));
      fake.setInputHandler('pane-a', (data) => typed.push(data));
      terminalRegistry.seedTerminalManualCwd('pane-a', '/repo');
      terminalRegistry.applyTerminalSemanticEvents('pane-a', [
        { type: 'commandLine', commandLine: 'dor tool storybook' },
        { type: 'commandStart', source: 'osc633_boundaries' },
      ]);

      let response: { ok: boolean; result?: { status: string; surfaceId: string; minimized: boolean } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            surfaceId: 'pane-a',
            params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();

      // Answered before the tool starts, and nothing typed while `dor` still owns
      // the shell: waiting for the prompt first would deadlock.
      expect(response).toMatchObject({
        ok: true,
        result: { status: 'takeover', surfaceId: 'pane-a', minimized: false },
      });
      expect(leafCount()).toBe(1);
      expect(typed).toEqual([]);

      // `dor` exits; the shell reports its prompt back and the command lands.
      act(() => {
        terminalRegistry.applyTerminalSemanticEvents('pane-a', [{ type: 'promptStart' }]);
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
      expect(typed).toEqual(['pnpm storybook\r']);
      expect(leafCount()).toBe(1);

      // Same Surface, now a tool: the leaf changed kind without changing id, so
      // the session persists as one.
      act(() => {
        terminalRegistry.applyTerminalSemanticEvents('pane-a', [
          { type: 'commandLine', commandLine: 'pnpm storybook' },
          { type: 'commandStart', source: 'osc633_boundaries' },
        ]);
      });
      // The spawn lock is held until the command is live; let the handler see it.
      await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
      await act(async () => { window.dispatchEvent(new Event('pagehide')); });
      await flush();
      await flush();
      const saved = fake.getState() as {
        panes?: Array<{ id: string; surfaceType?: string; command?: string }>;
      } | null;
      expect(saved?.panes?.find((pane) => pane.id === 'pane-a')).toMatchObject({
        surfaceType: 'tool',
        command: 'pnpm storybook',
      });
    } finally {
      fake.clearInputHandler('pane-a');
      act(() => terminalRegistry.removeTerminalPaneState('pane-a'));
      setToolsEnabled(false);
    }
  });

  it('splits instead of taking over when the caller is running something else', async () => {
    setToolsEnabled(true);
    const typed: string[] = [];
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = vi.fn(async () => ({
      status: 'ok' as const,
      projectRoot: '/repo',
      path: '/repo/dormouse.yml',
      name: 'storybook',
      run: 'pnpm storybook',
      render: 'iframe' as const,
      port: 'announced' as const,
      key: null,
      warnings: [],
    }));
    let splitId: string | undefined;

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
      });
      await flush();
      act(() => fake.spawnPty('pane-a'));
      fake.setInputHandler('pane-a', (data) => typed.push(data));
      terminalRegistry.seedTerminalManualCwd('pane-a', '/repo');
      // An agent's `dor tool` runs under the agent, so the pane reports that line.
      terminalRegistry.applyTerminalSemanticEvents('pane-a', [
        { type: 'commandLine', commandLine: 'claude' },
        { type: 'commandStart', source: 'osc633_boundaries' },
      ]);

      let response: { ok: boolean; result?: { status: string; surfaceId: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            surfaceId: 'pane-a',
            params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();
      // The split exists before its handle is reported: a created tool answers
      // only once the new shell reports OSC 633.
      expect(leafCount()).toBe(2);
      splitId = Array.from(container.querySelectorAll('[data-lath-leaf]'))
        .map((leaf) => leaf.getAttribute('data-lath-leaf')!)
        .find((id) => id !== 'pane-a');
      act(() => {
        terminalRegistry.applyTerminalSemanticEvents(splitId!, [{ type: 'promptStart' }]);
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 250)); });

      expect(response?.result).toMatchObject({ status: 'created', surfaceId: splitId });
      expect(typed).toEqual([]);
    } finally {
      if (splitId) {
        pendingShellOpts.delete(splitId);
        act(() => terminalRegistry.removeTerminalPaneState(splitId!));
      }
      fake.clearInputHandler('pane-a');
      act(() => terminalRegistry.removeTerminalPaneState('pane-a'));
      setToolsEnabled(false);
    }
  });

  it('rejects a non-integrated shell before offering tool approval', async () => {
    setToolsEnabled(true);
    terminalRegistry.setDefaultShellOpts({ shell: 'C:\\Windows\\System32\\cmd.exe' });
    const toolControl = vi.fn(async () => ({
      status: 'untrusted' as const,
      projectRoot: 'C:\\repo',
      path: 'C:\\repo\\dormouse.yml',
      name: 'storybook',
      run: 'pnpm storybook',
      upstreamUrl: null,
    }));
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = toolControl;

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
      });
      await flush();

      let response: { ok: boolean; error?: string } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            params: { name: 'storybook', cwd: 'C:\\repo', minimized: false, fresh: false },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();

      expect(response?.ok).toBe(false);
      expect(response?.error).toContain('requires OSC 633 shell integration');
      expect(container.textContent).not.toContain('Always allow for folder');
      expect(leafCount()).toBe(1);
    } finally {
      terminalRegistry.setDefaultShellOpts(null);
      setToolsEnabled(false);
    }
  });

  // A Door created by `dor split` against another Door is the one Surface that never
  // was a pane, so it exercises the store's `addDoor` registration rather than the
  // meta a minimize retains. Every Door reader goes through `lath.getMeta`, so a
  // missing entry shows up as a Door with no metadata.
  it('a Door born from `dor split` against another Door still has store metadata', async () => {
    const getTerminalSpy = vi
      .spyOn(terminalRegistry, 'getOrCreateTerminal')
      .mockImplementation(() => ({}) as ReturnType<typeof terminalRegistry.getOrCreateTerminal>);
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />);
    });
    await flush();

    try {
      // Minimize pane-a, then split against that Door — the new Surface goes straight
      // into the baseboard without ever being laid out.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
      });
      await flush();
      const bornId = await dispatchSplit({ surface: 'surface:1' });
      expect(leafCount()).toBe(1);

      // The persisted Door row is materialized from the store's meta, so a Door with
      // no store entry writes `component: undefined` — which `reconnect.ts` keys off
      // to decide what survives a restart.
      await act(async () => { window.dispatchEvent(new Event('pagehide')); });
      await flush();
      await flush();
      const saved = fake.getState() as {
        doors?: Array<{ id: string; title?: string; component?: string; tabComponent?: string }>;
      } | null;
      const bornDoor = saved?.doors?.find((door) => door.id === bornId);
      expect(bornDoor).toBeDefined();
      expect(bornDoor?.component).toBe('terminal');
      expect(bornDoor?.tabComponent).toBe('terminal');
      expect(bornDoor?.title).toBe(UNNAMED_PANEL_TITLE);
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

  /** `dor kill --dangerously` on one surface; returns the control response. */
  async function dispatchKill(surface: string): Promise<{ ok: boolean } | undefined> {
    let response: { ok: boolean } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.kill,
          params: { surface, confirmation: { mode: 'dangerously' } },
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();
    return response;
  }

  async function dispatchAgentBrowser(params: Record<string, unknown>): Promise<string> {
    let response: { ok: boolean; result?: { surfaceId?: string } } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.agentBrowser,
          params,
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();
    expect(response?.ok).toBe(true);
    return response!.result!.surfaceId!;
  }

  /** `dor iframe <url>`; returns the new surface's `{ id, ref }`. */
  async function dispatchIframe(url: string): Promise<{ id: string; ref: string }> {
    let response: { ok: boolean; result?: { surfaceId: string; surfaceRef: string } } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.iframe,
          params: { url },
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();
    expect(response?.ok).toBe(true);
    return { id: response!.result!.surfaceId, ref: response!.result!.surfaceRef };
  }

  /** `dor ab --surface <handle>`'s host half; returns the raw control response. */
  async function dispatchResolveAgentBrowser(surface: string): Promise<unknown> {
    let response: unknown;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.resolveAgentBrowser,
          params: { surface },
          respond: (r: unknown) => { response = r; },
        },
      }));
    });
    await flush();
    return response;
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

  it('keeps dor agent-browser focus-neutral but enters passthrough for a user port activation', async () => {
    const defaultSession = sessionForKey('default');
    const onEvent = vi.fn();
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);

    try {
      // The CLI arm creates Browser B without moving selection or keyboard input
      // away from the passthrough terminal.
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" showBaseboard onEvent={onEvent} />);
      });
      await flush();
      expect(focusOf('pane-a')).toBe('true');

      const browserId = await dispatchAgentBrowser({
        session: defaultSession,
        surface: 'surface:1',
      });
      expect(focusOf('pane-a')).toBe('true');

      // Return to command mode, then invoke the human right-click path. Even
      // from command mode, activating a port is an explicit focus request:
      // Browser B becomes selected in passthrough.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 1, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 2, bubbles: true }));
      });
      await flush();

      (fake as PlatformAdapter).agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      if (!fake.hasPty('pane-a')) fake.spawnPty('pane-a');
      fake.setOpenPorts('pane-a', [{
        protocol: 'tcp',
        family: 'IPv4',
        address: '127.0.0.1',
        port: 5173,
        pid: 100,
        processName: 'vite',
      }]);
      onEvent.mockClear();

      const header = container.querySelector<HTMLElement>('[data-pane-header-for="pane-a"]')!;
      await act(async () => {
        header.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }));
      });
      await flush();

      const portRow = document.querySelector<HTMLButtonElement>(
        '[data-pane-context-menu-for="pane-a"] button[data-port-entry="5173"]',
      );
      expect(portRow).not.toBeNull();
      await act(async () => {
        portRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flush();

      expect(onEvent).toHaveBeenCalledWith({ type: 'selectionChange', id: browserId, kind: 'pane' });
      expect(onEvent).toHaveBeenCalledWith({ type: 'modeChange', mode: 'passthrough' });
      expect((fake as PlatformAdapter).agentBrowserCommand).toHaveBeenCalledWith(
        defaultSession,
        ['open', 'http://localhost:5173/'],
        undefined,
      );
    } finally {
      untouchedSpy.mockRestore();
    }
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
