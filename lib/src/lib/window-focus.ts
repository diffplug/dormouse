/**
 * Whether a window `blur` is real. Focusing one of our own iframe Surfaces blurs
 * the window while the document keeps focus (`docs/specs/layout.md` -> Corner
 * cases #2), so only a blur after which `document.hasFocus()` is false counts.
 */
export function isRealBlur(): boolean {
  return !document.hasFocus();
}

/** Follow this window's focus, ignoring a blur that is not real. Returns the unsubscribe. */
export function subscribeWindowFocus(onChange: (focused: boolean) => void): () => void {
  const onFocus = () => onChange(true);
  const onBlur = () => {
    if (isRealBlur()) onChange(false);
  };
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
  };
}
