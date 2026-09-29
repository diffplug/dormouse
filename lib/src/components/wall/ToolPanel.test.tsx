// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolPanel } from './ToolPanel';
import * as browserController from './agent-browser-surface-controller';
import { commitPreviewTransition, PREVIEW_READY_FALLBACK_MS, PREVIEW_REVEAL_MS, resetPreviewTransitions } from '../../lib/preview-transition-store';
import { beginSlotSwitch } from './preview-transition';
import { WallActionsContext, type WallActions } from './wall-context';
import { stubWallActions } from './wall-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./TerminalPanel', () => ({
  TerminalPanel: () => <div data-testid="terminal">terminal</div>,
}));
vi.mock('./BrowserPanel', () => ({
  BrowserPanel: ({ parked, params, onReady }: { parked?: boolean; params?: Record<string, unknown>; onReady?: () => void }) => (
    // A click stands in for the renderer's first paint.
    <div data-testid="browser" data-parked={String(parked === true)} data-url={String(params?.url ?? '')} onClick={() => onReady?.()}>
      {params?.renderMode === 'agent-browser-screencast' && <canvas />}
      browser
    </div>
  ),
}));

const booting = { surfaceType: 'tool', command: 'pnpm storybook', cwd: '/repo' };
const serving = { ...booting, url: 'http://localhost:6006/', renderMode: 'iframe' };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function show(params: Record<string, unknown>, actions?: WallActions) {
  const panel = <ToolPanel id="p1" title="t" params={params} />;
  act(() => {
    root.render(actions ? <WallActionsContext.Provider value={actions}>{panel}</WallActionsContext.Provider> : panel);
  });
}

/** The wrapper the visibility is applied to. */
function half(testId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.closest<HTMLElement>('[data-tool-half]');
  if (!el) throw new Error(`no ${testId}`);
  return el;
}

describe('ToolPanel', () => {
  it('keeps both halves mounted, whichever is forward', () => {
    show(booting);
    expect(container.querySelector('[data-testid="terminal"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="browser"]')).not.toBeNull();
    show(serving);
    expect(container.querySelector('[data-testid="terminal"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="browser"]')).not.toBeNull();
  });

  it.each([
    ['terminal', booting],
    ['iframe', serving],
    ['agent-browser', { ...serving, renderMode: 'agent-browser-screencast' }],
  ])('hides the %s face with its Workspace or parked leaf and restores only the foreground face', (_face, params) => {
    show(params);
    const terminal = half('terminal');
    const browser = half('browser');
    container.style.visibility = 'hidden';
    expect(getComputedStyle(terminal).visibility).toBe('hidden');
    expect(getComputedStyle(browser).visibility).toBe('hidden');
    container.style.visibility = 'visible';
    expect(getComputedStyle('url' in params ? browser : terminal).visibility).toBe('visible');
    expect(getComputedStyle('url' in params ? terminal : browser).visibility).toBe('hidden');
  });

  it('hides with visibility, never display', () => {
    // A display:none container measures zero, so the fit addon would resize the
    // PTY to a degenerate size and reflow the output of the command still
    // running behind the browser.
    show(serving);
    const terminal = half('terminal');
    expect(terminal.style.visibility).toBe('hidden');
    expect(terminal.style.display).not.toBe('none');
    expect(terminal.hasAttribute('hidden')).toBe(false);
  });

  it('shows the terminal and hides the browser before the tool serves', () => {
    show(booting);
    expect(getComputedStyle(half('terminal')).visibility).toBe('visible');
    expect(half('browser').style.visibility).toBe('hidden');
  });

  it('shows the browser once serving', () => {
    show(serving);
    expect(half('terminal').style.visibility).toBe('hidden');
    expect(getComputedStyle(half('browser')).visibility).toBe('visible');
  });

  it('parks the browser while it is hidden, so a screencast stops decoding', () => {
    show(booting);
    expect(container.querySelector<HTMLElement>('[data-testid="browser"]')?.dataset.parked).toBe('true');
    show(serving);
    expect(container.querySelector<HTMLElement>('[data-testid="browser"]')?.dataset.parked).toBe('false');
  });

  it('keeps the hidden half out of the accessibility tree', () => {
    show(serving);
    expect(half('terminal').getAttribute('aria-hidden')).toBe('true');
    expect(half('browser').getAttribute('aria-hidden')).toBe('false');
  });
});

describe('the port-conflict face', () => {
  const conflicted = { surfaceType: 'tool', command: 'x', cwd: '/repo', toolPortConflict: [6006, 6007] };

  it('shows the conflict where the browser would have gone', () => {
    // With several ports there is nothing to frame, so the second half explains
    // why rather than sitting empty or framing a guess.
    show(conflicted);
    expect(half('terminal').style.visibility).toBe('hidden');
    expect(container.textContent).toContain('opened 2 ports');
    expect(container.textContent).toContain('localhost:6006');
    expect(container.textContent).toContain('localhost:6007');
  });

  it('mounts no browser for a conflict', () => {
    show(conflicted);
    expect(container.querySelector('[data-testid="browser"]')).toBeNull();
  });
});

describe('the pending-approval face', () => {
  const pending = {
    surfaceType: 'tool',
    command: 'pnpm storybook',
    cwd: '/repo',
    toolPending: {
      name: 'storybook',
      run: 'pnpm storybook',
      path: '/repo/dormouse.yml',
      projectRoot: '/repo',
      minimized: false,
      upstreamUrl: 'https://github.com/diffplug/dormouse',
    },
  };

  it('mounts no terminal, so no shell runs in an unapproved repo', () => {
    // The load-bearing assertion: both halves stay mounted for every other
    // face, and mounting TerminalPanel here would spawn a PTY before the human
    // has allowed anything.
    show(pending);
    expect(container.querySelector('[data-testid="terminal"]')).toBeNull();
    expect(container.querySelector('[data-testid="browser"]')).toBeNull();
  });

  it('names the command it is asking about', () => {
    show(pending);
    expect(container.textContent).toContain('dor tool storybook');
    expect(container.textContent).toContain('pnpm storybook');
  });

  it('offers the upstream and the folder', () => {
    show(pending);
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('upstream https://github.com/diffplug/dormouse'))).toBe(true);
    expect(labels.some((l) => l.includes('folder'))).toBe(true);
    expect(labels.some((l) => l.includes('Disallow and close'))).toBe(true);
  });

  it('omits the upstream button when git resolved no remote', () => {
    show({ ...pending, toolPending: { ...pending.toolPending, upstreamUrl: null } });
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('upstream'))).toBe(false);
    expect(labels.some((l) => l.includes('folder'))).toBe(true);
  });
});

describe('a preview slot switch', () => {
  const next = { ...serving, url: 'http://localhost:7007/' };
  const browsers = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="browser"]'));
  const layerOf = (element: Element) => element.closest<HTMLElement>('[data-browser-layer]')!;
  /** Begin on what `params` shows, with motion that is not instant. */
  const begin = (params: Record<string, unknown>) => {
    let token!: number;
    act(() => { token = beginSlotSwitch('p1', () => params)!; });
    return token;
  };
  const commit = (token: number) => act(() => {
    commitPreviewTransition('p1', token, { label: 'b.md', arm: () => () => {} });
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    act(() => resetPreviewTransitions());
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ramps the ghost\'s blur, then fades the new layer in over it', () => {
    show(serving);
    const [old] = browsers();
    const token = begin(serving);
    expect(layerOf(old).className).toContain('preview-ghost');
    expect(layerOf(old).className).not.toContain('preview-ghost-static');
    commit(token);
    show(booting);
    // Retired, the ghost keeps its frozen params and the terminal stays hidden.
    expect(old.dataset.url).toBe(serving.url);
    expect(half('terminal').style.visibility).toBe('hidden');
    show(next);
    const [ghost, incoming] = browsers();
    expect(ghost).toBe(old);
    expect(layerOf(incoming).className).toContain('opacity-0');
    act(() => incoming.click());
    expect(layerOf(incoming).className).toContain('preview-reveal');
    expect(old.isConnected).toBe(true);
    act(() => { vi.advanceTimersByTime(PREVIEW_REVEAL_MS); });
    expect(browsers()).toEqual([incoming]);
    expect(layerOf(incoming).className).not.toMatch(/opacity-0|preview-reveal/);
  });

  it('blurs the terminal face in place and fades a new browser in over it', () => {
    show(booting);
    const token = begin(booting);
    expect(half('terminal').className).toContain('preview-ghost');
    expect(half('terminal').hasAttribute('inert')).toBe(true);
    commit(token);
    show(next);
    expect(half('terminal').style.visibility).toBe('');
    expect(half('browser').style.visibility).toBe('');
    const [incoming] = browsers();
    expect(layerOf(incoming).className).toContain('opacity-0');
    act(() => incoming.click());
    act(() => { vi.advanceTimersByTime(PREVIEW_REVEAL_MS); });
    expect(half('terminal').style.visibility).toBe('hidden');
    expect(half('terminal').className).not.toContain('preview-ghost');
  });

  it('reveals the terminal over a browser ghost when the fallback ends a switch that never served', () => {
    show(serving);
    const [old] = browsers();
    commit(begin(serving));
    show(booting);
    act(() => { vi.advanceTimersByTime(PREVIEW_READY_FALLBACK_MS); });
    expect(half('terminal').className).toContain('preview-reveal');
    expect(half('terminal').style.visibility).toBe('');
    expect(old.isConnected).toBe(true);
    act(() => { vi.advanceTimersByTime(PREVIEW_REVEAL_MS); });
    expect(old.isConnected).toBe(false);
    expect(half('browser').style.visibility).toBe('hidden');
  });

  it('holds a screencast as a blurred copy of its controller\'s canvas', () => {
    const screencast = { ...serving, renderMode: 'agent-browser-screencast' };
    show(screencast);
    const canvas = container.querySelector('canvas')!;
    Object.assign(canvas, { width: 640, height: 360 });
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 320, height: 180 }) as DOMRect;
    vi.spyOn(browserController, 'getAgentBrowserSurfaceController')
      .mockImplementation(id => (id === 'p1' ? { frameCanvas: () => canvas } : null) as never);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as RenderingContext);
    begin(screencast);
    const copy = Array.from(container.querySelectorAll('canvas')).find(candidate => candidate !== canvas)!;
    expect(drawImage).toHaveBeenCalledWith(canvas, 0, 0);
    expect(copy.parentElement!.style.width).toBe('320px');
    expect(copy.parentElement!.parentElement!.className).toContain('preview-ghost');
    // The live screencast is hidden beneath it, not kept as the ghost.
    expect(layerOf(canvas).className).toContain('opacity-0');
  });

  it('selects the pane on a press over a ghost, which takes no input', () => {
    const actions = stubWallActions();
    show(booting, actions);
    const press = () => act(() => { half('terminal').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    press();
    expect(actions.onClickPanel).not.toHaveBeenCalled();
    begin(booting);
    press();
    expect(actions.onClickPanel).toHaveBeenCalledExactlyOnceWith('p1');
  });
});
