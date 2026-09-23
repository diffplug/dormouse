// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TerminalContextOverlay } from './TerminalContextOverlay';
import type { LathWallEngine } from './lath-wall-engine';
import type { ContextSide } from './terminal-context-placement';

const { rendered } = vi.hoisted(() => ({ rendered: vi.fn() }));
vi.mock('./TerminalContext', () => ({ TerminalContext: () => {
  rendered();
  return <section data-test-context><input aria-label="Helper input" /></section>;
} }));
vi.mock('../../lib/terminal-registry', () => ({ getTerminalInstance: () => null }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('tracks animation without rerendering the helper or snapping back on unrelated renders', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const source = { x: 0, y: 0, width: 500, height: 600 };
  let painted = source;
  const listeners = new Set<() => void>();
  const lath = {
    animator: { framesAt: () => new Map([['source', { rect: painted }]]) },
    subscribeFrames: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } as unknown as LathWallEngine;
  const preferences = new Map<string, ContextSide>();
  const render = (title: string) => act(() => root.render(<TerminalContextOverlay
    context={{ id: 'source' }} title={title} tool={false}
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
    painted = { ...source, width: 550 };
    act(() => { for (const notify of listeners) notify(); });
    expect(host.style.left).toBe('534px');
    expect(host.style.width).toBe('550px');
    expect(rendered).toHaveBeenCalledTimes(renders);
    render('New source title');
    expect(host.style.left).toBe('534px');
    expect(host.style.width).toBe('550px');
    expect(container.querySelector('[data-test-context]')).toBe(helper);
    expect(input.value).toBe('unfinished command');
    expect(document.activeElement).toBe(input);
    expect(container.querySelector<HTMLElement>('[data-context-source]')!.style.width).toBe('550px');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
  expect(listeners.size).toBe(0);
});
