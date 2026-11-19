import { useLayoutEffect, useSyncExternalStore } from 'react';

// How many modals, menus, and prompts are open. A pane webview paints above
// everything the app webview draws, so while any is open every one hides: a
// page left over one could imitate it.
let open = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function paneWebviewsOccluded(): boolean {
  return open > 0;
}

export function usePaneWebviewsOccluded(): boolean {
  return useSyncExternalStore(subscribe, paneWebviewsOccluded);
}

/** Hide every pane webview while `active`. A layout effect, so the views are
 *  told before the overlay first paints. */
export function useOccludePaneWebviews(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    open += 1;
    for (const listener of listeners) listener();
    return () => {
      open -= 1;
      for (const listener of listeners) listener();
    };
  }, [active]);
}
