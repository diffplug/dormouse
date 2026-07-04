/**
 * Pure `directory.snapshot` entry construction (remote-api.md → "Directory").
 * Split from the impure collector (`directory-collect.ts`) so the mapping from
 * pane state to the wire `DirectoryEntry` is unit-testable without the terminal
 * registry, xterm, or the DOM.
 */

import type { DirectoryEntry } from 'server-lib-common';
import type { TerminalPaneState } from '../../lib/terminal-state';

/** Everything one directory entry needs, already resolved from the live stores. */
export interface DirectoryPaneInput {
  paneRef: string;
  surfaceId: string;
  /** The derived title the wall header shows (deriveHeader + resolveDisplayPrimary). */
  title: string;
  /** Focused on the Host. */
  focused: boolean;
  /** The pane's PTY process is still alive (not a lingering exited surface). */
  alive: boolean;
  pane: TerminalPaneState;
  /** The pane's alert is ringing on the Host (alert-manager). */
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

export function buildDirectorySnapshot(inputs: readonly DirectoryPaneInput[]): DirectoryEntry[] {
  return inputs.map(buildDirectoryEntry);
}
