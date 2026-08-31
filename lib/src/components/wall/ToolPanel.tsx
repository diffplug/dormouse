/**
 * The body of a `tool` Surface: one Session with a terminal and, once it
 * serves, a browser (`docs/specs/dor-tool.md` -> Lifecycle).
 *
 * Both halves stay mounted for the Surface's whole life and the flip is
 * visibility only. Unmounting the terminal would drop the xterm buffer the
 * command is still writing to, and unmounting the browser would reload the
 * framed document on every toggle — the invariant that lets a tool keep one id
 * while its capabilities come and go.
 */
import { BrowserPanel } from './BrowserPanel';
import { TerminalPanel } from './TerminalPanel';
import { toolShowsBrowser } from './browser-surface';
import type { PaneProps } from './pane-props';

/**
 * `visibility`, never `hidden`/`display: none`. A display-none container has no
 * box, so the fit addon measures zero and resizes the PTY to a degenerate size
 * — reflowing the output of the command still running behind the browser. Both
 * halves are absolutely positioned over the same area, so each always measures
 * the pane's real dimensions whichever one is forward. `inert` keeps the hidden
 * half out of the tab order and away from the accessibility tree.
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
