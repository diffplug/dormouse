import { useEffect, useRef } from 'react';
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
import { throttleTrailing } from '../lib/throttle';

interface TerminalPaneProps {
  id: string;
  isFocused?: boolean;
}

// Lath tweens real pane geometry across many animation frames per motion (kills,
// splits, restores, drag-drops) and sash drags stream live resizes, and every
// refitSession() reflows the xterm buffer + fires a PTY resize (ioctl +
// SIGWINCH; running TUIs redraw). Throttle the ResizeObserver so motion causes a
// handful of reflows instead of one per frame — the leading edge keeps a single
// resize (zoom) instant, and the trailing call fits the resting geometry exactly.
const REFIT_THROTTLE_MS = 150;

/**
 * Thin mount point for a terminal. The actual xterm.js instance lives in the
 * terminal registry and persists across React mount/unmount cycles (reparenting,
 * minimize/reattach, row moves). This component just mounts/unmounts the
 * terminal's persistent DOM element to its container.
 */
export function TerminalPane({ id, isFocused = true }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Ensure the terminal exists in the registry
    getOrCreateTerminal(id);

    // Attach the terminal's persistent element to this container
    mountElement(id, container);

    // Resize observer — refit terminal when container changes size, throttled
    // (see REFIT_THROTTLE_MS) so animated/dragged geometry doesn't reflow the
    // buffer on every frame.
    const throttledRefit = throttleTrailing(() => refitSession(id), REFIT_THROTTLE_MS);
    const observer = new ResizeObserver(throttledRefit);
    observer.observe(container);

    return () => {
      observer.disconnect();
      // Cancel any pending trailing refit — no fit after unmount.
      throttledRefit.cancel();
      // Unmount DOM element — registry entry and Session survive
      unmountElement(id);
    };
  }, [id]);

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
