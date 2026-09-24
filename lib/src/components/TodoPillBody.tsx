import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { clsx } from 'clsx';
import type { TodoState } from '../lib/terminal-registry';
import { getTodoSpotlight, subscribeToTodoSpotlight } from '../lib/todo-spotlight';
import { animationClockStyle } from './alert-ring';

const FLOURISH_MS = 500;

/** The TODO pill's body, for a pill shell (`todo-pill-shell`). A grid-stacked
 *  <letters, check>, so the pill width stays stable across steady/flourishing
 *  states — the CSS drives the animation. */
export const TODO_PILL_BODY: ReactNode = (
  <span className="todo-pill-stack">
    <span className="todo-pill-stack__letters">TODO</span>
    <span className="todo-pill-stack__check" aria-hidden>✓</span>
  </span>
);

/**
 * Shared render body + flourish state for the TODO pill.
 *
 * Returns `visible: false` when the pill should not render at all.
 * Returns `flourishing: true` briefly after a TODO clears so the
 * caller can set `data-flourishing="true"` on its pill shell.
 */
export function useTodoPillContent(todo: TodoState): {
  visible: boolean;
  flourishing: boolean;
  body: ReactNode;
} {
  const [flourishing, setFlourishing] = useState(false);
  const prevRef = useRef<TodoState>(todo);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = todo;
    if (prev && !todo) {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setFlourishing(true);
      timerRef.current = setTimeout(() => {
        setFlourishing(false);
        timerRef.current = null;
      }, FLOURISH_MS);
    }
  }, [todo]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const visible = todo || flourishing;

  return { visible, flourishing, body: visible ? TODO_PILL_BODY : null };
}

/**
 * The landing spotlight's overlay, for a `relative` pill shell: rendered only
 * while the latest `spotlightTodo` signal names `surfaceId`, remounted per
 * signal so a repeat replays it. The pulse runs on the signal's clock, so a pill
 * that mounts long after lands past its end instead of replaying it; `className`
 * carries the pill's own extent and corners. The CSS (`.todo-spotlight` in
 * `theme.css`) animates it and drops it under reduced motion.
 */
export function TodoSpotlight({ surfaceId, className }: { surfaceId: string | undefined; className?: string }) {
  const spotlight = useSyncExternalStore(subscribeToTodoSpotlight, getTodoSpotlight);
  const mine = surfaceId !== undefined && spotlight?.surfaceId === surfaceId ? spotlight : null;
  // Anchored once per signal: recomputing the clock on a later render would
  // shove a live pulse back to its start.
  const style = useMemo(() => (mine ? animationClockStyle(mine.startedAt) : undefined), [mine]);
  if (!mine) return null;
  return (
    <span
      key={mine.seq}
      data-todo-spotlight={mine.seq}
      aria-hidden
      style={style}
      className={clsx('todo-spotlight pointer-events-none absolute bg-current/30', className)}
    />
  );
}
