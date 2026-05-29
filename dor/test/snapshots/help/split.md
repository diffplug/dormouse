# dor split

Invocation: `dor split --help`

```text
USAGE
  dor split [--left|--right|--up|--down|--auto] [--command cmd] [--json] [--minimize] [--surface id|ref|index]
  dor split --help

If no direction is provided, --auto is used. --auto chooses right when the target surface is wide and down when it is narrow.

--command runs the given command as the new terminal surface's initial command.

--minimize creates the surface and immediately sends it to the minimized area.

--surface selects the surface to split. If omitted, Dormouse uses the caller surface when available, then the focused surface.

split does not know about non-terminal surface types. Compose future content commands through the initial command:

  dor split --right --command "dor iframe https://example.com"
  dor split --auto --command "dor agent-browser open https://example.com"

Text output:
  created surface:2  [right]
  created surface:3  [down]  [minimized]  "pnpm dev"

JSON output:
  {
    "status": "created",
    "surface_id": "pane-abc",
    "surface_ref": "surface:2",
    "direction": "right",
    "minimized": false,
    "command": "pnpm dev"
  }

FLAGS
     [--left|--right|--up|--down|--auto]
                  Split direction. Mutually exclusive; default is --auto.
     [--command]   Run an initial command in the new surface.
     [--json]      Print JSON output.
     [--minimize]  Create the surface minimized.
     [--surface]   Surface to split.
  -h  --help       Print help information and exit
      --           All subsequent inputs should be interpreted as arguments

```
