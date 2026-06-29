/** True when an event target / element is a real text input — an `<input>`,
 *  `<textarea>`, or a contentEditable element. The shared predicate for "don't
 *  hijack keystrokes (or focus) that belong to a form field."
 *
 *  Note: xterm's hidden `.xterm-helper-textarea` is a `<textarea>`, so it counts
 *  here. That's right for code that treats it as the terminal's input (e.g.
 *  blurring it to dismiss the mobile keyboard); callers that treat the terminal
 *  itself as *non*-editable (e.g. mouse-selection chords) exclude that class
 *  explicitly on top of this check. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true;
}
