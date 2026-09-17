import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { createWorkspaceMotion } from './workspace-motion';
import { WorkspaceVisibleContext } from './wall/wall-context';

/** A stable grid cell; only its presentation transforms during workspace travel. */
export function WorkspaceMotion({ id, active, children }: { id: string; active: boolean; children: ReactNode }) {
  const [visible, setVisible] = useState(active);
  const element = useRef<HTMLDivElement>(null);
  const motion = useRef<ReturnType<typeof createWorkspaceMotion> | null>(null);
  useLayoutEffect(() => {
    motion.current = createWorkspaceMotion(element.current!, id, setVisible);
    return () => { motion.current?.dispose(); motion.current = null; };
  }, [id]);
  useLayoutEffect(() => {
    if (active) motion.current?.expand();
    else motion.current?.fade();
  }, [active, id]);
  // `active` covers the render before the layout effect reports visibility.
  const shown = active || visible;
  return (
    <div
      ref={element}
      data-workspace-wall={id}
      data-workspace-active={active ? 'true' : 'false'}
      inert={!active}
      className={clsx('col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col', active ? 'z-10' : 'pointer-events-none', !shown && 'invisible')}
    >
      <WorkspaceVisibleContext.Provider value={shown}>{children}</WorkspaceVisibleContext.Provider>
    </div>
  );
}
