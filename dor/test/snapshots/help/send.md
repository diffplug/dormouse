# dor send

Invocation: `dor send --help`

```text
USAGE
  dor send [--json] [--key value] [--raw] [--sequence json] [--stdin] [--surface id|ref|index] [--text value] [<text>]
  dor send --help

By default, a positional argument is sent as text. Special keys must be sent with --key so values like "enter" are never confused with literal text.

If --surface is omitted, Dormouse uses the caller surface from DORMOUSE_SURFACE_ID, then the focused surface.

Exactly one input source is required: TEXT, --text, --key, --stdin, or --sequence.

Text input interprets backslash escapes for \n, \r, \t, and \\ unless --raw is set. Prefer --key enter when submitting a prompt.

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
  dor send "echo hello"
  dor send --key enter
  dor send --surface surface:3 --key ctrl-c
  cat script.sh | dor send --surface surface:3 --stdin
  dor send --surface surface:3 --sequence '[{"text":"npm test"},{"key":"enter"}]'

FLAGS
     [--json]      Print JSON output.
     [--key]       Send a named key or chord.
     [--raw]       Do not interpret backslash escapes in text input.
     [--sequence]  Send an ordered JSON sequence of text and key events.
     [--stdin]     Read text from standard input and send it as text.
     [--surface]   Target surface.
     [--text]      Send literal text.
  -h  --help       Print help information and exit
      --           All subsequent inputs should be interpreted as arguments

ARGUMENTS
  [text]  Text to send.

```
