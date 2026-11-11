/**
 * A parked leaf is hidden, but no style and no `inert` stops a framed page inside
 * it from focusing itself, and every key then goes to a page nobody can see.
 * While anything is parked, the Wall runs this watch to take the keyboard back.
 */

/** How often to look while something is parked: focus moving from one frame
 *  into another fires nothing in this document, so only a look catches it. */
export const PARKED_FOCUS_POLL_MS = 250;

/** The element holding DOM focus inside a leaf `isParked` names, or null. A leaf
 *  the store has already unparked (a restore focusing its page) does not count. */
export function parkedFocusHolder(isParked: (leafId: string) => boolean): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const leafId = active.closest<HTMLElement>('[data-lath-parked]')?.dataset.lathLeaf;
  return leafId !== undefined && isParked(leafId) ? active : null;
}

/**
 * Take DOM focus out of a parked leaf whenever it lands there, then let `refocus`
 * place it for the current mode. Returns the teardown.
 *
 * Cost against a page refocusing itself in a loop: at most one deferred check is
 * pending at a time, a reclaim is a fixed handful of focus calls, and the only
 * event a reclaim can cause here (a blur, when `refocus` puts focus in a visible
 * frame) schedules one check that finds nothing. So the work is one reclaim per
 * steal plus one look per poll tick, paced by the page's own timer.
 */
export function watchParkedFocus(isParked: (leafId: string) => boolean, refocus: () => void): () => void {
  // Blurring a cross-origin frame does not reliably hand focus back to this
  // document on WebKit; focusing an element here does. The sink is focused and
  // blurred at once, so focus rests on `<body>` until `refocus` places it.
  const sink = document.createElement('div');
  sink.tabIndex = -1;
  sink.setAttribute('aria-hidden', 'true');
  sink.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;outline:none';
  document.body.appendChild(sink);

  const reclaim = () => {
    const holder = parkedFocusHolder(isParked);
    if (!holder) return;
    holder.blur();
    sink.focus({ preventScroll: true });
    sink.blur();
    refocus();
  };

  // A frame taking focus blurs this window, but reclaimed inside that handler
  // `activeElement` already reads as the refocused element while the frame keeps
  // receiving every key: the move into the frame is still settling. One task
  // later it has settled.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const onWindowBlur = () => {
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      reclaim();
    }, 0);
  };
  window.addEventListener('blur', onWindowBlur);
  const poll = setInterval(reclaim, PARKED_FOCUS_POLL_MS);

  return () => {
    window.removeEventListener('blur', onWindowBlur);
    clearInterval(poll);
    if (pending !== null) clearTimeout(pending);
    sink.remove();
  };
}
