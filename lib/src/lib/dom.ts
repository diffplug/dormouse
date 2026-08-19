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

/** True for the `<textarea>` xterm keeps offscreen as the terminal's input
 *  proxy — the one editable element that is not a text field of ours. Callers
 *  that treat the terminal as *non*-editable pair this with
 *  `isEditableTarget`. */
export function isTerminalInputProxy(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea');
}

/** Set a form field's value the way a user's typing does, so a React-controlled
 *  field sees the change: React shadows the element's `value` setter and reads
 *  the DOM node when the `input` event fires, so a plain assignment is
 *  invisible to it. */
export function setNativeFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setValue) setValue.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
