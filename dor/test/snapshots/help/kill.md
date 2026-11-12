# dor kill

Invocation: `dor kill --help`

```text
USAGE
  dor kill <surface> [--confirm-if-read text|--confirm-dangerously] [--json] [--workspace ref]
  dor kill --help

Kills a surface. One confirmation mode is required.

--confirm-if-read kills only if dor read <surface> would return visible text containing the provided text. The text must contain at least 4 non-whitespace characters. Join a value that starts with "-" to the flag (--confirm-if-read=--watch).

--confirm-dangerously kills without further confirmation. Use only when automation has already validated the target.

Text output:
  killed surface:3

JSON output:
  {
    "status": "killed",
    "surface_id": "..."
  }

FLAGS
     [--confirm-dangerously]  Kill without further confirmation.
     [--confirm-if-read]      Kill only if dor read contains this text.
     [--json]                 Print a JSON result or error object.
     [--workspace]            Workspace id or exact workspace-name: reference.
  -h  --help                  Print help information and exit
      --                      All subsequent inputs should be interpreted as arguments

ARGUMENTS
  surface  Surface to kill.

```
