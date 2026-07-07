import { useContext, useRef } from 'react';
import { TerminalPane } from '../TerminalPane';
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
  usePaneChrome(props.id, elRef, props.getAnimEl);

  return (
    <div ref={elRef} className={`h-full w-full overflow-hidden bg-terminal-bg ${TERMINAL_BOTTOM_RADIUS_CLASS}`} onMouseDown={() => actions.onClickPanel(props.id)}>
      <TerminalPane id={props.id} isFocused={isFocused} />
    </div>
  );
}
