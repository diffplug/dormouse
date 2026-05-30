/** cmux-compatible pane listing over the shared `surface.list` renderer. */

import type { Command } from './types.js';
import { buildListCommand } from './list-surfaces.js';

export const listPanesCommand: Command = {
  name: 'list-panes',
  command: buildListCommand({
    mode: 'panes',
    brief: 'List visible panes.',
    customUsage: '[--json] [--id-format refs|uuids|both]',
    fullDescription: `Implemented cmux-compatible command.

Lists visible Panes grouped by Pane handle.

Text output marks the focused Pane with *, prints the pane handle, [N surface] / [N surfaces], and optional [focused].

JSON output returns panes, workspace_ref, and window_ref. Pane entries use cmux field names for focus, index, selected surface, and surface refs/ids.

Dormouse currently has one terminal surface per Pane, so runtime surface_count is 1 for each Pane.

Text output:
  * pane:1  [1 surface]  [focused]`,
  }),
};
