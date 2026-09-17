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

/** What a restore reads instead of the platform slot, so one Window can plan a
 *  cold restore per Workspace off one boot payload. Defaults to the platform's
 *  own answer, which is what the single-Wall hosts still take. */
export interface RestoreSources {
  /** The record to restore; `undefined` reads the platform slot, `null` is "none". */
  savedSession?: PersistedSession | null;
}

export function restoreSession(platform: PlatformAdapter, sources: RestoreSources = {}): RestoredSession | null {
  const saved = sources.savedSession !== undefined
    ? sources.savedSession
    : readPersistedSession(platform.getState());
  if (!saved || !saved.panes || saved.panes.length === 0) return null;
  const doors = saved.doors ?? [];
  const doorIds = new Set(doors.map((item) => item.id));
  const visiblePanes = saved.panes.filter((pane) => !doorIds.has(pane.id));
  const visibleIds = new Set(visiblePanes.map((pane) => pane.id));
  const candidateLayout = persistedLathLayout(saved);
  const leafIds = candidateLayout ? Object.keys(candidateLayout.leafMeta) : [];
  const lathLayout = candidateLayout && leafIds.length === visibleIds.size && leafIds.every((id) => visibleIds.has(id))
    ? candidateLayout : undefined;
  const shellOpts = getDefaultShellOpts();
  // Host-owned and single-use, and read here rather than off the pane: the
  // session blob the webview saves must never carry one, or a later restore
  // would replay it (docs/specs/transport.md -> "Consuming it"). Restore-only —
  // the live-resume path in reconnect.ts never reaches here, because there the
  // agent is still Live and has nothing to resume.
  const recoveryCommands = platform.getRecoveryCommands?.() ?? {};

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
      title: pane.title,
      shell: shellOpts?.shell,
      args: shellOpts?.args,
      untouched: pane.untouched,
      resumeCommand: recoveryCommands[pane.id] ?? null,
    });
    // The fresh PTY inherits the pane's persisted TODO/alert, on the hosts whose
    // AlertManager lives in the webview. Seeded after `restoreTerminal` so the
    // state change lands on a registered pane. Restore-only: a live resume still
    // has the manager's own state (docs/specs/alert.md -> "Persist only").
    if (pane.alert) platform.alertSeed?.(pane.id, pane.alert);
  }

  return {
    // Without a usable layout Wall seeds terminal metadata for each id. Browser
    // render params live only in that layout (or a door), so omit visible browser
    // ids instead of silently restoring them as shells.
    paneIds: visiblePanes.filter((pane) => lathLayout || pane.surfaceType !== 'browser').map((pane) => pane.id),
    lathLayout,
    doors,
    ...carrySurfaceRefs(saved),
  };
}
