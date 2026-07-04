import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';

/**
 * Whether a Surface is actually on screen: its dockview panel is the active tab
 * AND the document isn't hidden (backgrounded window). Browser panels use
 * `renderer: 'always'` (see dor-browser.md → "Canonical Params"), so an inactive
 * tab stays mounted; callers gate streaming work on this so a hidden pane stops
 * consuming resources while its daemon/session stays alive.
 *
 * The panel-api visibility members are absent on the minimal api mocks used in
 * tests (and any host that doesn't wire them); absence reads as always-visible.
 */
export function useSurfaceVisibility(api: IDockviewPanelProps['api']): boolean {
  const [panelVisible, setPanelVisible] = useState<boolean>(api.isVisible ?? true);
  const [docVisible, setDocVisible] = useState<boolean>(() => document.visibilityState !== 'hidden');

  useEffect(() => {
    // Re-sync from the api in case visibility flipped between render and this
    // subscribe — the dockview event only reports future changes.
    setPanelVisible(api.isVisible ?? true);
    const disposable = api.onDidVisibilityChange?.((e) => setPanelVisible(e.isVisible));
    return () => disposable?.dispose();
  }, [api]);

  useEffect(() => {
    const onChange = () => setDocVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return panelVisible && docVisible;
}
