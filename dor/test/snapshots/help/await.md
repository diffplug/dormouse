# dor await

Invocation: `dor await --help`

```text
USAGE
  dor await <surface> --until condition [--json] [--timeout seconds]
  dor await --help

Waits until a terminal surface finishes what it is doing, then reports why the wait ended. Lets an agent block on a peer it launched with `dor split` instead of polling `dor list` in a loop.

Prints no terminal text. Follow with `dor read` to see the screen.

--until says what counts as finished:
  quiet  The surface settled, the running command exited, or the surface rang the bell. Use for agents that keep running, such as claude or codex.
  exit   The running command exited, and nothing else. Use for builds and test runs, which can fall silent mid-run without being finished.

Waiting absorbs the alert. A surface that finishes while awaited does not ring the bell, speak an alarm, or notify a paired phone, and is not marked TODO — the wait already delivered the news.

Text mode prints the cause alone on stdout: quiet, exit, bell, or idle. An idle result means nothing was running and nothing started, so there was never anything to wait for.

A one-line summary naming the cause and how long the wait took goes to stderr, so it stays out of the captured value: `quiet: output stopped after 10m 15s`. The duration is how long this command blocked, not how long the surface had been working.

JSON output:
  {
    "workspace_ref": "workspace:1",
    "surface_id": "...",
    "surface_ref": "surface:3",
    "cause": "quiet",
    "waited_ms": 615000,
    "detail": "output stopped after 10m 15s"
  }

Exits 0 on any resolution, 2 on timeout, and 3 if the surface died before finishing.

Examples:
  dor await surface:3 --until quiet
  dor await surface:3 --until quiet && dor read surface:3
  dor await surface:3 --until exit --timeout 1800
  CAUSE=$(dor await surface:3 --until quiet)

FLAGS
     [--json]     Print JSON output.
     [--timeout]  Seconds to wait before giving up. Default 600.
      --until     What to wait for: quiet or exit.
  -h  --help      Print help information and exit
      --          All subsequent inputs should be interpreted as arguments

ARGUMENTS
  surface  Surface to wait on.

```
