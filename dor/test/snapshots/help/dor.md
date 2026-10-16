# dor

Invocation: `dor --help`

```text
USAGE
  dor split [--left|--right|--up|--down|--auto] [--json] [--minimize] [--surface handle] [--workspace ref] [-- <command>...]
  dor ensure [--json] [--minimize] [--restart] [--surface handle] [--cwd path] [--workspace ref] -- <command>...
  dor tool [--global] [--json] [--minimize] [--fresh] [--surface handle] [--cwd path] [--workspace ref] <name> [args...]
  dor tool [--json] [--minimize] [--surface handle] [--cwd path] [--workspace ref] -- <command>...
  dor tool --list [--global] [--cwd path] [--json]
  dor open [--json] [--minimize] [--fresh] [--surface handle] [--workspace ref] [--cwd path] [--tool name] [--preview] [<path>]
  dor version [--json]
  dor skill [--install] [--json]
  dor send <surface> ([--text value] [--key value] | --stdin | --sequence json) [--json] [--raw] [--workspace ref]
  dor read <surface> [--json] [--lines count] [--scrollback] [--workspace ref]
  dor await <surface> --until condition [--json] [--timeout seconds] [--workspace ref]
  dor kill <surface> [--confirm-if-read text|--confirm-dangerously] [--json] [--workspace ref]
  dor reopen [--json]
  dor move [--new] [--focus] [--dangerously-destroy-iframe-page-state] [--json] [--workspace ref] <args>...
  dor iframe [--json] [--minimize] [--surface handle] [--workspace ref] <target>
  dor agent-browser [--key name|--session name|--surface handle] [--workspace ref] [args...]
  dor playwright [--key name] [--session name] [--surface handle] [--workspace ref] <args>...
  dor list [--all] [--command text] [--cwd path] [--json] [--kind terminal|browser|tool] [--port number] [--ports] [--view paned|zoomed|minimized] [--workspace ref] [--workspaces] [--window label]
  dor workspace new|rename|pin|unpin|close|switch|move [args...] [flags...]
  dor app restart [--json]
  dor --help

Dormouse bundles the dor CLI into every terminal it launches.

FLAGS
  -h --help  Print help information and exit
     --      All subsequent inputs should be interpreted as arguments

COMMANDS
  split          Create a new terminal surface by splitting an existing surface.
  ensure         Ensure one surface is running a command.
  tool           Run a command as a Dor Tool.
  open           Open a local file or folder with a Dor Tool (alias: o).
  version        Print the dor CLI version.
  skill          Print the Dormouse agent skill, or install its bootstrap stub.
  send           Send text or key input to a terminal surface.
  read           Read terminal text from a surface.
  await          Wait until a terminal surface finishes.
  kill           Kill a surface.
  reopen         Reopen the most recently closed surface, workspace, or window.
  move           Move a surface to another workspace.
  iframe         Open a target in an iframe surface.
  agent-browser  Drive a browser surface via your agent-browser install.
  playwright     Drive a browser surface via your playwright CLI install.
  list           List Dormouse Surfaces.
  workspace      Create, rename, pin, close, switch, or move Workspaces.
  app            Restart Dormouse Standalone, resuming supported agent sessions.

```
