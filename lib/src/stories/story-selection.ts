import { useEffect, type DependencyList } from 'react';
import { setHintToken, setSelection } from '../lib/mouse-selection';
import { getTerminalInstance, getTerminalOverlayDims } from '../lib/terminal-registry';
import type { Terminal } from '@xterm/xterm';

/**
 * Apply a story's selection once xterm has painted its grid — the overlay
 * measures `.xterm-screen`, which does not exist before the first paint — and
 * clear it on unmount. `apply` gets the terminal, for opening the copy editor
 * the way mouse-up does.
 */
export function useStorySelection(id: string, apply: (terminal: Terminal) => void, deps: DependencyList): void {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tryApply = () => {
      if (cancelled) return;
      const dims = getTerminalOverlayDims(id);
      const terminal = getTerminalInstance(id);
      if (!dims || dims.cellHeight === 0 || !terminal) {
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
