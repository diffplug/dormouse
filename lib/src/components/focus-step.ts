/**
 * Move DOM focus within an ordered candidate list: step from the currently
 * focused entry by `delta`, wrapping at both ends. When focus is outside the
 * list, seed at the first entry for a forward step and the last for a backward
 * one. Shared by the popover/modal focus traps (Tab cycling) and the pane
 * header context menu (arrow roving) so the wrap arithmetic exists once.
 */
export function stepFocus(items: HTMLElement[], delta: number): void {
  if (items.length === 0) return;
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  const nextIndex = currentIndex === -1
    ? (delta > 0 ? 0 : items.length - 1)
    : (currentIndex + delta + items.length) % items.length;
  items[nextIndex]?.focus();
}
