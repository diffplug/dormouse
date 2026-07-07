import { useEffect, useState } from 'react';

/**
 * Whether a Surface is actually on screen: under Lath a mounted leaf is always
 * engine-visible, so this reduces to whether the document isn't hidden (backgrounded
 * window). Callers gate streaming work on it so a hidden pane stops consuming
 * resources while its daemon/session stays alive.
 */
export function useSurfaceVisibility(): boolean {
  const [docVisible, setDocVisible] = useState<boolean>(() => document.visibilityState !== 'hidden');

  useEffect(() => {
    const onChange = () => setDocVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return docVisible;
}
