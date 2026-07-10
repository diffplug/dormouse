# dor iframe

Invocation: `dor iframe --help`

```text
USAGE
  dor iframe [--json] [--minimize] [--surface id|ref] <target>
  dor iframe --help

Opens a target in a high-fidelity iframe surface for human inspection.

If the caller surface is an untouched terminal, Dormouse replaces that terminal with the iframe. Otherwise Dormouse creates a split next to the caller/focused surface.

The target is one of:
  <url>          An absolute http:// or https:// URL (an explicit scheme is
                 always honored).
  host:port      A schemeless host:port, defaulted to http:// (e.g.
                 localhost:5173, box.ts.net:3000). The explicit port marks a
                 dev/infra server, which is http far more often than not.
  :<port>        Sugar for http://localhost:<port> (e.g. :5173).
  surface:<ref>  A terminal Surface handle (surface:N, surface:self,
                 surface:focused, or a stable id). Dormouse scans that terminal's
                 listening ports and opens http://localhost:<port>/; it fails if
                 the terminal owns zero or multiple ports.

Text output:
  created surface:3  "http://localhost:5173"
  replaced surface:1  "http://localhost:5173"

JSON output:
  {
    "status": "created",
    "surface_id": "pane-abc",
    "surface_ref": "surface:3",
    "url": "http://localhost:5173",
    "minimized": false
  }

FLAGS
     [--json]      Print JSON output.
     [--minimize]  Create or replace the surface minimized.
     [--surface]   Surface to replace or split from.
  -h  --help       Print help information and exit
      --           All subsequent inputs should be interpreted as arguments

ARGUMENTS
  target  URL, host:port, :port, or surface handle to open.

```
