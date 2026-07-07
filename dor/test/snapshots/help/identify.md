# dor identify

Invocation: `dor identify --help`

```text
USAGE
  dor identify [--id-format refs|uuids|both]
  dor identify --help

Prints a JSON object describing where this dor invocation sits within Dormouse: the caller surface (resolved from DORMOUSE_SURFACE_ID), the focused surface, and the hosting app.

host is "vscode" or "standalone". host_workspace is what the owning VS Code window has open — the .code-workspace file when one is loaded, else the root workspace folder; it is always null under the standalone app.

caller is null when no visible surface matches the invoking terminal (e.g. it was minimized to a Door); focused is null when no surface is focused. Environment-derived fields are null when the corresponding variable is absent.

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
    "host": "vscode",
    "host_workspace": "/path/to/project",
    "node_path": "/path/to/node"
  }

FLAGS
     [--id-format]  Handle format for surface handles.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

```
