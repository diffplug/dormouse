# dor split

Invocation: `dor split --help`

```text
USAGE
  dor split [--left|--right|--up|--down|--auto] [--json] [--minimize] [--surface handle] [--workspace ref] [-- <command>...]
  dor split --help

If no direction is provided, --auto is used. --auto chooses right when the target surface is wide, down when it is narrow, and right when the target is minimized.

The new terminal starts in the directory where you invoke dor split. --surface and --workspace control placement; they do not change the working directory.

Use -- followed by a command to run an initial command in the new terminal surface.

Supplying -- or an initial command leaves focus unchanged. "dor split -- <command>" runs the command in the new terminal, and "dor split --" opens a blank terminal. Without -- or an initial command, dor split focuses the new surface.

--minimize creates the surface and immediately sends it to the minimized area.

--surface selects the reference Surface for placement. If it is minimized, the new Surface is created minimized too and inserted immediately to the right of its Door. If --surface is omitted, Dormouse uses the caller's Surface, or an auxiliary helper's source Surface. When --workspace selects another Workspace, placement defaults to that Workspace's focused Surface.

From an auxiliary helper, split creates a separate terminal and leaves the helper in place. Helpers cannot be explicit Surface targets, including surface:self.

split creates terminal Surfaces. Compose browser content commands through the initial command:

  dor split --right -- dor iframe :5173
  dor split --auto -- dor agent-browser open https://example.com

Text output:
  created surface:2  [right]
  created surface:3  [down]  [minimized]  "pnpm dev"

JSON output:
  {
    "status": "created",
    "surface_id": "surface:2",
    "direction": "right",
    "minimized": false,
    "command": "pnpm dev"
  }

FLAGS
     [--left|--right|--up|--down|--auto]
                  Split direction. Mutually exclusive; default is --auto.
     [--json]       Print JSON output.
     [--minimize]   Create the surface minimized.
     [--surface]    Reference Surface for placement.
     [--workspace]  Workspace to act in, instead of the caller's.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

```
