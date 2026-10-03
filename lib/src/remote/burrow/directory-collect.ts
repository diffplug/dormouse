/**
 * The impure half of the directory: reads the live terminal registry, pane
 * state store, and activity store to produce the `DirectoryEntry[]` the phone's
 * picker renders. It projects registered terminal Surfaces except helper
 * Sessions, including a Tool's terminal while its browser face is displayed,
 * and every Workspace's — a hidden Wall's terminals stay registered.
 * Standalone browser/iframe Surfaces never enter the xterm registry.
 */

import type { DirectoryEntry } from 'remote-lib-common';
import {
  buildAppTitleResolver,
  deriveHeader,
  getActivitySnapshot,
  getTerminalPaneState,
  getTerminalPaneStateSnapshot,
  resolveDisplayPrimary,
} from '../../lib/terminal-registry';
import { isHelperSession, registry } from '../../lib/terminal-store';
import { getWorkspacesSnapshot, refsArePositional, workspaceRefFor } from '../../lib/workspace-store';
import { getWorkspaceSurfacesSnapshot } from '../../lib/workspace-surfaces';
import { buildDirectorySnapshot, type DirectoryPaneInput, type DirectoryWorkspaceInput } from './directory';

/**
 * This Window's Workspaces in strip order, or none where a ref is only a strip
 * position: every Window answers the same directory, so a positional ref would
 * merge one Window's Workspace with another's (VS Code's webviews, each a
 * `workspace:1`).
 */
function collectWorkspaces(): DirectoryWorkspaceInput[] {
  if (refsArePositional()) return [];
  const { workspaces, activeId } = getWorkspacesSnapshot();
  const membership = getWorkspaceSurfacesSnapshot();
  return workspaces.map((workspace) => ({
    ref: workspaceRefFor(workspace.id),
    name: workspace.name,
    active: workspace.id === activeId,
    surfaceIds: membership.get(workspace.id) ?? [],
  }));
}

export function collectDirectorySnapshot(): DirectoryEntry[] {
  const paneStates = getTerminalPaneStateSnapshot();
  const activityStates = getActivitySnapshot();
  const appTitleForPane = buildAppTitleResolver(paneStates, activityStates);

  const ids = [...registry.keys()].filter((id) => !isHelperSession(id));
  // Reuse these per-pane states in the map below rather than re-fetching (each
  // miss would allocate a fresh default twice).
  const allPanes = ids.map((id) => getTerminalPaneState(id));
  const active = typeof document !== 'undefined' ? document.activeElement : null;

  const inputs: DirectoryPaneInput[] = ids.map((id, i) => {
    const pane = allPanes[i]!;
    // Every registry id is present in the activity snapshot (a live pane always
    // reads non-null), so this is the same object `getActivity(id)` would build.
    const activity = activityStates.get(id);
    const element = registry.get(id)?.element ?? null;
    const focused = !!element && !!active && element.contains(active);
    // The directory entry shows only the derived `primary`; it has no
    // secondary/cwd-disambiguation field. `deriveHeader`'s `primary` is a pure
    // per-pane value (`headerPrimary`) computed independently of the pane list
    // it's given — that list drives only `secondary`, which this path discards.
    // Feeding the full set here would rerun deriveHeader's O(n) same-primary
    // scan (and `shortestUniqueCwdLabels`) once per pane, i.e. O(n²) per
    // 150ms-debounced snapshot, to build a value nothing reads. Compare the
    // pane against only itself so that scan is O(1); `primary` is identical.
    const title = resolveDisplayPrimary(
      deriveHeader(pane, [pane], { appTitleForPane }).primary,
      null,
    );
    // A pane whose PTY exited lingers in the registry (showing "[Process
    // exited…]") with `exited` set; report it as not-alive. A missing entry
    // (shouldn't happen — ids come from `registry.keys()`) is also not-alive.
    const entry = registry.get(id);
    const alive = entry !== undefined && entry.exited !== true;
    return {
      paneRef: id,
      surfaceId: id,
      title,
      focused,
      alive,
      pane,
      ringing: activity?.status === 'ALERT_RINGING',
      hasTODO: activity?.todo === true,
    };
  });

  return buildDirectorySnapshot(inputs, collectWorkspaces());
}
