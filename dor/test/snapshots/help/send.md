# dor send

Invocation: `dor send --help`

```text
USAGE
  dor send <surface> (--text value | --key name | --stdin)... [--json] [--workspace ref]
  dor send <surface> --sequence json [--json] [--workspace ref]
  dor send --help

Sends an ordered batch of text and key events to a terminal surface. Repeat --text and --key in any order. --stdin inserts standard input at its position and may occur once. --sequence is an alternative to these flags.

All text is literal: no backslash decoding, newline conversion, implicit Enter, or paste wrapping. Shell quoting and JSON parsing are the only decoding layers. --raw has been removed.

The complete batch is validated before anything is sent. Text arrives in short bursts; named keys wait for prior text to settle. Cursor keys use the terminal's active cursor-key mode. A batch stays together in the host queue. A lone ctrl-c interrupts pending input immediately; ctrl-c inside a larger batch stays ordered.

"sent" means the final write reached the live PTY, not that the program processed it. A failed or cancelled batch may have been partially delivered: do not retry automatically. Use dor await for program completion.

Supported keys: enter, escape, esc, tab, backspace, delete, up, down, left, right, ctrl-a through ctrl-z.

Sequence input is an ordered JSON array of {"text":"..."} and {"key":"..."} objects.

Option values are literal arguments, including empty strings, leading dashes, and line breaks. --text=value and --text value are equivalent.

JSON output:
  {
    "status": "sent",
    "surface_id": "...",
    "input_count": 1
  }

Examples:
  dor send surface:3 --text "echo hello"
  dor send surface:3 --text "npm test" --key enter
  dor send surface:3 --key ctrl-c
  cat script.sh | dor send surface:3 --stdin
  dor send surface:3 --sequence '[{"text":"npm test"},{"key":"enter"}]'

FLAGS
     [--json]       Print a JSON result or error object.
     [--key]...     Send a named key or chord.
     [--sequence]   Send an ordered JSON sequence of text and key events.
     [--stdin]      Read text from standard input and send it as text.
     [--text]...    Send literal text; repeat to add another event.
     [--workspace]  Workspace to act in, instead of the caller's.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

ARGUMENTS
  surface  Target surface.

```
