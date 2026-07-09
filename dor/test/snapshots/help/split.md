# dor split

Invocation: `dor split --help`

```text
USAGE
  dor split [--left|--right|--up|--down|--auto] [--json] [--minimize] [--surface id|ref] [-- <command>...]
  dor split --help

If no direction is provided, --auto is used. --auto chooses right when the target surface is wide, down when it is narrow, and right when the target is minimized.

Use -- followed by a command to run an initial command in the new terminal surface. Bare split focuses the new surface so you can start typing in it; split with an initial command runs it in the background and leaves focus on the calling surface.

--minimize creates the surface and immediately sends it to the minimized area.

--surface selects the surface to split. If the target is minimized, the new surface is created minimized too and inserted immediately to the right of the target door. If omitted, Dormouse uses the caller surface when available, then the focused surface.

split creates terminal Surfaces. Compose browser content commands through the initial command:

  dor split --right -- dor iframe https://example.com
  dor split --auto -- dor agent-browser open https://example.com

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
     [--json]      Print JSON output.
     [--minimize]  Create the surface minimized.
     [--surface]   Surface to split.
  -h  --help       Print help information and exit
      --           All subsequent inputs should be interpreted as arguments

```
