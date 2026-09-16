/**
 * The body of a `tool` Surface: one Session with a terminal and, once it
 * serves, a browser (`docs/specs/dor-tool.md` -> Lifecycle).
 */
import { useContext } from 'react';
import { BrowserPanel } from './BrowserPanel';
import { TerminalPanel } from './TerminalPanel';
import { ToolApproval } from './ToolApproval';
import { ToolPortConflict } from './ToolPortConflict';
import { toolFace } from './browser-surface';
import { NotepadPanel } from '../NotepadPanel';
import { TerminalContextContext, WallActionsContext } from './wall-context';
import type { PaneProps } from './pane-props';

/** Keep hidden capability bodies sized. The primary xterm moves into the leaf's
 * context overlay while it is open; TerminalPanel then renders no second view.
 * The Session registry retains that xterm throughout the move. */
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
  const context = useContext(TerminalContextContext);
  const notepad = context.mounted?.id !== props.id && <NotepadPanel surfaceId={props.id} />;

  // Rendered alone, not as one of two halves: mounting TerminalPanel would spawn
  // a shell in a repo the user has not approved yet. Nothing runs until they do.
  if (face === 'pending-approval') {
    return (
      <div className="relative h-full w-full"><ToolApproval
        {...props}
        onResolve={(id, choice) => actions.onResolveToolApproval(id, choice)}
      />{notepad}</div>
    );
  }

  const showSecond = face !== 'terminal';
  return (
    <div className="relative h-full w-full">
      <Half shown={!showSecond}>
        <TerminalPanel {...props} renderTerminal={context.mounted?.id !== props.id} renderNotepad={false} parked={props.parked || showSecond} />
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
          <BrowserPanel {...props} renderNotepad={false} parked={props.parked || !showSecond} />
        )}
      </Half>
      {notepad}
    </div>
  );
}
