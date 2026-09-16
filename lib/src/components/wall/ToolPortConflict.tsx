/**
 * Shown in a tool's browser half when autobind refused to choose
 * (`docs/specs/dor-tool.md` -> Serving).
 *
 * It sits where the browser would have gone on purpose: with several ports
 * bound there is nothing to frame, so the pane's second half explains why
 * rather than sitting empty or silently framing a guess.
 */
import { PANE_MESSAGE_CLASS } from '../design';
import { toolPortConflictFromParams } from './browser-surface';
import type { PaneProps } from './pane-props';

export function ToolPortConflict({ params }: PaneProps) {
  const ports = toolPortConflictFromParams(params) ?? [];

  return (
    <div className={`${PANE_MESSAGE_CLASS} flex-col gap-3 text-muted`}>
      <div className="text-foreground">
        This tool opened {ports.length} ports, so Dormouse did not frame any of them.
      </div>
      <ul className="flex flex-col gap-0.5 font-mono text-xs">
        {ports.map((port) => (
          <li key={port}>localhost:{port}</li>
        ))}
      </ul>
      <div className="flex flex-col gap-1 text-xs text-muted/80">
        <div>
          Have the tool announce its port, or set{' '}
          <code className="rounded bg-app-bg px-1 py-0.5">port: announced</code> in dormouse.yml.
        </div>
        <div>
          <code className="rounded bg-app-bg px-1 py-0.5">port: auto</code> frames a port only when
          there is exactly one.
        </div>
      </div>
    </div>
  );
}
