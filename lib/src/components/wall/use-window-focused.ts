import { useEffect, useState } from 'react';

export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = () => setFocused(true);
    // Focusing one of our own iframe surfaces fires `blur` on this window even
    // though the app hasn't been backgrounded — the focused element is just an
    // <iframe> *inside* this document, so `document.hasFocus()` stays true.
    // Reading it instead of blindly setting false keeps headers/attention live
    // when an iframe takes focus (docs/specs/dor-browser.md → "Iframe Focus And Rendering Notes").
    const onBlur = () => setFocused(document.hasFocus());
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return focused;
}
