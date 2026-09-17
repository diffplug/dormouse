import { LATH_EASING, LATH_MOTION_MS } from '../lib/lath/animator';
import { motionIsInstant } from '../lib/ui-geometry';
import { workspaceTabElement } from './workspace-tab-elements';

const controllers = new Map<string, ReturnType<typeof createWorkspaceMotion>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function subscribeWorkspaceMotionFrames(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function collapseWorkspace(id: string): Promise<void> {
  return controllers.get(id)?.collapse() ?? Promise.resolve();
}

export function restoreWorkspaceMotion(id: string): void {
  controllers.get(id)?.expand(true);
}

export function workspaceIsCollapsed(id: string): boolean {
  return controllers.get(id)?.collapsed() ?? false;
}

/** Presentation only: the grid box stays full-size, so terminals never fit to
 * intermediate dimensions. The ring lives outside this transformed subtree. */
export function createWorkspaceMotion(element: HTMLElement, id: string) {
  let progress = 1;
  let raf: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete: (() => void) | undefined;
  let departing = false;
  let anchor = { x: 0, y: 0, sx: 1, sy: 1 };

  const paint = () => {
    if (progress === 1) {
      element.style.transform = '';
      element.style.transformOrigin = '';
      element.style.opacity = '';
    } else {
      const remainder = 1 - progress;
      element.style.transformOrigin = '0 0';
      element.style.transform = `translate(${anchor.x * remainder}px, ${anchor.y * remainder}px) scale(${anchor.sx + (1 - anchor.sx) * progress}, ${anchor.sy + (1 - anchor.sy) * progress})`;
      element.style.opacity = String(progress);
    }
    element.style.pointerEvents = departing ? 'none' : '';
    notify();
  };
  const cancel = () => {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    clearTimeout(timer);
    complete?.();
    complete = undefined;
  };
  const measure = () => {
    // Temporarily remove our own transform to measure the stable layout box.
    const transform = element.style.transform;
    element.style.transform = '';
    const rect = element.getBoundingClientRect();
    element.style.transform = transform;
    const tab = workspaceTabElement(id)?.getBoundingClientRect();
    if (!tab || tab.width <= 0 || tab.height <= 0 || rect.width <= 0 || rect.height <= 0) return false;
    anchor = { x: tab.left - rect.left, y: tab.top - rect.top, sx: tab.width / rect.width, sy: tab.height / rect.height };
    return true;
  };
  const animate = (to: number): Promise<void> => {
    cancel();
    if (!measure() || motionIsInstant() || progress === to) {
      progress = to;
      paint();
      return Promise.resolve();
    }
    const from = progress;
    const start = performance.now();
    paint();
    return new Promise(resolve => {
      complete = resolve;
      const finish = () => {
        progress = to;
        paint();
        cancel();
      };
      const tick = (now: number) => {
        const t = Math.min(1, Math.max(0, (now - start) / LATH_MOTION_MS));
        progress = from + (to - from) * LATH_EASING(t);
        paint();
        if (t === 1) finish();
        else raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      // A backgrounded window can stop rAF; a close/transfer must still finish.
      timer = setTimeout(finish, LATH_MOTION_MS);
    });
  };
  const motion = {
    expand(restore = false) {
      // Switching away and back must not undo an accepted close or transfer.
      if (departing && !restore) return;
      departing = false;
      if (raf === null) progress = 0;
      void animate(1);
    },
    collapse() {
      departing = true;
      if (element.dataset.workspaceActive !== 'true') {
        cancel();
        progress = 0;
        paint();
        return Promise.resolve();
      }
      return animate(0);
    },
    collapsed: () => departing && progress === 0,
    hide() {
      cancel();
      progress = departing ? 0 : 1;
      paint();
    },
    dispose() {
      cancel();
      if (controllers.get(id) === motion) controllers.delete(id);
    },
  };
  controllers.set(id, motion);
  return motion;
}
