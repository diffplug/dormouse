# dor ensure

Invocation: `dor ensure --help`

```text
USAGE
  dor ensure [--title <title>] [--minimize] [--surface <id|ref|index>] [--json] -- <command...>
  dor ensure --help

Ensures one surface exists in the current workspace for a user-enforced title. The idempotency key is always the user-enforced title.

If --title is omitted, Dormouse derives the title from the command after --.

If a surface in the current workspace already has the enforced title, Dormouse returns that surface and does not start another command.

If no surface has that enforced title, Dormouse creates a split, starts the command, marks the surface title as user-enforced, and returns the new surface.

A user-enforced title is visible in the UI and must not be overwritten by terminal title escape sequences from the running process.

Matching uses Dormouse metadata, not process inspection. Minimized surfaces participate in matching. Closed/killed surfaces do not participate in matching.

--minimize applies only when creating a new surface; it does not minimize an existing match.

--surface selects the surface to split only when creating a new surface. If omitted, Dormouse uses the same caller/focused fallback as dor split.

No workspace argument exists until Dormouse supports multiple workspaces.

Text output:
  created surface:3  "dev server"
  existing surface:3  "dev server"

JSON output:
  {
    "status": "created",
    "surface_id": "pane-def",
    "surface_ref": "surface:3",
    "title": "dev server",
    "command": "pnpm dev:workspace",
    "minimized": false
  }

FLAGS
     [--json]      Print JSON output.
     [--minimize]  Create the surface minimized.
     [--surface]   Surface to split when creating.
     [--title]     User-enforced surface title.
  -h  --help       Print help information and exit
      --           All subsequent inputs should be interpreted as arguments

ARGUMENTS
  command...  Command to run.

```
