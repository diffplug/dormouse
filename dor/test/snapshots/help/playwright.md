# dor playwright

Invocation: `dor playwright --help`

```text
USAGE
  dor playwright [--key name] [--session name] [--surface handle] [--workspace ref] <args>...
  dor playwright --help

Forwards native playwright-cli commands to your installed @playwright/cli.
Install: npm i -g @playwright/cli
Override the executable with DORMOUSE_PLAYWRIGHT_BIN.

--key names one Playwright browser in this Dormouse workspace (default: default).
The first command fixes its working directory; later commands, including relative
file paths, run there. --session (or -s) selects a native session instead.
--surface drives an existing Playwright pane, including one opened from the GUI.
These three identities are mutually exclusive. Other flags belong to Playwright.

open and goto accept URLs, host:port, :port, or a terminal surface handle.
Launch once with open, then navigate with goto: Playwright's open restarts the
browser, dropping its tabs and cookies, while goto navigates the current tab.
Chromium sessions can be viewed and controlled in Dormouse.

Examples:
  dor pw --key app open :5173
  dor pw --key app goto http://localhost:5173/settings
  dor pw --key app snapshot
  dor pw --key app click e15
  dor playwright --key docs open surface:3
  dor pw --surface surface:4 goto :5173

FLAGS
     [--key]        Workspace browser key (default "default").
     [--session]    Raw Playwright session name (alias: -s).
     [--surface]    Existing Playwright surface handle.
     [--workspace]  Workspace to act in, instead of the caller's.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

ARGUMENTS
  args...  Native Playwright CLI arguments.

```
