# dor workspace

Invocation: `dor workspace --help`

```text
USAGE
  dor workspace new [name] [--json]
  dor workspace rename <workspace> <name> [--json]
  dor workspace close <workspace> [--force] [--json]
  dor workspace switch <workspace> [--json]
  dor workspace --help

Manages this Window's Workspaces. Listing them is dor list --workspaces (the overview) and dor list --all (every Workspace's Surfaces); this command only mutates.

A <workspace> target is workspace:<n> — positional, so a strip reorder renumbers it — or workspace:<name>, which resolves only when exactly one Workspace carries that name and otherwise fails listing the candidates. Both forms are also accepted bare ("2", "build").

new creates a Workspace in the background and prints its ref: it never moves the user to it, since that is a larger theft than the focus a bare dor split takes. Use dor workspace switch to activate one. Without a name, the Workspace is named "Workspace N".

close archives and kills every Surface in the Workspace. It refuses — raising no confirmation, because the caller is a command rather than someone watching the Wall — when the Workspace holds a Surface the user has typed into or a running command; --force closes it anyway. The last remaining Workspace cannot be closed.

Text output:
  created workspace:2 "build"
  closed workspace:2 "build"

JSON output:
  {
    "status": "created",
    "workspace_id": "...",
    "workspace_ref": "workspace:2",
    "name": "build"
  }

FLAGS
     [--force]  Close even when the Workspace holds running or touched Surfaces.
     [--json]   Print JSON output.
  -h  --help    Print help information and exit
      --        All subsequent inputs should be interpreted as arguments

ARGUMENTS
  args...  Action, then its arguments.

```
