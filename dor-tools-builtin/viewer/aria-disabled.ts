/** The built-in pages mark a control that cannot act now
 * `aria-disabled="true"`, never `disabled`, and style it by that attribute: a
 * disabled control leaves the tab order, so keyboard focus never shows its tip
 * (./tooltip.ts), and whether the mouse does depends on the engine sending
 * pointer events to a disabled control. It stays focusable and is announced as
 * unavailable. */
export const ARIA_DISABLED = '[aria-disabled="true"]';

/** A capture-phase click listener for the document that keeps an
 * `aria-disabled` control inert: the click a pointer, Enter, or Space makes on
 * it, or inside it, never reaches the page. */
export function refuseDisabledClick(event: Event): void {
  const target = event.target as Element | null;
  if (!target?.closest?.(ARIA_DISABLED)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}
