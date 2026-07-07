import { useEffect, useState } from 'react';

/**
 * Whether a Surface is actually on screen: the engine reports the pane visible
 * (Lath: a mounted leaf is always visible) AND the document isn't hidden
 * (backgrounded window). Callers gate streaming work on this so a hidden pane stops
 * consuming resources while its daemon/session stays alive.
 *
 * The engine-visibility half arrives as the `panelVisible` prop (supplied by
 * LathHost); this hook owns only the document-visibility half and ANDs the two.
 */
export function useSurfaceVisibility(panelVisible: boolean): boolean {
  const [docVisible, setDocVisible] = useState<boolean>(() => document.visibilityState !== 'hidden');

  useEffect(() => {
    const onChange = () => setDocVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return panelVisible && docVisible;
}
