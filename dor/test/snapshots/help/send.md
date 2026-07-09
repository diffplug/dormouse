# dor send

Invocation: `dor send --help`

```text
USAGE
  dor send <surface> ([--text value] [--key value] | --stdin | --sequence json) [--json] [--raw]
  dor send --help

Sends text or key input to a target terminal surface. Special keys must be sent with --key so values like "enter" are never confused with literal text.

Exactly one input mode is required: --text/--key, --stdin, or --sequence. --text and --key may be combined only in that order; text is sent first, then the key. Duplicate input flags are rejected. Use --sequence for arbitrary ordering or multiple text/key events.

Text input interprets backslash escapes for \n, \r, \t, and \\ unless --raw is set.

Supported keys: enter, escape, esc, tab, backspace, delete, up, down, left, right, ctrl-a through ctrl-z.

Sequence input is an ordered JSON array of {"text":"..."} and {"key":"..."} objects.

JSON output:
  {
    "status": "sent",
    "surface_id": "...",
    "surface_ref": "surface:3",
    "input_count": 1
  }

Examples:
  dor send surface:3 --text "echo hello"
  dor send surface:3 --text "npm test" --key enter
  dor send surface:3 --key ctrl-c
  cat script.sh | dor send surface:3 --stdin
  dor send surface:3 --sequence '[{"text":"npm test"},{"key":"enter"}]'

FLAGS
     [--json]      Print JSON output.
     [--key]       Send a named key or chord.
     [--raw]       Do not interpret backslash escapes in text input.
     [--sequence]  Send an ordered JSON sequence of text and key events.
     [--stdin]     Read text from standard input and send it as text.
     [--text]      Send literal text.
  -h  --help       Print help information and exit
      --           All subsequent inputs should be interpreted as arguments

ARGUMENTS
  surface  Target surface.

```
