import { useContext } from 'react';
import { TerminalIcon } from '@phosphor-icons/react';
import { chromeButton } from '../design';
import { SurfacePaneHeader } from './SurfacePaneHeader';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { toolFace } from './browser-surface';
import { TerminalContextContext } from './wall-context';
import type { PaneProps } from './pane-props';

export function ToolPaneHeader(props: PaneProps) {
  const context = useContext(TerminalContextContext);
  const face = toolFace(props.params);
  if (face === 'terminal' || face === 'pending-approval') return <TerminalPaneHeader {...props} />;
  return (
    <div className="flex h-full min-w-0 flex-1 items-center" onContextMenu={event => {
      event.preventDefault(); event.stopPropagation();
      context.open(props.id, { origin: { x: event.clientX, y: event.clientY } });
    }}>
      <button type="button" className={`${chromeButton()} ml-1 shrink-0`}
        title="Terminal context" aria-label="Terminal context" aria-expanded={context.id === props.id}
        onClick={event => {
          event.stopPropagation();
          if (context.id === props.id) context.close();
          else { const rect = event.currentTarget.getBoundingClientRect(); context.open(props.id, { origin: { x: rect.left, y: rect.bottom } }); }
        }}><TerminalIcon size={14} /></button>
      {face === 'browser' ? <SurfacePaneHeader {...props} /> : <TerminalPaneHeader {...props} />}
    </div>
  );
}
