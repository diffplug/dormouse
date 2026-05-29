/**
 * # `dor list-panes`
 *
 * Usage:
 *
 * ```text
 * dor list-panes [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--window <id|ref|index>]
 * ```
 *
 * Behavior:
 *
 * - Implemented cmux-compatible command.
 * - Lists visible Panes, grouped by `paneRef` in the `surface.list` response.
 * - Text output marks the focused Pane with `*`, prints the pane handle,
 *   `[N surface]` / `[N surfaces]`, and optional `[focused]`.
 * - `--json` returns `panes`, `workspace_ref`, and `window_ref`. Pane entries
 *   use cmux field names for focus, index, selected surface, and surface
 *   refs/ids.
 * - Dormouse currently has one terminal surface per Pane, so runtime
 *   `surface_count` is `1` for each Pane.
 *
 * Text shape:
 *
 * ```text
 * * pane:1  [1 surface]  [focused]
 * ```
 */

import type { Command } from './types.js';
import { buildListCommand } from './list-surfaces.js';

export const listPanesCommand: Command = {
  name: 'list-panes',
  usage: 'Usage: dor list-panes [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--window <id|ref|index>]\n',
  command: buildListCommand('panes', 'List visible panes.'),
};
