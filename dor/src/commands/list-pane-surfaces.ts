/**
 * # `dor list-pane-surfaces`
 *
 * Usage:
 *
 * ```text
 * dor list-pane-surfaces [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--pane <id|ref|index>] [--window <id|ref|index>]
 * ```
 *
 * Behavior:
 *
 * - Implemented cmux-compatible command.
 * - Defaults missing `--pane` to `focused`.
 * - `--pane` filters by surface id, surface ref, or pane ref. Because Dormouse
 *   has one surface per Pane, the command currently returns zero or one
 *   surface.
 * - Text output marks the selected surface with `*`, prints the surface handle,
 *   the surface title, and optional `[selected]`.
 * - `--json` returns `pane_ref`, `surfaces`, `workspace_ref`, and `window_ref`.
 *   Surface entries use cmux field names for index, selected state, title, and
 *   type.
 * - The `title` field for this command is the surface title reported by
 *   `surface.list`. It can look like a CWD when the shell is idle, or like the
 *   running command when a foreground command updates the title.
 *
 * Text shape:
 *
 * ```text
 * * surface:1  dor list-pane-surfaces  [selected]
 * ```
 */

import type { Command } from './types.js';
import { runListCommand } from './list-surfaces.js';

export const listPaneSurfacesCommand: Command = {
  name: 'list-pane-surfaces',
  usage: 'Usage: dor list-pane-surfaces [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--pane <id|ref|index>] [--window <id|ref|index>]\n',
  run: (args, options) => runListCommand('pane-surfaces', args, options),
};
