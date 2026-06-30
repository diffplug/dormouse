import type { PlatformAdapter } from './platform/types';
import { readPersistedSession, type PersistedDoor } from './session-types';
import { getDefaultShellOpts, restoreBrowserSurfaceTodo, restoreTerminal } from './terminal-registry';

export interface RestoredSession {
  paneIds: string[];
  layout: unknown;
  doors: PersistedDoor[];
}

export function restoreSession(platform: PlatformAdapter): RestoredSession | null {
  const saved = readPersistedSession(platform.getState());
  if (!saved || !saved.panes || saved.panes.length === 0) return null;
  const doors = saved.doors ?? [];
  const doorIds = new Set(doors.map((item) => item.id));
  const shellOpts = getDefaultShellOpts();

  for (const pane of saved.panes) {
    // Browser surfaces have no PTY or xterm; the dockview layout blob recreates
    // them via fromJSON (docs/specs/transport.md). Calling restoreTerminal here
    // would mint a stray PTY + xterm for the pane id that never gets mounted.
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
    layout: saved.layout,
    doors,
  };
}
