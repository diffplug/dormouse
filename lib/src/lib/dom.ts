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

/** True while an IME composition owns the key. WebKit sends the key that ends a
 *  composition with `isComposing` false but `keyCode` 229, so both count. */
export function isComposingKey(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
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

/** Each portaled root's in-place anchor, by root. */
const portalAnchors = new WeakMap<Element, Element>();

/** Mark `root`, a subtree portaled out of its owner, `[data-portal-anchored]`
 *  and map it to `anchor`, an element left where it belongs. Returns the
 *  unmapping, for an effect's cleanup. */
export function setPortalAnchor(root: Element, anchor: Element): () => void {
  root.setAttribute('data-portal-anchored', '');
  portalAnchors.set(root, anchor);
  return () => {
    root.removeAttribute('data-portal-anchored');
    portalAnchors.delete(root);
  };
}

/** The element DOM containment checks should test: for a target inside a
 *  mapped portal root, that root's anchor, so the portaled subtree counts as
 *  part of its owner; any other element as is, and null for a target that is
 *  no element. A portal already passes React events up the owner's tree; this
 *  does the same for `contains` and `closest`. */
export function anchoredTarget(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const root = target.closest('[data-portal-anchored]');
  return (root && portalAnchors.get(root)) ?? target;
}
