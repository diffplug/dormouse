import { useContext, useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import {
  getOrCreateTerminal,
  mountElement,
  unmountElement,
  refitSession,
  focusSession,
} from '../lib/terminal-registry';
import { SelectionOverlay } from './SelectionOverlay';
import { SelectionPopup } from './SelectionPopup';
import { MouseOverrideBanner } from './wall/MouseOverrideBanner';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from './design';
import { TerminalResizeContext } from './wall/wall-context';

interface TerminalPaneProps {
  id: string;
  isFocused?: boolean;
}

// Outside layout motion, coalesce continuous container/window resizes to their
// resting size. Animation completion itself fits immediately through the coordinator.
const REFIT_DEBOUNCE_MS = 150;

/**
 * Thin mount point for a terminal. The actual xterm.js instance lives in the
 * terminal registry and persists across React mount/unmount cycles (reparenting,
 * minimize/reattach, row moves). This component just mounts/unmounts the
 * terminal's persistent DOM element to its container.
 */
export function TerminalPane({ id, isFocused = true }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resize = useContext(TerminalResizeContext);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    getOrCreateTerminal(id);
    // This mount owns fitting; the registry's default rAF would bypass the
    // layout gate and resize a reattached terminal to its collapsed entrance.
    mountElement(id, container, { fit: false });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelFit = () => { clearTimeout(timer); timer = undefined; };
    const fit = () => {
      cancelFit();
      if (!container.isConnected || (resize && !resize.canFit(id))) return;
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) refitSession(id);
    };
    const observer = new ResizeObserver(() => {
      cancelFit();
      if (resize && !resize.canFit(id)) return;
      timer = setTimeout(fit, REFIT_DEBOUNCE_MS);
    });
    observer.observe(container);
    const unsubscribe = resize?.subscribe(fit);
    const frame = requestAnimationFrame(fit);

    return () => {
      observer.disconnect();
      unsubscribe?.();
      cancelAnimationFrame(frame);
      cancelFit();
      unmountElement(id, container);
    };
  }, [id, resize]);

  useEffect(() => {
    focusSession(id, isFocused);
  }, [id, isFocused]);

  return (
    <div ref={containerRef} className={`relative h-full w-full overflow-hidden bg-terminal-bg ${TERMINAL_BOTTOM_RADIUS_CLASS}`}>
      <SelectionOverlay terminalId={id} />
      <SelectionPopup terminalId={id} />
      <MouseOverrideBanner terminalId={id} />
    </div>
  );
}
