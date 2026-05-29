# dor iframe

Invocation: `dor iframe --help`

```text
USAGE
  dor iframe [--json] [--minimize] [--surface id|ref|index] <url>
  dor iframe --help

Opens a URL in a high-fidelity iframe surface for human inspection.

If the caller surface is an untouched terminal, Dormouse replaces that terminal with the iframe. Otherwise Dormouse creates a split next to the caller/focused surface.

The URL must be an absolute http:// or https:// URL. Dormouse does not infer schemes.

Text output:
  created surface:3  "https://localhost:5173"
  replaced surface:1  "https://localhost:5173"

JSON output:
  {
    "status": "created",
    "surface_id": "pane-abc",
    "surface_ref": "surface:3",
    "url": "https://localhost:5173",
    "minimized": false
  }

FLAGS
     [--json]      Print JSON output.
     [--minimize]  Create or replace the surface minimized.
     [--surface]   Surface to replace or split from.
  -h  --help       Print help information and exit
      --           All subsequent inputs should be interpreted as arguments

ARGUMENTS
  url  URL to open.

```
