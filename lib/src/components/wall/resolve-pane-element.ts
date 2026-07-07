/**
 * Resolve the stable Lath leaf element (`[data-lath-leaf]`: header + body) for a
 * pane's registered element, so the selection ring / kill overlay cover the full
 * leaf. Falls back to the element itself when it is not inside a leaf (transient
 * states) and returns null when it is detached.
 */
export function resolvePaneElement(element: HTMLElement | null | undefined): HTMLElement | null {
  if (!element || !element.isConnected) return null;
  return (element.closest('[data-lath-leaf]') as HTMLElement | null) ?? element;
}
