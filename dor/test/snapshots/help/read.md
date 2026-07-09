# dor read

Invocation: `dor read --help`

```text
USAGE
  dor read <surface> [--json] [--lines count] [--scrollback]
  dor read --help

Reads the visible screen text from the target terminal surface. Use --scrollback to include terminal history, and --lines to limit how much text is returned.

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
  -h  --help         Print help information and exit
      --             All subsequent inputs should be interpreted as arguments

ARGUMENTS
  surface  Surface to read.

```
