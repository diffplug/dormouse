import { useEffect, useState } from 'react';
import { publishEngagementFocus, retainEngagementReporter } from '../../lib/engagement';

/**
 * Report the terminal Session this Wall points its realm at (`docs/specs/alert.md`
 * -> Engagement), holding the realm's engagement reporter while mounted.
 */
export function useEngagementFocus(focusId: string | null): void {
  const [slot] = useState(() => ({}));
  useEffect(() => {
    const release = retainEngagementReporter();
    return () => {
      publishEngagementFocus(slot, null);
      release();
    };
  }, [slot]);
  useEffect(() => publishEngagementFocus(slot, focusId), [slot, focusId]);
}
