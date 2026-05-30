# dor list-panes

Invocation: `dor list-panes --help`

```text
USAGE
  dor list-panes [--json] [--id-format refs|uuids|both]
  dor list-panes --help

Implemented cmux-compatible command.

Lists visible Panes grouped by Pane handle.

Text output marks the focused Pane with *, prints the pane handle, [N surface] / [N surfaces], and optional [focused].

JSON output returns panes, workspace_ref, and window_ref. Pane entries use cmux field names for focus, index, selected surface, and surface refs/ids.

Dormouse currently has one terminal surface per Pane, so runtime surface_count is 1 for each Pane.

Text output:
  * pane:1  [1 surface]  [focused]

FLAGS
     [--id-format]  Handle format for listed ids.
     [--json]       Print JSON output.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

```
