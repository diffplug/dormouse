# dor move

Invocation: `dor move --help`

```text
USAGE
  dor move <surface> <workspace>|--new [--workspace source] [--focus] [--dangerously-destroy-iframe-page-state] [--json]
  dor move --help

Moves a Surface within this Window, keeping its id and ref. Focus stays put unless --focus is set. --new creates a Workspace; it is refused for the source's only Surface.

Plain iframes reopen at their saved URL and require --dangerously-destroy-iframe-page-state. Dirty or pending Tools cannot move, even with that flag.

After your own pane moves, unscoped ensure searches the destination and can duplicate work left behind.

To move an entire Workspace to another Window or strip position, use dor workspace move.

Text output: moved surface:4 workspace:2

FLAGS
     [--new]                                    Create a new destination Workspace.
     [--focus]                                  Follow the moved Surface into passthrough.
     [--dangerously-destroy-iframe-page-state]  Accept reopening an iframe at its saved URL.
     [--json]                                   Print JSON output.
     [--workspace]                              Workspace to act in, instead of the caller's.
  -h  --help                                    Print help information and exit
      --                                        All subsequent inputs should be interpreted as arguments

ARGUMENTS
  args...  Surface and destination Workspace.

```
