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
import { TerminalResizeContext, WorkspaceActiveContext } from './wall/wall-context';

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
  const workspaceActive = useContext(WorkspaceActiveContext);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    getOrCreateTerminal(id);
    // A hidden Workspace's terminal is minimized: the Session and PTY exist, but
    // the element stays detached so xterm stops rasterizing and holds no GL
    // context (docs/specs/layout.md → "Workspaces"). Activation re-runs this
    // effect, and the reattach fit finds the box the hidden Wall kept.
    if (!workspaceActive) return;
    mountElement(id, container);
    // The one fit path, whatever wakes it: the layout coordinator when it has painted
    // committed geometry, a debounced container resize otherwise. Both drop a pending
    // fit, so a settled layout never also fits on the timer behind it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fit = () => {
      clearTimeout(timer);
      if (!container.isConnected || (resize && !resize.canFit(id))) return;
      const { width, height } = container.getBoundingClientRect();
      if (width > 0 && height > 0) refitSession(id);
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(fit, REFIT_DEBOUNCE_MS);
    });
    observer.observe(container);
    const unsubscribe = resize?.subscribe(fit);
    const frame = requestAnimationFrame(fit);

    return () => {
      observer.disconnect();
      unsubscribe?.();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      unmountElement(id, container);
    };
  }, [id, resize, workspaceActive]);

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
