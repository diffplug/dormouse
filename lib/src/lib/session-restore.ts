import { type LathPersistedLayout, isLathPersistedLayout } from './lath/persistence';
import type { PlatformAdapter } from './platform/types';
import { carrySurfaceRefs, readPersistedSession, type PersistedDoor, type PersistedSession, type PersistedSurfaceRefs } from './session-types';
import { getDefaultShellOpts, restoreBrowserSurfaceTodo, restoreTerminal } from './terminal-registry';

export interface RestoredSession {
  paneIds: string[];
  /** The session's persisted Lath layout, when present. */
  lathLayout?: LathPersistedLayout;
  doors: PersistedDoor[];
  /** Workspace-scoped stable `dor` Surface refs restored with the session. */
  surfaceRefs?: PersistedSurfaceRefs;
  /** The Workspace's next `surface:N` counter, restored so a killed ref's number
   *  is never handed out again. */
  surfaceRefsNext?: number;
}

/** The persisted Lath layout a session carries, or undefined when absent/unusable
 *  (docs/specs/tiling-engine.md → "Persistence"). */
export function persistedLathLayout(saved: PersistedSession): LathPersistedLayout | undefined {
  return isLathPersistedLayout(saved.lathLayout) ? saved.lathLayout : undefined;
}

export function restoreSession(platform: PlatformAdapter): RestoredSession | null {
  const saved = readPersistedSession(platform.getState());
  if (!saved || !saved.panes || saved.panes.length === 0) return null;
  const doors = saved.doors ?? [];
  const doorIds = new Set(doors.map((item) => item.id));
  const shellOpts = getDefaultShellOpts();

  for (const pane of saved.panes) {
    // Browser surfaces have no PTY or xterm; the persisted layout recreates them
    // (docs/specs/transport.md). Calling restoreTerminal here would mint a stray
    // PTY + xterm for the pane id that never gets mounted.
    if (pane.surfaceType === 'browser') {
      restoreBrowserSurfaceTodo(pane);
      continue;
    }
    // `resumeCommand` is restore-only: the live-resume path in reconnect.ts never
    // reaches here, because there the agent is still Live and has nothing to
    // resume (docs/specs/transport.md -> "Consuming it").
    restoreTerminal(pane.id, {
      cwd: pane.cwd,
      title: pane.title,
      shell: shellOpts?.shell,
      args: shellOpts?.args,
      untouched: pane.untouched,
      resumeCommand: pane.resumeCommand,
    });
  }

  return {
    paneIds: saved.panes.filter((pane) => !doorIds.has(pane.id)).map((p) => p.id),
    lathLayout: persistedLathLayout(saved),
    doors,
    ...carrySurfaceRefs(saved),
  };
}
