import { dockviewLayoutToLath } from './lath/dockview-convert';
import { type LathPersistedLayout, isLathPersistedLayout } from './lath/persistence';
import type { PlatformAdapter } from './platform/types';
import { readPersistedSession, type PersistedDoor, type PersistedSession } from './session-types';
import { getDefaultShellOpts, restoreBrowserSurfaceTodo, restoreTerminal } from './terminal-registry';

export interface RestoredSession {
  paneIds: string[];
  /** The session's single layout channel — native, or migrated from a pre-Lath
   *  save by `persistedLathLayout`. */
  lathLayout?: LathPersistedLayout;
  doors: PersistedDoor[];
}

/** The one layout a persisted session carries: the native Lath layout when present,
 *  else a pre-Lath dockview `layout` blob migrated one-way via `dockviewLayoutToLath`
 *  (docs/specs/tiling-engine.md → "Persistence and migration"). This is the single
 *  migration point — everything downstream of the session read sees only a Lath
 *  layout. */
export function persistedLathLayout(saved: PersistedSession): LathPersistedLayout | undefined {
  if (isLathPersistedLayout(saved.lathLayout)) return saved.lathLayout;
  return dockviewLayoutToLath(saved.layout) ?? undefined;
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
    restoreTerminal(pane.id, {
      cwd: pane.cwd,
      scrollback: pane.scrollback,
      title: pane.title,
      shell: shellOpts?.shell,
      args: shellOpts?.args,
      untouched: pane.untouched,
    });
  }

  return {
    paneIds: saved.panes.filter((pane) => !doorIds.has(pane.id)).map((p) => p.id),
    lathLayout: persistedLathLayout(saved),
    doors,
  };
}
