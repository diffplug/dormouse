/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TodoSpotlight } from './TodoPillBody';
import { resetTodoSpotlight, spotlightTodo } from '../lib/todo-spotlight';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetTodoSpotlight();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Pills({ ids }: { ids: string[] }) {
  return <>{ids.map((id) => <span key={id} data-pill={id}><TodoSpotlight surfaceId={id} /></span>)}</>;
}

function spotlightIn(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-pill="${id}"] [data-todo-spotlight]`);
}

/** docs/specs/alert.md -> Pane Header: the landing spotlight. */
describe('TodoSpotlight', () => {
  it('plays on the Surface the latest signal names only, and replays on a repeat', () => {
    act(() => root.render(<Pills ids={['a', 'b']} />));
    expect(container.querySelector('[data-todo-spotlight]')).toBeNull();

    act(() => spotlightTodo('a'));
    const first = spotlightIn('a');
    expect(first).not.toBeNull();
    expect(first!.getAttribute('aria-hidden')).toBe('true');
    expect(spotlightIn('b')).toBeNull();

    // The same Surface again is a new signal: a fresh element, so the pulse restarts.
    act(() => spotlightTodo('a'));
    expect(spotlightIn('a')).not.toBeNull();
    expect(spotlightIn('a')).not.toBe(first);

    // A newer signal elsewhere ends this one.
    act(() => spotlightTodo('b'));
    expect(spotlightIn('a')).toBeNull();
    expect(spotlightIn('b')).not.toBeNull();
  });

  it('runs on the signal\'s clock, so a pill mounting later lands past its end', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    act(() => root.render(<Pills ids={['a']} />));
    act(() => spotlightTodo('a'));
    const pulse = spotlightIn('a')!;
    expect(pulse.style.animationDelay).toBe('0ms');

    // A later render must not shove the running pulse back to its start.
    now.mockReturnValue(1_200);
    act(() => root.render(<Pills ids={['a', 'b']} />));
    expect(spotlightIn('a')).toBe(pulse);
    expect(pulse.style.animationDelay).toBe('0ms');

    // Remounted (a Door scrolled back into view) long after: no replay.
    act(() => root.render(<Pills ids={[]} />));
    now.mockReturnValue(9_000);
    act(() => root.render(<Pills ids={['a']} />));
    expect(spotlightIn('a')!.style.animationDelay).toBe('-8000ms');
  });

  // jsdom applies no stylesheet, so the pulse and its gate are pinned where they live.
  it('rests invisible and drops the pulse under reduced motion', () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../theme.css'), 'utf8');
    expect(css).toMatch(/\.todo-spotlight \{\s*opacity: 0;\s*animation: todo-spotlight \d+ms/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.todo-spotlight \{ animation: none; \}/);
  });
});
