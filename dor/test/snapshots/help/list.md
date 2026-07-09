# dor list

Invocation: `dor list --help`

```text
USAGE
  dor list [--ports] [--json] [--id-format refs|uuids|both]
  dor list --help

Lists every Surface in the current Workspace — terminals and browser Surfaces, including minimized ones (view "minimized").

Text output prints one row per Surface: a * marks the focused Surface, then the handle, kind, render mode ("-" for terminals), view, location (cwd for terminals, URL for browser Surfaces), and title. Trailing tags: (you) for the calling terminal, [ringing], [todo], and listening ports with --ports.

--ports adds each terminal's listening TCP ports. The host shells out per pane (lsof / PowerShell), so it is opt-in; remote sessions report none.

JSON output (--json) adds top-level caller_surface_ref and focused_surface_ref — the calling and focused Surfaces, null when neither is in the list — plus workspace_ref, window_ref, and a host block (app, workspace, cli_js_path, node_path): the identity dump dor identify used to print.

Text output:
  * surface:1  terminal  -              paned  ~/projects/site  pnpm dev  :5173

FLAGS
     [--id-format]  Handle format for listed ids.
     [--json]       Print JSON output.
     [--ports]      Include each terminal's listening ports.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

```
