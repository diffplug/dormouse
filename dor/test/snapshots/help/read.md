# dor read

Invocation: `dor read --help`

```text
USAGE
  dor read [--json] [--lines count] [--scrollback] [--surface id|ref|index]
  dor read --help

By default, reads the visible screen text from the target surface. Use --scrollback to include terminal history, and --lines to limit how much text is returned.

If --surface is omitted, Dormouse uses the caller surface from DORMOUSE_SURFACE_ID, then the focused surface.

Text mode prints terminal text directly.

JSON output:
  {
    "workspace_ref": "workspace:1",
    "surface_id": "...",
    "surface_ref": "surface:3",
    "text": "..."
  }

FLAGS
     [--json]        Print JSON output.
     [--lines]       Maximum number of lines to return.
     [--scrollback]  Include terminal scrollback/history instead of only the visible screen.
     [--surface]     Surface to read.
  -h  --help         Print help information and exit
      --             All subsequent inputs should be interpreted as arguments

```
