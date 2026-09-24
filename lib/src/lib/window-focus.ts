/**
 * Follow this window's focus. A `blur` is real only when `document.hasFocus()`
 * is false: focusing one of our own iframe Surfaces blurs the window while the
 * document keeps focus (`docs/specs/layout.md` -> Corner cases #2), so that
 * blur reports nothing. Returns the unsubscribe.
 */
export function subscribeWindowFocus(onChange: (focused: boolean) => void): () => void {
  const onFocus = () => onChange(true);
  const onBlur = () => {
    if (!document.hasFocus()) onChange(false);
  };
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
  };
}
