import { useContext, useRef } from 'react';
import { TerminalPane } from '../TerminalPane';
import { NotepadPanel } from '../NotepadPanel';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import type { PaneProps } from './pane-props';
import { usePaneChrome } from './use-pane-chrome';
import {
  ModeContext,
  WallActionsContext,
  SelectedIdContext,
} from './wall-context';

export function TerminalPanel(props: PaneProps) {
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const actions = useContext(WallActionsContext);
  const isFocused = mode === 'passthrough' && selectedId === props.id;
  const elRef = useRef<HTMLDivElement>(null);
  usePaneChrome(props.id, elRef);

  return (
    // `relative` is the notepad panel's containing block — it corners itself in
    // the body, three quarters of it wide and tall.
    <div ref={elRef} className={`relative h-full w-full overflow-hidden bg-terminal-bg ${TERMINAL_BOTTOM_RADIUS_CLASS}`} onMouseDown={() => actions.onClickPanel(props.id)}>
      <TerminalPane id={props.id} isFocused={isFocused} />
      <NotepadPanel surfaceId={props.id} />
    </div>
  );
}
