import type { LathNode } from './lath/model';
import { type LathPersistedLayout, type LeafMeta, isLathPersistedLayout } from './lath/persistence';
import type { PlatformAdapter } from './platform/types';
import { PLATFORM_STRING } from './platform';
import { buildShellCommandForKind, shellCommandKind } from 'dor/commands/shell-quote';
import { readPersistedSession, type PersistedDoor, type PersistedPane, type PersistedSession } from './session-types';
import { createReapedTerminal, getDefaultShellOpts, restoreBrowserSurfaceTodo, restoreTerminal, setTerminalActivity } from './terminal-registry';
import { markToolReaped } from './tool-reap-store';

/** Whether `pane` is a Tool saved while reaped, which this host restores with
 *  no process (`docs/specs/dor-tool.md` -> Reaping). */
export function isReapedToolPane(platform: PlatformAdapter, pane: PersistedPane): boolean {
  return platform.reapsTools === true && pane.surfaceType === 'tool' && pane.tool?.reaped === true;
}

/** Rebuild a reaped Tool's Session with no PTY, its alert shown and kept for
 *  the rehydrate's spawn, which starts it from bare args when it is seen. */
export function restoreReapedTool(pane: PersistedPane): void {
  createReapedTerminal(pane.id, { cwd: pane.cwd, title: pane.title, shell: getDefaultShellOpts()?.shell, untouched: pane.untouched });
  if (pane.alert) setTerminalActivity(pane.id, pane.alert);
  markToolReaped(pane.id, { payload: null, cwd: pane.cwd, alert: pane.alert ?? null });
}

export interface RestoredSession {
  paneIds: string[];
  /** The session's persisted Lath layout, when present. */
  lathLayout?: LathPersistedLayout;
  doors: PersistedDoor[];
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

/** The saved string belongs to the previous Session's shell. Preserve literal
 *  commands, but quote saved argv anew for the shell this restore will spawn. */
function requoteToolCommand(pane: PersistedPane): PersistedPane {
  if (pane.surfaceType !== 'tool' || !pane.tool?.argv) return pane;
  const kind = shellCommandKind(getDefaultShellOpts()?.shell, PLATFORM_STRING);
  return { ...pane, command: buildShellCommandForKind(kind, pane.tool.argv) };
}

/** A Tool leaf's params carry the command its pane re-runs. */
function withToolCommand(params: Record<string, unknown> | undefined, pane: PersistedPane): Record<string, unknown> | undefined {
  return pane.surfaceType === 'tool' && pane.tool?.argv
    ? { ...params, command: pane.command, toolArgv: pane.tool.argv } : params;
}

/**
 * One pane's cold restore: a new Session for a terminal or Tool, the TODO for a
 * browser, whose page the layout recreates. Reopen rebuilds a closed Surface
 * through the same path (`docs/specs/reopen.md`), with no agent to resume.
 */
function restorePane(pane: PersistedPane, resumeCommand: string | null): void {
  // Browser surfaces have no PTY or xterm; the persisted layout recreates them
  // (docs/specs/transport.md). Calling restoreTerminal here would mint a stray
  // PTY + xterm for the pane id that never gets mounted.
  if (pane.surfaceType === 'browser') {
    restoreBrowserSurfaceTodo(pane);
    return;
  }
  const shellOpts = getDefaultShellOpts();
  restoreTerminal(pane.id, {
    cwd: pane.cwd,
    title: pane.title,
    shell: shellOpts?.shell,
    args: shellOpts?.args,
    untouched: pane.untouched,
    // The fresh PTY inherits the pane's persisted TODO: the host seeds it at
    // the spawn. Restore-only: a live resume still has the host's own state
    // (docs/specs/alert.md -> "Persist only").
    alert: pane.alert,
    // A tool command is durable, approved Session state and wins over the
    // host's unrelated single-use agent recovery channel.
    ...(pane.surfaceType === 'tool'
      ? { command: pane.command ?? null, requireIntegration: true, resumeCommand: null }
      : { resumeCommand }),
  });
}

/**
 * Rebuild a closed Surface as `id`: its pane restored as cold start would,
 * and the leaf meta to lay it out with.
 */
export function reopenPane(id: string, pane: PersistedPane, meta: LeafMeta): LeafMeta {
  const requoted = requoteToolCommand({ ...pane, id });
  restorePane(requoted, null);
  return { ...meta, params: withToolCommand(meta.params, requoted) };
}

export function restoreSession(platform: PlatformAdapter, sources: RestoreSources = {}): RestoredSession | null {
  const saved = readPersistedSession(sources.savedSession !== undefined
    ? sources.savedSession
    : platform.getState());
  if (!saved || !saved.panes || saved.panes.length === 0) return null;
  const panes = saved.panes.map(requoteToolCommand);
  const panesById = new Map(panes.map(pane => [pane.id, pane]));
  const doors = (saved.doors ?? []).map(door => {
    const pane = panesById.get(door.id);
    return pane ? { ...door, params: withToolCommand(door.params, pane) } : door;
  });
  const doorIds = new Set(doors.map((item) => item.id));
  const visiblePanes = panes.filter((pane) => !doorIds.has(pane.id));
  const visibleIds = new Set(visiblePanes.map((pane) => pane.id));
  const candidateLayout = persistedLathLayout(saved);
  const leafIds = candidateLayout ? Object.keys(candidateLayout.leafMeta) : [];
  let lathLayout = candidateLayout && leafIds.length === visibleIds.size && leafIds.every((id) => visibleIds.has(id))
    ? candidateLayout : undefined;
  if (lathLayout) {
    const leafMeta = { ...lathLayout.leafMeta };
    for (const pane of visiblePanes) {
      const meta = leafMeta[pane.id];
      leafMeta[pane.id] = { ...meta, params: withToolCommand(meta.params, pane) };
    }
    lathLayout = { ...lathLayout, leafMeta };
  }
  // Tool commands remain runnable when geometry is corrupt. Rebuild their kind
  // and stable metadata from the pane projection instead of seeding plain shells.
  if (!lathLayout && visiblePanes.some(pane => pane.surfaceType === 'tool')) {
    const recoverable = visiblePanes.filter(pane => pane.surfaceType !== 'browser');
    const nodes: LathNode[] = recoverable.map(pane => ({ kind: 'leaf', id: pane.id }));
    lathLayout = {
      version: 1,
      tree: { root: nodes.length === 1 ? nodes[0] : { kind: 'split', dir: 'row', children: nodes.map(node => ({ node, weight: 1 / nodes.length })) } },
      leafMeta: Object.fromEntries(recoverable.map(pane => [pane.id, pane.surfaceType === 'tool' ? {
        component: 'tool', tabComponent: 'tool', title: pane.title,
        params: { surfaceType: 'tool', command: pane.command, cwd: pane.cwd,
          ...(pane.tool?.argv ? { toolArgv: pane.tool.argv } : {}),
          toolScope: pane.tool?.scope, toolName: pane.tool?.name, toolRender: pane.tool?.render ?? 'iframe',
          toolPort: pane.tool?.port ?? 'announced', toolKey: pane.tool?.key,
          browserViewport: pane.tool?.viewport, toolPreview: pane.tool?.preview, toolTarget: pane.tool?.target },
      } : { component: 'terminal', tabComponent: 'terminal', title: pane.title }])),
    };
  }
  // Host-owned and single-use, and read here rather than off the pane: the
  // session blob the webview saves must never carry one, or a later restore
  // would replay it (docs/compatible-agents.md -> "Cold restore"). Restore-only —
  // the live-resume path in reconnect.ts never reaches here, because there the
  // agent is still Live and has nothing to resume.
  const recoveryCommands = platform.getRecoveryCommands?.() ?? {};

  for (const pane of panes) {
    if (isReapedToolPane(platform, pane)) {
      restoreReapedTool(pane);
      continue;
    }
    restorePane(pane, recoveryCommands[pane.id] ?? null);
  }

  return {
    // Without a usable layout Wall seeds terminal metadata for each id. Browser
    // render params live only in that layout (or a door), so omit visible browser
    // ids instead of silently restoring them as shells.
    paneIds: visiblePanes.filter((pane) => lathLayout ? !!lathLayout.leafMeta[pane.id] : pane.surfaceType !== 'browser').map((pane) => pane.id),
    lathLayout,
    doors,
  };
}
