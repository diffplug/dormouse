import type { DockviewApi } from 'dockview-react';
import { disposeSession } from './terminal-registry';
import { prefersReducedMotion } from './ui-geometry';
import { withProgrammaticActivation, type ProgrammaticActivationRef } from './programmatic-activation';

/**
 * Run the kill animation: fade out the killed pane, then animate the
 * surviving panes' clip-paths from their old rects to their new rects so
 * dockview's rebalance reads as a smooth expansion rather than a jump.
 *
 * killInProgressRef is set across api.removePanel so the onDidRemovePanel
 * auto-spawn handler skips its own 440ms delay — otherwise a last-pane kill
 * stacks two 440ms waits.
 *
 * isSelected is a LIVE reader — `isSelected(killedId)` is evaluated twice, not
 * snapshotted at call time: once at fade start (for the overlay ring) and again at
 * removal time up to ~1s later (for the selection tail). Only when the killed pane
 * is the selected one does selection move to a survivor; killing a background
 * surface leaves selection where the user left it. Reading live at removal means a
 * mid-fade selection move is honored: navigating AWAY from a dying selected pane
 * means the tail no longer yanks selection to panels[0], and navigating ONTO a
 * dying pane means the tail adopts a survivor instead of leaving selection dangling
 * on the removed panel. The removal is tagged with withProgrammaticActivation (see
 * programmatic-activation.ts): dockview's survivor-activation echo previously
 * covered these two edges by accident; the live read now covers them by design, so
 * the echo is muted. Mouse kills always arrive selected — clicking a pane header
 * activates it (dockview's pointerdown → doSetGroupActive) before the kill button's
 * click handler runs — so the not-selected case comes only from CLI kills
 * (`dor kill surface:3`) and ensure's throwaway teardown.
 *
 * onRemoved runs once, on every path, immediately after removePanel: collapsing a
 * branch can re-parent the surviving selected pane's subtree and blur it, so the
 * caller uses this hook to re-assert focus (Wall passes its guarded rAF helper).
 */
export function orchestrateKill(
  api: DockviewApi,
  killedId: string,
  isSelected: (id: string) => boolean,
  selectPane: (id: string) => void,
  setSelectedId: (id: string | null) => void,
  killInProgressRef: { current: boolean },
  overlayElRef: { current: HTMLElement | null },
  programmaticActivationRef: ProgrammaticActivationRef,
  onRemoved?: () => void,
): void {
  const panel = api.getPanel(killedId);
  if (!panel) return;

  const bareRemove = () => {
    // Sample selection live, BEFORE removePanel mutates dockview — the removal can
    // change the active panel out from under us.
    const wasSelected = isSelected(killedId);
    killInProgressRef.current = true;
    try {
      disposeSession(killedId);
      // A competing remover can beat this finalize to the panel — a double-fired
      // confirm kill's second orchestrateKill, a dor-CLI kill, or a render swap.
      // Removing a stale panel throws deep in dockview ('invalid operation'), so
      // re-resolve by id and only remove the exact object we captured. Tag the
      // removal so dockview's activate-the-survivor echo doesn't read as user
      // intent — the selection tail below applies our policy explicitly.
      withProgrammaticActivation(programmaticActivationRef, () => {
        if (api.getPanel(killedId) === panel) api.removePanel(panel);
      });
    } finally {
      // A throw must not strand this flag: it gates the auto-spawn delay skip in
      // onDidRemovePanel, and a stuck true skips that delay forever after.
      killInProgressRef.current = false;
    }
    // Re-assert focus once the branch has collapsed — before the selection gate so
    // it runs on every path (background kill included), where selection is unchanged.
    onRemoved?.();
    // Killing a pane the user wasn't on must not steal their selection.
    if (!wasSelected) return;
    if (api.panels.length > 0) selectPane(api.panels[0].id);
    else setSelectedId(null);
  };

  const killedGroupEl = panel.api.group?.element;
  if (prefersReducedMotion() || !killedGroupEl) {
    bareRemove();
    return;
  }

  // Last-pane kill also shrinks toward bottom-right: the auto-spawn fills the
  // same rect from the top-left, so a plain fade would offer no cue.
  const isLastPane = api.panels.length === 1;
  const fadeClass = isLastPane ? 'pane-fading-and-shrinking-to-br' : 'pane-fading-out';
  const fadeAnimationName = isLastPane ? 'pane-fade-and-shrink-to-br' : 'pane-fade-out';
  killedGroupEl.style.pointerEvents = 'none';
  killedGroupEl.classList.add(fadeClass);
  // The overlay renders the *current* selection's ring. On an unselected kill
  // that selection (e.g. a surviving door) is not the killed pane, so its ring
  // must not shrink away — only claim the overlay when the killed pane is it.
  // The ring shows the dying selection shrinking, so this at-fade-start read is
  // the right one even though the selection tail re-reads live later.
  const ringSelected = isSelected(killedId);
  const overlayEl = isLastPane && ringSelected ? overlayElRef.current : null;
  if (overlayEl) overlayEl.classList.add('ring-shrinking-to-br');

  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    killedGroupEl.removeEventListener('animationend', onAnimationEnd);

    interface Pre { el: HTMLElement; rect: DOMRect; }
    const preRects = new Map<string, Pre>();
    for (const p of api.panels) {
      if (p.id === killedId) continue;
      const el = p.api.group?.element;
      if (el) preRects.set(p.id, { el, rect: el.getBoundingClientRect() });
    }

    bareRemove();

    for (const p of api.panels) {
      const pre = preRects.get(p.id);
      if (!pre) continue;
      const postRect = pre.el.getBoundingClientRect();
      const dw = postRect.width - pre.rect.width;
      const dh = postRect.height - pre.rect.height;
      if (Math.abs(dw) < 0.5 && Math.abs(dh) < 0.5) continue;

      pre.el.classList.remove('pane-spawning-from-left', 'pane-spawning-from-top', 'pane-spawning-from-top-left');

      const clipTop    = Math.max(0, (pre.rect.top - postRect.top)       / postRect.height * 100);
      const clipBottom = Math.max(0, (postRect.bottom - pre.rect.bottom) / postRect.height * 100);
      const clipLeft   = Math.max(0, (pre.rect.left - postRect.left)     / postRect.width  * 100);
      const clipRight  = Math.max(0, (postRect.right - pre.rect.right)   / postRect.width  * 100);

      pre.el.style.transition = 'none';
      pre.el.style.clipPath = `inset(${clipTop}% ${clipRight}% ${clipBottom}% ${clipLeft}%)`;
      void pre.el.offsetHeight;
      pre.el.style.transition = 'clip-path 440ms cubic-bezier(0.22, 1, 0.36, 1)';
      pre.el.style.clipPath = 'inset(0)';
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        pre.el.style.transition = '';
        pre.el.style.clipPath = '';
      };
      pre.el.addEventListener('transitionend', cleanup, { once: true });
      setTimeout(cleanup, 1000);
    }

    // The overlay element may already have been reused by React for the next
    // selected pane by the time the animation finishes — peel the class so it
    // doesn't render at scale 0.
    if (overlayEl) overlayEl.classList.remove('ring-shrinking-to-br');
  };

  const onAnimationEnd = (ev: AnimationEvent) => {
    if (ev.animationName !== fadeAnimationName) return;
    finalize();
  };
  killedGroupEl.addEventListener('animationend', onAnimationEnd);
  // Safety: if animationend never fires, still finalize.
  setTimeout(finalize, 1000);
}
