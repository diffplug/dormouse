// The pane webview holding the keyboard, as its host last reported. Taking
// first responder blurs the app document as a real blur would.
let paneWebviewFocused: string | null = null;
const paneWebviewFocusListeners = new Set<() => void>();

/** Record a pane webview's `focus` report. */
export function setPaneWebviewFocus(id: string, focused: boolean): void {
  const next = focused ? id : paneWebviewFocused === id ? null : paneWebviewFocused;
  if (next === paneWebviewFocused) return;
  paneWebviewFocused = next;
  for (const listener of paneWebviewFocusListeners) listener();
}

/** Whether a pane webview of this window holds the keyboard. */
export function paneWebviewHoldsFocus(): boolean {
  return paneWebviewFocused !== null;
}

/**
 * Whether a window `blur` is real. Focusing one of our own iframe Surfaces blurs
 * the window while the document keeps focus (`docs/specs/layout.md` -> Corner
 * cases #2), so only a blur after which `document.hasFocus()` is false counts,
 * and not while a pane webview holds the keyboard.
 */
export function isRealBlur(): boolean {
  return !document.hasFocus() && !paneWebviewHoldsFocus();
}

/** Follow this window's focus, ignoring a blur that is not real. Returns the unsubscribe. */
export function subscribeWindowFocus(onChange: (focused: boolean) => void): () => void {
  const onFocus = () => onChange(true);
  const onBlur = () => {
    if (isRealBlur()) onChange(false);
  };
  // A pane webview's report can trail the blur its focus caused.
  const onPaneWebviewFocus = () => onChange(!isRealBlur());
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  paneWebviewFocusListeners.add(onPaneWebviewFocus);
  return () => {
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    paneWebviewFocusListeners.delete(onPaneWebviewFocus);
  };
}
