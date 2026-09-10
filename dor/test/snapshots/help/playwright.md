# dor playwright

Invocation: `dor playwright --help`

```text
USAGE
  dor playwright [--key name] [--session name] [--surface handle] <args>...
  dor playwright --help

Forwards native playwright-cli commands to your installed @playwright/cli.
Install: npm i -g @playwright/cli
Override the executable with DORMOUSE_PLAYWRIGHT_BIN.

--key names one Playwright browser in this Dormouse workspace (default: default).
The first launch fixes its working directory; later commands, including relative
file paths, run there. --session (or -s) selects a native session instead.
--surface drives an existing Playwright pane, including one opened from the GUI.
These three identities are mutually exclusive. Other flags belong to Playwright.

open and goto accept URLs, host:port, :port, or a terminal surface handle.
Playwright's open restarts the browser; goto navigates the current tab.
Chromium sessions can be viewed and controlled in Dormouse.

Examples:
  dor pw open http://localhost:5173
  dor playwright --key app open surface:3
  dor pw snapshot
  dor pw click e15
  dor pw --surface surface:4 goto :5173

FLAGS
     [--key]      Workspace browser key (default "default").
     [--session]  Raw Playwright session name (alias: -s).
     [--surface]  Existing Playwright surface handle.
  -h  --help      Print help information and exit
      --          All subsequent inputs should be interpreted as arguments

ARGUMENTS
  args...  Native Playwright CLI arguments.

```
