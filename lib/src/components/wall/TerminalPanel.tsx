import { useContext, useRef } from 'react';
import { TerminalPane } from '../TerminalPane';
import { NotepadPanel } from '../NotepadPanel';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { getMouseSelectionState } from '../../lib/mouse-selection';
import type { PaneProps } from './pane-props';
import { usePaneChrome } from './use-pane-chrome';
import {
  ModeContext,
  TerminalContextContext,
  WallActionsContext,
  SelectedIdContext,
} from './wall-context';

export function TerminalPanel(props: PaneProps & { renderNotepad?: boolean; renderTerminal?: boolean }) {
  const context = useContext(TerminalContextContext);
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const actions = useContext(WallActionsContext);
  const isFocused = !props.parked && mode === 'passthrough' && selectedId === props.id && context.id !== props.id;
  const elRef = useRef<HTMLDivElement>(null);
  usePaneChrome(props.id, elRef);

  return (
    <div ref={elRef} className={`relative h-full w-full overflow-hidden bg-terminal-bg ${TERMINAL_BOTTOM_RADIUS_CLASS}`} onMouseDown={() => actions.onClickPanel(props.id)} onContextMenu={event => {
      event.preventDefault(); event.stopPropagation();
      // A program that owns the mouse keeps its right-click (docs/specs/mouse-and-clipboard.md).
      const mouse = getMouseSelectionState(props.id);
      if (mouse.mouseReporting !== 'none' && mouse.override === 'off') return;
      context.open(props.id, { origin: { x: event.clientX, y: event.clientY } });
    }}>
      {props.renderTerminal !== false && <TerminalPane id={props.id} isFocused={isFocused} />}
      {props.renderNotepad !== false && context.mounted?.id !== props.id && <NotepadPanel surfaceId={props.id} />}
    </div>
  );
}
