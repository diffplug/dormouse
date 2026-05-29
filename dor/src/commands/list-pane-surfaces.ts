/** cmux-compatible pane-surface listing over the shared `surface.list` renderer. */

import type { Command } from './types.js';
import { buildListCommand } from './list-surfaces.js';

export const listPaneSurfacesCommand: Command = {
  name: 'list-pane-surfaces',
  command: buildListCommand({
    mode: 'pane-surfaces',
    brief: 'List surfaces in a pane.',
    customUsage: '[--json] [--id-format refs|uuids|both] [--pane <id|ref|index>]',
    fullDescription: `Implemented cmux-compatible command.

Defaults missing --pane to focused.

--pane filters by surface id, surface ref, or pane ref. Because Dormouse has one surface per Pane, the command currently returns zero or one surface.

Text output marks the selected surface with *, prints the surface handle, the surface title, and optional [selected].

JSON output returns pane_ref, surfaces, workspace_ref, and window_ref. Surface entries use cmux field names for index, selected state, title, and type.

The title field can look like a CWD when the shell is idle, or like the running command when a foreground command updates the title.

Text output:
  * surface:1  dor list-pane-surfaces  [selected]`,
  }),
};
