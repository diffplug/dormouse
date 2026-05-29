# dor split

Invocation: `dor split --help`

```text
USAGE
  dor split [--left|--right|--up|--down|--auto] [--command <cmd>] [--minimize] [--surface <id|ref|index>] [--json]
    Direction flags are mutually exclusive; --auto is the default.
  dor split --help

If no direction is provided, --auto is used. --auto chooses right when the target surface is wide and down when it is narrow.

--surface selects the surface to split. If omitted, Dormouse uses the caller surface when available, then the focused surface.

--command runs the given command as the new terminal surface's initial command.

--minimize creates the surface and immediately sends it to the minimized area.

No workspace argument exists until Dormouse supports multiple workspaces.

split does not know about non-terminal surface types. Compose future content commands through the terminal:

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
     [--auto]      Default; choose right when wide and down when narrow.
     [--command]   Run an initial command in the new surface.
     [--down]      Split below the target surface.
     [--json]      Print JSON output.
     [--left]      Split left of the target surface.
     [--minimize]  Create the surface minimized.
     [--right]     Split right of the target surface.
     [--surface]   Surface to split.
     [--up]        Split above the target surface.
  -h  --help       Print help information and exit
      --           All subsequent inputs should be interpreted as arguments

```
