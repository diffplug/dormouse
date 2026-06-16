import { useContext, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { TerminalPane } from '../TerminalPane';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { usePaneChrome } from './use-pane-chrome';
import {
  ModeContext,
  WallActionsContext,
  SelectedIdContext,
} from './wall-context';

export function TerminalPanel({ api }: IDockviewPanelProps) {
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const actions = useContext(WallActionsContext);
  const isFocused = mode === 'passthrough' && selectedId === api.id;
  const elRef = useRef<HTMLDivElement>(null);
  usePaneChrome(api, elRef);

  return (
    <div ref={elRef} className={`h-full w-full overflow-hidden bg-terminal-bg ${TERMINAL_BOTTOM_RADIUS_CLASS}`} onMouseDown={() => actions.onClickPanel(api.id)}>
      <TerminalPane id={api.id} isFocused={isFocused} />
    </div>
  );
}
