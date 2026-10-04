/**
 * Pure `directory.snapshot` entry construction (remote-api.md → "Directory").
 * Split from the impure collector (`directory-collect.ts`) so the mapping from
 * pane state to the wire `DirectoryEntry` is unit-testable without the terminal
 * registry, xterm, or the DOM.
 */

import type { DirectoryEntry, DirectoryWorkspace } from 'remote-lib-common';
import type { TerminalPaneState } from '../../lib/terminal-state';

/** Everything one directory entry needs, already resolved from the live stores. */
export interface DirectoryPaneInput {
  paneRef: string;
  surfaceId: string;
  /** The derived title the wall header shows (deriveHeader + resolveDisplayPrimary). */
  title: string;
  /** Focused on the Burrow. */
  focused: boolean;
  /** The pane's PTY process is still alive (not a lingering exited surface). */
  alive: boolean;
  pane: TerminalPaneState;
  /** The pane's alert is ringing on the Burrow (alert-manager). */
  ringing: boolean;
  /** The pane has an outstanding TODO. */
  hasTODO: boolean;
}

export function buildDirectoryEntry(input: DirectoryPaneInput): DirectoryEntry {
  const { pane } = input;
  // `exitCode` only when the last command finished with a real code; `activity`
  // maps straight across (ShellActivity['kind'] is the wire union verbatim).
  const exitCode = pane.activity.kind === 'finished' ? pane.activity.exitCode : undefined;
  const cwd = pane.cwd?.path;
  return {
    paneRef: input.paneRef,
    surfaceId: input.surfaceId,
    type: 'terminal',
    title: input.title,
    focused: input.focused,
    activity: pane.activity.kind,
    ...(exitCode !== undefined ? { exitCode } : {}),
    alive: input.alive,
    ...(cwd ? { cwd } : {}),
    ringing: input.ringing,
    hasTODO: input.hasTODO,
  };
}

/** One Workspace of the answering Window, as the directory needs it. */
export interface DirectoryWorkspaceInput extends DirectoryWorkspace {
  /** Its member Surfaces (panes ∪ Doors). */
  surfaceIds: readonly string[];
}

/**
 * The entries in `workspaces` order — the Window's strip order — each naming
 * its Workspace, and within one Workspace in `inputs` order. A pane no
 * Workspace claims (its Wall has not published yet) follows, ungrouped. With no
 * `workspaces` — a host whose refs are not unique across Windows — the entries
 * stay in `inputs` order and name none.
 */
export function buildDirectorySnapshot(
  inputs: readonly DirectoryPaneInput[],
  workspaces: readonly DirectoryWorkspaceInput[] = [],
): DirectoryEntry[] {
  const owner = new Map<string, number>();
  workspaces.forEach((workspace, index) => {
    for (const id of workspace.surfaceIds) if (!owner.has(id)) owner.set(id, index);
  });
  return inputs
    .map((input) => ({ input, index: owner.get(input.surfaceId) ?? workspaces.length }))
    // Stable, so each Workspace keeps the inputs' own order.
    .sort((a, b) => a.index - b.index)
    .map(({ input, index }) => {
      const entry = buildDirectoryEntry(input);
      const workspace = workspaces[index];
      if (!workspace) return entry;
      const { ref, name, active } = workspace;
      return { ...entry, workspace: { ref, name, active } };
    });
}
