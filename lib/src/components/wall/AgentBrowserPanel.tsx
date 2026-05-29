import { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import {
  FreshlySpawnedContext,
  PaneElementsContext,
  WallActionsContext,
} from './wall-context';

export function AgentBrowserPanel({ api }: IDockviewPanelProps) {
  const actions = useContext(WallActionsContext);
  const { elements: paneElements, bumpVersion } = useContext(PaneElementsContext);
  const freshlySpawned = useContext(FreshlySpawnedContext);
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!elRef.current) return;
    paneElements.set(api.id, elRef.current);
    bumpVersion();
    return () => {
      paneElements.delete(api.id);
      bumpVersion();
    };
  }, [api.id, paneElements, bumpVersion]);

  useLayoutEffect(() => {
    const direction = freshlySpawned.get(api.id);
    if (!direction) return;
    freshlySpawned.delete(api.id);
    const groupEl = api.group?.element;
    if (!groupEl) return;
    const className = `pane-spawning-from-${direction}`;
    const animationName = `pane-spawn-from-${direction}`;
    groupEl.classList.add(className);
    const onEnd = (ev: AnimationEvent) => {
      if (ev.animationName !== animationName) return;
      groupEl.classList.remove(className);
      groupEl.removeEventListener('animationend', onEnd);
    };
    groupEl.addEventListener('animationend', onEnd);
    return () => {
      groupEl.removeEventListener('animationend', onEnd);
      groupEl.classList.remove(className);
    };
  }, [api, freshlySpawned]);

  return (
    <div
      ref={elRef}
      className={`flex h-full w-full items-center justify-center overflow-hidden bg-terminal-bg px-4 text-center text-sm text-muted ${TERMINAL_BOTTOM_RADIUS_CLASS}`}
      onMouseDown={() => actions.onClickPanel(api.id)}
    >
      agent-browser surface stub
    </div>
  );
}
