/**
 * The impure half of the directory: reads the live terminal registry, pane
 * state store, and activity store to produce the `DirectoryEntry[]` the phone's
 * picker renders. Every entry is a terminal pane (the POC is terminal-only);
 * browser/iframe surfaces never enter the xterm registry, so iterating it lists
 * exactly the terminal panes.
 */

import type { DirectoryEntry } from 'server-lib-common';
import {
  buildAppTitleResolver,
  deriveHeader,
  getActivitySnapshot,
  getTerminalPaneState,
  getTerminalPaneStateSnapshot,
  resolveDisplayPrimary,
} from '../../lib/terminal-registry';
import { registry } from '../../lib/terminal-store';
import { buildDirectorySnapshot, type DirectoryPaneInput } from './directory';

export function collectDirectorySnapshot(): DirectoryEntry[] {
  const paneStates = getTerminalPaneStateSnapshot();
  const activityStates = getActivitySnapshot();
  const appTitleForPane = buildAppTitleResolver(paneStates, activityStates);

  const ids = [...registry.keys()];
  // The wall derives titles across all visible panes so duplicates disambiguate;
  // feed it the same set here. Reuse these per-pane states below rather than
  // re-fetching (each miss would allocate a fresh default twice).
  const allPanes = ids.map((id) => getTerminalPaneState(id));
  const active = typeof document !== 'undefined' ? document.activeElement : null;

  const inputs: DirectoryPaneInput[] = ids.map((id, i) => {
    const pane = allPanes[i]!;
    // Every registry id is present in the activity snapshot (a live pane always
    // reads non-null), so this is the same object `getActivity(id)` would build.
    const activity = activityStates.get(id);
    const element = registry.get(id)?.element ?? null;
    const focused = !!element && !!active && element.contains(active);
    const title = resolveDisplayPrimary(
      deriveHeader(pane, allPanes, { appTitleForPane }).primary,
      null,
    );
    return {
      paneRef: id,
      surfaceId: id,
      title,
      focused,
      pane,
      ringing: activity?.status === 'ALERT_RINGING',
      hasTODO: activity?.todo === true,
    };
  });

  return buildDirectorySnapshot(inputs);
}
