# dor webview

Invocation: `dor webview --help`

```text
USAGE
  dor webview [--focus] [--json] [--minimize] [--from handle] [--workspace ref] <target>
  dor webview --help

Opens a page in a native webview surface: a real browser pane for a human to look at and use. The page loads at its own origin, so https:// pages and logins work in it.

Agents cannot read or drive a webview surface. To read or drive a page, use `dor agent-browser open <url>`.

Only the Dormouse app has webview surfaces, on macOS 14 or later and on Windows. Elsewhere the command fails before any pane opens, naming `dor iframe <url>` for an http:// page and `dor agent-browser open <url>` otherwise.

If the caller surface is an untouched terminal, Dormouse replaces that terminal with the webview. Otherwise Dormouse creates a split next to the caller/focused surface.

Focuses the created or reused Surface only with --focus; otherwise focus stays where it is. --focus with --minimize is an error.

The target is one of:
  <url>          An absolute http:// or https:// URL.
  host:port      A schemeless host:port, defaulted to http:// (e.g.
                 localhost:5173, box.ts.net:3000). The explicit port marks a
                 dev/infra server, which is http far more often than not.
  :<port>        Sugar for http://localhost:<port> (e.g. :5173).
  surface:<n>    A terminal Surface handle (surface:N, surface:self, or
                 surface:focused). Dormouse scans that terminal's
                 listening ports and opens http://localhost:<port>/; it fails if
                 the terminal owns zero or multiple ports.

Text output:
  created surface:3  "http://localhost:5173/"
  replaced surface:1  "http://localhost:5173/"

JSON output:
  {
    "status": "created",
    "surface_id": "surface:3",
    "url": "http://localhost:5173/",
    "minimized": false
  }

FLAGS
     [--focus]      Focus the created or reused Surface.
     [--json]       Print a JSON result or error object.
     [--minimize]   Create or replace the surface minimized.
     [--from]       Surface to replace or split from.
     [--workspace]  Workspace id or exact workspace-name: reference.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

ARGUMENTS
  target  URL, host:port, :port, or surface handle to open.

```
