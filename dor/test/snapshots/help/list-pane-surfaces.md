# dor list-pane-surfaces

Invocation: `dor list-pane-surfaces --help`

```text
USAGE
  dor list-pane-surfaces [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--pane <id|ref|index>] [--window <id|ref|index>]
  dor list-pane-surfaces --help

Implemented cmux-compatible command.

Defaults missing --pane to focused.

--pane filters by surface id, surface ref, or pane ref. Because Dormouse has one surface per Pane, the command currently returns zero or one surface.

Text output marks the selected surface with *, prints the surface handle, the surface title, and optional [selected].

JSON output returns pane_ref, surfaces, workspace_ref, and window_ref. Surface entries use cmux field names for index, selected state, title, and type.

The title field can look like a CWD when the shell is idle, or like the running command when a foreground command updates the title.

Text output:
  * surface:1  dor list-pane-surfaces  [selected]

FLAGS
     [--id-format]  Handle format for listed ids.
     [--json]       Print JSON output.
     [--pane]       Pane or surface target.
     [--window]     Window target.
     [--workspace]  Workspace target.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

```
