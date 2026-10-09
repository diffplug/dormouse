# dor reopen

Invocation: `dor reopen --help`

```text
USAGE
  dor reopen [--json]
  dor reopen --help

Reopens the newest close this window remembers, as the Reopen Closed menu item and command-mode u do. Only a close Reopen can restore is remembered: a clean built-in file or folder viewer, an iframe browser, or a Workspace or window holding nothing else but untouched shells. A shell someone typed into, a running command, or unsaved work is never remembered, so closing one asks first. A reopened surface is a new surface with a new id, at the path or URL it had. Nothing is remembered across a restart.

Text output:
  reopened surface:4

JSON output:
  {
    "status": "reopened",
    "kind": "surface",
    "surface_id": "...",
  }

FLAGS
     [--json]  Print JSON output.
  -h  --help   Print help information and exit
      --       All subsequent inputs should be interpreted as arguments

```
