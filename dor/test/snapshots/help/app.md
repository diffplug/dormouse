# dor app

Invocation: `dor app --help`

```text
USAGE
  dor app restart [--json]
  dor app --help

Acts on the running Dormouse app. Available only in Dormouse Standalone.

restart quits Dormouse and reopens it. Every window and Workspace comes back with its layout and working directories, and Claude and Codex sessions resume where they left off. Every other process is stopped and all scrollback is cleared. It goes through the app's normal quit, so Dormouse asks first when commands are still running (this command's own terminal does not count). A development build refuses, since its dev server does not survive a relaunch.

Text output:
  restarting Dormouse; Claude and Codex sessions resume when it reopens

JSON output:
  {
    "status": "restarting"
  }

FLAGS
     [--json]  Print JSON output.
  -h  --help   Print help information and exit
      --       All subsequent inputs should be interpreted as arguments

ARGUMENTS
  args...  Action.

```
