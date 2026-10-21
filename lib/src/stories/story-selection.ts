import { useEffect, type DependencyList } from 'react';
import { setHintToken, setSelection } from '../lib/mouse-selection';
import { getTerminalInstance, getTerminalOverlayDims } from '../lib/terminal-registry';
import type { Terminal } from '@xterm/xterm';
import { terminalHasContent } from './settle-terminals';

/**
 * Apply a story's selection after priming, terminal content, and grid layout.
 * Selecting a blank buffer before output arrives would let the later write
 * invalidate the selection. `apply` gets the terminal, for opening the copy
 * editor the way mouse-up does. Clear the selection on unmount.
 */
export function useStorySelection(id: string, apply: (terminal: Terminal) => void, deps: DependencyList): void {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tryApply = () => {
      if (cancelled) return;
      const dims = getTerminalOverlayDims(id);
      const terminal = getTerminalInstance(id);
      if (document.documentElement.dataset.storyPrimed !== 'true'
        || !dims || dims.cellHeight === 0 || !terminal || !terminalHasContent(terminal)) {
        timer = setTimeout(tryApply, 50);
        return;
      }
      apply(terminal);
    };
    timer = setTimeout(tryApply, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSelection(id, null);
      setHintToken(id, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `apply` is rebuilt every render; the story names what it reads.
  }, [id, ...deps]);
}
