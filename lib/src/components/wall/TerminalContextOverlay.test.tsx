// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TerminalContextOverlay } from './TerminalContextOverlay';
import type { ContextPlacer, LathWallEngine } from './lath-wall-engine';
import type { ContextSide } from './terminal-context-placement';
import type { Rect } from '../../lib/lath/model';

const { rendered } = vi.hoisted(() => ({ rendered: vi.fn() }));
vi.mock('./TerminalContext', () => ({ TerminalContext: () => {
  rendered();
  return <section data-test-context><input aria-label="Helper input" /></section>;
} }));
vi.mock('../../lib/terminal-registry', () => ({ getTerminalInstance: () => null }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('places from painted frames without rerendering the helper or snapping back on unrelated renders', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const source = { x: 0, y: 0, width: 500, height: 600 };
  let placer: ContextPlacer | null = null;
  const lath = {
    animator: { framesAt: () => new Map([['source', { rect: source }]]) },
    setContextPlacer: (next: ContextPlacer | null) => { placer = next; },
  } as unknown as LathWallEngine;
  const paint = (rect: Rect) => placer!(new Map([['source', { rect, opacity: 1, layer: 0 }]]));
  const preferences = new Map<string, ContextSide>();
  const render = (title: string, closing?: boolean) => act(() => root.render(<TerminalContextOverlay
    context={{ id: 'source', closing }} title={title} tool={false}
    wall={{ x: 0, y: 0, width: 1200, height: 800 }} source={source}
    multiPane lath={lath} preferences={preferences} />));
  try {
    render('Original');
    const helper = container.querySelector('[data-test-context]')!;
    const host = helper.parentElement!;
    const input = helper.querySelector('input')!;
    act(() => input.focus());
    input.value = 'unfinished command';
    const renders = rendered.mock.calls.length;
    expect(host.style.left).toBe('484px');
    let published: ReturnType<ContextPlacer> = null;
    act(() => { published = paint({ ...source, width: 550 }); });
    expect(published).toEqual({ sourceId: 'source', element: host, side: 'right' });
    expect(host.style.left).toBe('534px');
    expect(host.style.width).toBe('550px');
    expect(rendered).toHaveBeenCalledTimes(renders);
    render('New source title');
    expect(host.style.left).toBe('534px');
    expect(host.style.width).toBe('550px');
    expect(container.querySelector('[data-test-context]')).toBe(helper);
    expect(input.value).toBe('unfinished command');
    expect(document.activeElement).toBe(input);
    render('New source title', true);
    act(() => { published = paint(source); });
    expect(published).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
  expect(placer).toBeNull();
});
