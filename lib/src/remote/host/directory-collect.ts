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
