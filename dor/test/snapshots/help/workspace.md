# dor workspace

Invocation: `dor workspace --help`

```text
USAGE
  dor workspace new [name] [--json]
  dor workspace rename <workspace> <name> [--json]
  dor workspace close <workspace> [--force] [--json]
  dor workspace switch <workspace> [--json]
  dor workspace move <workspace> [--window <label|new>] [--index <n>] [--dangerously-destroy-iframe-page-state] [--json]
  dor workspace --help

Manages this Window's Workspaces. Listing them is dor list --workspaces (the overview) and dor list --all (every Workspace's Surfaces); this command only mutates.

A <workspace> target is workspace:<n> — a stable number that a strip reorder or a move between windows never changes — or workspace:<name>, which resolves only when exactly one Workspace carries that name and otherwise fails listing the candidates. Both forms are also accepted bare ("2", "build"). A target in another window is routed there.

new creates a Workspace in the background and prints its ref: it never moves the user to it, since that is a larger theft than the focus a bare dor split takes. Use dor workspace switch to activate one. Without a name, the Workspace is named "Workspace N".

close archives and kills every Surface in the Workspace. It refuses — raising no confirmation, because the caller is a command rather than someone watching the Wall — when the Workspace holds a Surface the user has typed into or a running command; --force closes it anyway. The last remaining Workspace cannot be closed.

move puts a Workspace in another window (--window <label>, or --window new to tear it out into its own) and/or at a strip position (--index <n>, 0-based). Nothing is archived or killed: its terminals, notes, and pins travel whole. The one thing a move between windows cannot carry is a plain iframe's page state — the document cannot leave its webview, so the iframe reopens at its saved URL — and the move is refused when the Workspace holds one unless --dangerously-destroy-iframe-page-state is passed. Agent-browser Surfaces are not affected.

Text output:
  created workspace:2 "build"
  closed workspace:2 "build"
  moved workspace:2 "build"

JSON output:
  {
    "status": "created",
    "workspace_id": "...",
    "workspace_ref": "workspace:2",
    "name": "build"
  }

FLAGS
     [--force]                                  Close even when the Workspace holds running or touched Surfaces.
     [--json]                                   Print JSON output.
     [--window]                                 move: the window to move to (a label, or "new").
     [--index]                                  move: the 0-based strip position to move to.
     [--dangerously-destroy-iframe-page-state]  move: accept losing every iframe Surface's page state.
  -h  --help                                    Print help information and exit
      --                                        All subsequent inputs should be interpreted as arguments

ARGUMENTS
  args...  Action, then its arguments.

```
