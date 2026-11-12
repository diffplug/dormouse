# dor split

Invocation: `dor split --help`

```text
USAGE
  dor split [--left|--right|--up|--down|--auto] [--focus] [--json] [--minimize] [--surface handle] [--workspace ref] [-- <command>...]
  dor split --help

If no direction is provided, --auto is used. --auto chooses right when the target surface is wide, down when it is narrow, and right when the target is minimized.

The new terminal starts in the directory where you invoke dor split. --surface and --workspace control placement; they do not change the working directory.

Use -- followed by a command to run an initial command in the new terminal surface. Only split's own options come before --.

Typed alone at a prompt, the command focuses the Surface it opens or reuses; an agent's or a script's invocation leaves focus where it is. --focus or --focus=false decides either way. --minimize turns the default off, and --focus with --minimize is an error.

--minimize creates the surface and immediately sends it to the minimized area.

--surface selects the reference Surface for placement. If it is minimized, the new Surface is created minimized too and inserted immediately to the right of its Door. If --surface is omitted, Dormouse uses the caller's Surface, or an auxiliary helper's source Surface. When --workspace selects another Workspace, placement defaults to that Workspace's focused Surface.

From an auxiliary helper, split creates a separate terminal and leaves the helper in place. Helpers cannot be explicit Surface targets, including surface:self.

split creates terminal Surfaces. Compose browser content commands through the initial command:

  dor split --right -- dor iframe :5173
  dor split --auto -- dor agent-browser open https://example.com

split answers once the Surface exists, without waiting for an initial command to start, so its JSON command_state is always unconfirmed; check readiness separately.

Text output:
  created surface:2  [right]
  created surface:3  [down]  [minimized]  "pnpm dev"

JSON output:
  {
    "status": "created",
    "command_state": "unconfirmed",
    "surface_id": "surface:2",
    "direction": "right",
    "minimized": false,
    "command": "pnpm dev"
  }

FLAGS
     [--left|--right|--up|--down|--auto]
                  Split direction. Mutually exclusive; default is --auto.
     [--focus]      Focus the created or reused Surface (default: only when typed alone at a prompt).
     [--json]       Print a JSON result or error object.
     [--minimize]   Create the surface minimized.
     [--surface]    Reference Surface for placement.
     [--workspace]  Workspace to act in, instead of the caller's.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

```
