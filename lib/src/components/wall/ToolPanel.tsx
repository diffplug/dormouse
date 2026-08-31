/**
 * The body of a `tool` Surface: one Session with a terminal and, once it
 * serves, a browser (`docs/specs/dor-tool.md` -> Lifecycle).
 */
import { BrowserPanel } from './BrowserPanel';
import { TerminalPanel } from './TerminalPanel';
import { toolFace } from './browser-surface';
import { ToolPortConflict } from './ToolPortConflict';
import { ToolApproval } from './ToolApproval';
import { useContext } from 'react';
import { WallActionsContext } from './wall-context';
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
  const face = toolFace(props.params);
  const actions = useContext(WallActionsContext);

  // Rendered alone, not as one of two halves: mounting TerminalPanel would spawn
  // a shell in a repo the user has not approved yet. Nothing runs until they do.
  if (face === 'pending-approval') {
    return (
      <ToolApproval
        {...props}
        onResolve={(id, choice) => void actions.onResolveToolApproval?.(id, choice)}
      />
    );
  }

  const showSecond = face !== 'terminal';
  return (
    <div className="relative h-full w-full">
      <Half shown={!showSecond}>
        <TerminalPanel {...props} />
      </Half>
      <Half shown={showSecond}>
        {/* A conflict and a browser are mutually exclusive by construction —
            autobind writes a conflict only when it declined to write a URL — so
            swapping the second half's content loses no browser state. */}
        {face === 'port-conflict' ? (
          <ToolPortConflict {...props} />
        ) : (
          /* Parked while hidden, so a screencast idles instead of decoding
             frames nobody is looking at (`useSurfaceVisibility`). */
          <BrowserPanel {...props} parked={props.parked || !showSecond} />
        )}
      </Half>
    </div>
  );
}
