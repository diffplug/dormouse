# dor identify

Invocation: `dor identify --help`

```text
USAGE
  dor identify [--id-format refs|uuids|both]
  dor identify --help

Inspired by cmux identify.

Prints a JSON object describing where this dor invocation sits within Dormouse: the caller surface (resolved from DORMOUSE_SURFACE_ID), the focused surface, and the control endpoint paths injected into the terminal's environment.

caller is null when no visible surface matches the invoking terminal (e.g. it was minimized to a Door); focused is null when no surface is focused. Path fields are null when the corresponding environment variable is absent.

Output is always JSON:
  {
    "caller": {
      "is_browser_surface": false,
      "pane_ref": "pane:1",
      "surface_ref": "surface:1",
      "surface_type": "terminal",
      "window_ref": "window:1",
      "workspace_ref": "workspace:1"
    },
    "cli_js_path": "/path/to/dor-cli/dist/dor.js",
    "focused": { ... },
    "node_path": "/path/to/node",
    "socket_path": "/path/to/dormouse-control.sock"
  }

FLAGS
     [--id-format]  Handle format for surface handles.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

```
