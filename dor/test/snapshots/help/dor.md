# dor

Invocation: `dor --help`

```text
USAGE
  dor split [--left|--right|--up|--down|--auto] [--json] [--minimize] [--surface id|ref|index] [-- <command>...]
  dor ensure [--json] [--minimize] [--restart] [--surface id|ref|index] [--cwd path] -- <command>...
  dor version
  dor send [--key value] [--raw] [--sequence json] [--stdin] [--surface id|ref|index] [--text value] [<text>]
  dor read [--json] [--lines count] [--scrollback] [--surface id|ref|index]
  dor kill --surface id|ref|index [--confirm-if-read text|--confirm-dangerously]
  dor iframe [--json] [--minimize] [--surface id|ref|index] <url>
  dor agent-browser [--key name|--session name] [args...]
  dor identify [--id-format refs|uuids|both]
  dor list-panes [--id-format refs|uuids|both] [--json]
  dor list-pane-surfaces [--id-format refs|uuids|both] [--json] [--pane id|ref|index]
  dor --help

Dormouse bundles the dor CLI into every terminal it launches.

FLAGS
  -h --help  Print help information and exit
     --      All subsequent inputs should be interpreted as arguments

COMMANDS
  split               Create a new terminal surface by splitting an existing surface.
  ensure              Ensure one surface is running a command.
  version             Print the dor CLI version.
  send                Send text or key input to a terminal surface.
  read                Read terminal text from a surface.
  kill                Kill a terminal surface.
  iframe              Open a URL in an iframe surface.
  agent-browser       Drive a browser surface via your agent-browser install (alias: dor ab).
  identify            Print JSON identifying this terminal within Dormouse.
  list-panes          List visible panes.
  list-pane-surfaces  List surfaces in a pane.

```
