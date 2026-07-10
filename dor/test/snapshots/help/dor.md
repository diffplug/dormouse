# dor

Invocation: `dor --help`

```text
USAGE
  dor split [--left|--right|--up|--down|--auto] [--json] [--minimize] [--surface id|ref] [-- <command>...]
  dor ensure [--json] [--minimize] [--restart] [--surface id|ref] [--cwd path] -- <command>...
  dor version [--json]
  dor skill [--install] [--json]
  dor send <surface> ([--text value] [--key value] | --stdin | --sequence json) [--json] [--raw]
  dor read <surface> [--json] [--lines count] [--scrollback]
  dor kill <surface> [--confirm-if-read text|--confirm-dangerously] [--json]
  dor iframe [--json] [--minimize] [--surface id|ref] <url>
  dor agent-browser [--key name|--session name] [args...]
  dor list [--command text] [--cwd path] [--id-format refs|ids|both] [--json] [--kind terminal|browser] [--port number] [--ports] [--view paned|zoomed|minimized]
  dor --help

Dormouse bundles the dor CLI into every terminal it launches.

FLAGS
  -h --help  Print help information and exit
     --      All subsequent inputs should be interpreted as arguments

COMMANDS
  split          Create a new terminal surface by splitting an existing surface.
  ensure         Ensure one surface is running a command.
  version        Print the dor CLI version.
  skill          Print the Dormouse agent skill, or install its bootstrap stub.
  send           Send text or key input to a terminal surface.
  read           Read terminal text from a surface.
  kill           Kill a surface.
  iframe         Open a URL in an iframe surface.
  agent-browser  Drive a browser surface via your agent-browser install (alias: dor ab).
  list           List Dormouse Surfaces.

```
