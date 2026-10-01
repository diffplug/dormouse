import { useEffect, useState } from 'react';
import { subscribeWindowFocus } from '../../lib/window-focus';

/** Whether this window has focus, an iframe Surface holding it included. */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => subscribeWindowFocus(setFocused), []);
  return focused;
}
