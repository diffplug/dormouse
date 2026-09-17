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
export function createWorkspaceMotion(element: HTMLElement, id: string, onVisibilityChange: (visible: boolean) => void = () => {}) {
  let progress = 1;
  let alpha = 1;
  let visible = false;
  const setVisible = (next: boolean) => {
    visible = next;
    onVisibilityChange(next);
  };
  let raf: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete: (() => void) | undefined;
  let departing = false;
  let anchor = { x: 0, y: 0, sx: 1, sy: 1 };

  const paint = () => {
    if (progress === 1) {
      element.style.transform = '';
      element.style.transformOrigin = '';
    } else {
      const remainder = 1 - progress;
      element.style.transformOrigin = '0 0';
      element.style.transform = `translate(${anchor.x * remainder}px, ${anchor.y * remainder}px) scale(${anchor.sx + (1 - anchor.sx) * progress}, ${anchor.sy + (1 - anchor.sy) * progress})`;
    }
    element.style.opacity = progress * alpha === 1 ? '' : String(progress * alpha);
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
    // The tab sits outside this subtree: read it under the same layout flush.
    const tab = workspaceTabElement(id)?.getBoundingClientRect();
    element.style.transform = transform;
    if (!tab || tab.width <= 0 || tab.height <= 0 || rect.width <= 0 || rect.height <= 0) return false;
    anchor = { x: tab.left - rect.left, y: tab.top - rect.top, sx: tab.width / rect.width, sy: tab.height / rect.height };
    return true;
  };
  const animate = (to: number, toAlpha = 1, onFinish?: () => void): Promise<void> => {
    cancel();
    // Keep the same anchor when reversing a partial transform: tab widths can
    // change on activation, but the frame already on screen must not jump.
    // Measuring forces layout, so it runs last, only when a tween will start.
    const measurable = () => (progress > 0 && progress < 1) || measure();
    if (motionIsInstant() || (progress === to && alpha === toAlpha) || !measurable()) {
      progress = to;
      alpha = toAlpha;
      paint();
      onFinish?.();
      return Promise.resolve();
    }
    const from = progress;
    const fromAlpha = alpha;
    const start = performance.now();
    paint();
    return new Promise(resolve => {
      complete = resolve;
      const finish = () => {
        progress = to;
        alpha = toAlpha;
        paint();
        cancel();
        onFinish?.();
      };
      const tick = (now: number) => {
        const t = Math.min(1, Math.max(0, (now - start) / LATH_MOTION_MS));
        const eased = LATH_EASING(t);
        progress = from + (to - from) * eased;
        // Outgoing content dims gradually while the new Wall covers it.
        const alphaEase = toAlpha < fromAlpha ? t : eased;
        alpha = fromAlpha + (toAlpha - fromAlpha) * alphaEase;
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
      if (!visible && raf === null) { progress = 0; alpha = 1; }
      setVisible(true);
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
    fade() {
      if (!visible || departing) { motion.hide(); return; }
      // Keep half its opacity until the incoming Wall fully covers it.
      void animate(progress, 0.5, () => setVisible(false));
    },
    hide() {
      cancel();
      progress = departing ? 0 : 1;
      alpha = 1;
      setVisible(false);
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
