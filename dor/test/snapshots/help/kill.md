# dor kill

Invocation: `dor kill --help`

```text
USAGE
  dor kill --surface id|ref|index [--confirm-if-read text|--confirm-dangerously] [--json]
  dor kill --help

Kills a surface. One confirmation mode is required.

--confirm-if-read kills only if dor read --surface <surface> would return visible text containing the provided text. The text must contain at least 4 non-whitespace characters.

--confirm-dangerously kills without further confirmation. Use only when automation has already validated the target.

Text output:
  killed surface:3

JSON output:
  {
    "status": "killed",
    "surface_id": "...",
    "surface_ref": "surface:3"
  }

FLAGS
     [--confirm-dangerously]  Kill without further confirmation.
     [--confirm-if-read]      Kill only if dor read contains this text.
     [--json]                 Print JSON output.
      --surface               Surface to kill.
  -h  --help                  Print help information and exit
      --                      All subsequent inputs should be interpreted as arguments

```
