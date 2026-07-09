# dor list

Invocation: `dor list --help`

```text
USAGE
  dor list [--kind terminal|browser] [--view paned|zoomed|minimized] [--command text] [--cwd path] [--port number] [--ports] [--json] [--id-format refs|ids|both]
  dor list --help

Lists every Surface in the current Workspace — terminals and browser Surfaces, including minimized ones (view "minimized").

Text output prints one row per Surface: a * marks the focused Surface, then the handle, kind, render mode ("-" for terminals), view, location (cwd for terminals, URL for browser Surfaces), and title. Trailing tags: (you) for the calling terminal, [ringing], [todo], and listening ports with --ports.

--ports adds each terminal's listening TCP ports. The host shells out per pane (lsof / PowerShell), so it is opt-in; remote sessions report none.

--port <number> filters to terminal Surfaces listening on that port. It implies the same opt-in port scan as --ports, includes port details in JSON, and shows port tags in text output.

Filters are ANDed. --command is an exact match against the running command reported by shell integration. --cwd resolves to an absolute path like dor ensure --cwd, relative to the invoking shell's PWD when available.

JSON output (--json) always includes both stable ids and refs, and adds top-level caller_surface_ref/caller_surface_id and focused_surface_ref/focused_surface_id — the calling and focused Surfaces, null when neither is in the list — plus workspace_ref, window_ref, and a host block (app, workspace, cli_js_path, node_path): the identity dump dor identify used to print.

Text output:
  * surface:1  terminal  -              paned  ~/projects/site  pnpm dev  :5173

FLAGS
     [--command]    Exact running command to match.
     [--cwd]        Working directory to match.
     [--id-format]  Handle format for text output.
     [--json]       Print JSON output.
     [--kind]       Surface kind to show.
     [--port]       Show terminal Surfaces listening on this TCP port.
     [--ports]      Include each terminal's listening ports.
     [--view]       Surface view to show.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

```
