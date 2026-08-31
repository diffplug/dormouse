/**
 * The body of a `tool` Surface: one Session with a terminal and, once it
 * serves, a browser (`docs/specs/dor-tool.md` -> Lifecycle).
 */
import { BrowserPanel } from './BrowserPanel';
import { TerminalPanel } from './TerminalPanel';
import { toolShowsBrowser } from './browser-surface';
import type { PaneProps } from './pane-props';

/**
 * Both halves stay mounted for the Surface's whole life — unmounting the
 * terminal would drop the xterm buffer the command is still writing to, and
 * unmounting the browser would reload the framed document on every flip.
 *
 * So the flip is `visibility`, never `hidden`/`display: none`: a display-none
 * container has no box, so the fit addon would measure zero and resize the PTY
 * to a degenerate size, reflowing the output of the command still running
 * behind the browser. Both halves are absolutely positioned over the same area,
 * so each always measures the pane's real dimensions. `inert` keeps the hidden
 * half out of the tab order and the accessibility tree.
 */
function Half({ shown, children }: { shown: boolean; children: React.ReactNode }) {
  return (
    <div
      className="absolute inset-0"
      style={{ visibility: shown ? 'visible' : 'hidden' }}
      aria-hidden={!shown}
      inert={!shown}
    >
      {children}
    </div>
  );
}

export function ToolPanel(props: PaneProps) {
  const showBrowser = toolShowsBrowser(props.params);
  return (
    <div className="relative h-full w-full">
      <Half shown={!showBrowser}>
        <TerminalPanel {...props} />
      </Half>
      <Half shown={showBrowser}>
        {/* Parked while hidden, so a screencast idles instead of decoding
            frames nobody is looking at (`useSurfaceVisibility`). */}
        <BrowserPanel {...props} parked={props.parked || !showBrowser} />
      </Half>
    </div>
  );
}
