// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TerminalContextOverlay } from './TerminalContextOverlay';
import type { ContextPlacer, LathWallEngine } from './lath-wall-engine';
import type { ContextSide } from './terminal-context-placement';
import type { Rect } from '../../lib/lath/model';
import type { ContextMode } from './wall-context';
import { ensureResizeObserver } from './wall-test-utils';

const { rendered } = vi.hoisted(() => ({ rendered: vi.fn() }));
vi.mock('./TerminalContext', () => ({ TerminalContext: () => {
  rendered();
  return <section data-test-context><input aria-label="Aux terminal input" /></section>;
} }));
// The source's cursor sits in its top half.
vi.mock('../../lib/terminal-registry', () => ({ getTerminalInstance: () => ({ rows: 24, buffer: { active: { baseY: 0, cursorY: 1, viewportY: 0 } } }) }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
ensureResizeObserver();

it('places from painted frames without rerendering the aux terminal or snapping back on unrelated renders', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const source = { x: 0, y: 0, width: 500, height: 600 };
  let placer: ContextPlacer | null = null;
  const lath = {
    animator: { framesAt: () => new Map([['source', { rect: source }]]) },
    setContextPlacer: (next: ContextPlacer | null) => { placer = next; },
    notifyFrames: vi.fn(),
  } as unknown as LathWallEngine;
  const paint = (rect: Rect) => placer!(new Map([['source', { rect, opacity: 1, layer: 0 }]]));
  const preferences = new Map<string, ContextSide>();
  const render = (title: string, closing?: boolean, mode: ContextMode = 'aux') => act(() => root.render(<TerminalContextOverlay
    context={{ id: 'source', closing }} mode={mode} title={title} tool={false}
    wall={{ x: 0, y: 0, width: 1200, height: 800 }} source={source}
    multiPane lath={lath} preferences={preferences} />));
  try {
    render('Original');
    const aux = container.querySelector('[data-test-context]')!;
    const host = aux.parentElement!;
    const input = aux.querySelector('input')!;
    act(() => input.focus());
    input.value = 'unfinished command';
    const renders = rendered.mock.calls.length;
    expect(host.style.left).toBe('490px');
    let published: ReturnType<ContextPlacer> = null;
    act(() => { published = paint({ ...source, width: 550 }); });
    expect(published).toEqual({ sourceId: 'source', element: host, side: 'right' });
    expect(host.style.left).toBe('540px');
    expect(host.style.width).toBe('550px');
    expect(rendered).toHaveBeenCalledTimes(renders);
    render('New source title');
    expect(host.style.left).toBe('540px');
    expect(host.style.width).toBe('550px');
    expect(container.querySelector('[data-test-context]')).toBe(aux);
    expect(input.value).toBe('unfinished command');
    expect(document.activeElement).toBe(input);
    // Properties are only as tall as their rows, kept to the top beside a source on the right.
    render('New source title', false, 'properties');
    expect(host.style.left).toBe('540px');
    expect(host.style.height).toBe('');
    expect(host.style.maxHeight).toBe('600px');
    expect(host.style.transform).toBe('');
    expect(container.querySelector('[data-test-context]')).toBe(aux);
    render('New source title', false, 'aux');
    expect(host.style.height).toBe('600px');
    expect(host.style.maxHeight).toBe('');
    render('New source title', true);
    act(() => { published = paint(source); });
    expect(published).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
  expect(placer).toBeNull();
});

/** A root and an engine whose last paint left the source at `source`, torn down after `run`. */
function withOverlay(source: Rect, run: (root: Root, container: HTMLElement, lath: LathWallEngine) => void) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const lath = {
    animator: { framesAt: () => new Map([['source', { rect: source }]]) },
    setContextPlacer: () => {},
    notifyFrames: vi.fn(),
  } as unknown as LathWallEngine;
  try { run(root, container, lath); } finally {
    act(() => root.unmount());
    container.remove();
  }
}

it('keeps properties above their source on the edge their teeth share with it', () => {
  // Only the band above has room.
  const source = { x: 0, y: 500, width: 1200, height: 300 };
  withOverlay(source, (root, container, lath) => {
    act(() => root.render(<TerminalContextOverlay context={{ id: 'source' }} mode="properties" tool={false}
      wall={{ x: 0, y: 0, width: 1200, height: 800 }} source={source} multiPane lath={lath} preferences={new Map()} />));
    const host = container.querySelector<HTMLElement>('[data-test-context]')!.parentElement!;
    expect(host.style.top).toBe('510px');
    expect(host.style.transform).toBe('translateY(-100%)');
    expect(host.style.height).toBe('');
  });
});

it('covers its source from the top, except for `!`, which keeps clear of the cursor', () => {
  const source = { x: 0, y: 0, width: 1200, height: 800 };
  withOverlay(source, (root, container, lath) => {
    const top = (context: { id: string; keyboard?: boolean }, mode: ContextMode) => {
      act(() => root.render(<TerminalContextOverlay key={JSON.stringify([context, mode])} context={context} mode={mode} tool={false}
        wall={source} source={source} multiPane={false} lath={lath} preferences={new Map()} />));
      return container.querySelector<HTMLElement>('[data-test-context]')!.parentElement!.style.top;
    };
    expect(top({ id: 'source' }, 'aux')).toBe('0px');
    expect(top({ id: 'source', keyboard: true }, 'properties')).toBe('0px');
    expect(top({ id: 'source', keyboard: true }, 'aux')).toBe('400px');
  });
});

it('opens properties above a source with room only below, though a remembered side was below', () => {
  const source = { x: 0, y: 0, width: 1200, height: 396 };
  withOverlay(source, (root, _container, lath) => {
    let placer: ContextPlacer | null = null;
    const render = (key: string, mode: ContextMode, preferences = new Map<string, ContextSide>()) => {
      act(() => root.render(<TerminalContextOverlay key={key} context={{ id: 'source' }} mode={mode} tool={false}
        wall={{ x: 0, y: 0, width: 1200, height: 800 }} source={source} multiPane lath={{ ...lath, setContextPlacer: (next: ContextPlacer | null) => { placer = next; } } as LathWallEngine} preferences={preferences} />));
      return placer!(new Map())?.side;
    };
    const remembered = () => new Map<string, ContextSide>([['source', 'bottom']]);
    expect(render('aux', 'aux', remembered())).toBe('bottom');
    expect(render('properties', 'properties', remembered())).toBe('top');
    // A terminal below that switches to properties stays below.
    expect(render('switch', 'aux')).toBe('bottom');
    expect(render('switch', 'properties')).toBe('bottom');
  });
});
