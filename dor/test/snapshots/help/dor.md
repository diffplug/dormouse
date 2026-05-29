# dor

Invocation: `dor --help`

```text
USAGE
  dor split [--auto] [--command cmd] [--down] [--json] [--left] [--minimize] [--right] [--surface id|ref|index] [--up]
  dor ensure [--json] [--minimize] [--surface id|ref|index] [--title value] <command>...
  dor list-panes [--id-format refs|uuids|both] [--json]
  dor list-pane-surfaces [--id-format refs|uuids|both] [--json] [--pane id|ref|index]
  dor --help

Dormouse bundles the dor CLI into every terminal it launches.

FLAGS
  -h --help  Print help information and exit
     --      All subsequent inputs should be interpreted as arguments

COMMANDS
  split               Create a new terminal surface by splitting an existing surface.
  ensure              Ensure one surface exists for a user-enforced title.
  list-panes          List visible panes.
  list-pane-surfaces  List surfaces in a pane.

```
