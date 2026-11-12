# dor playwright

Invocation: `dor playwright --help`

```text
USAGE
  dor playwright [--key name|--session name|--surface handle] [--from handle] [--workspace ref] [--focus] [args...]
  dor playwright --help

Forwards native playwright-cli commands to your installed @playwright/cli.
Install: npm i -g @playwright/cli
Override the executable with DORMOUSE_PLAYWRIGHT_BIN.

--key names one playwright browser in this Dormouse workspace (default: default).
The first command fixes its working directory; later commands, including relative
file paths, run there. --session (or -s) selects a native session instead.
--surface drives an existing playwright pane, including one opened from the GUI.
These three identities are mutually exclusive. --from <handle> is a placement
reference: the Surface a new playwright pane splits from, whose Workspace a
--key resolves in. It places only a pane this command creates, and cannot be
combined with --surface. dor reads these, --workspace, and --focus (or
--focus=true|false) anywhere in the arguments, up to an optional bare --, which
it forwards unchanged; everything else, and everything after that --, belongs to playwright.

Dormouse intercepts dor-embed-size to query or set the pane's browser viewport:
  dor playwright dor-embed-size --json
  dor playwright dor-embed-size 1440 900
  dor playwright dor-embed-size --preset pane-sync

and dor-diagnostics to print, as JSON, what the pane and the host know about
its stream — for a pane that froze, or never showed its page:
  dor playwright --surface surface:3 dor-diagnostics

open and goto accept URLs, host:port, :port, or a terminal surface handle.
Launch once with open, then navigate with goto: playwright's open restarts the
browser, dropping its tabs and cookies, while goto navigates the current tab.
Chromium sessions can be viewed and controlled in Dormouse.

Typed alone at a prompt, the command focuses the Surface it opens or reuses; an agent's or a script's invocation leaves focus where it is. --focus or --focus=false decides either way. An already-visible browser keeps focus unchanged unless --focus is explicit; the default still reveals and focuses a minimized browser.

The exit status is playwright's own; 1 when dor refuses the command or fails
before running it; or 4 when playwright succeeded but dor could not open
or reuse its browser Surface. The command already ran and its output is printed,
so do not repeat it blindly: check the page first.

Examples:
  dor playwright --key app open :5173
  dor playwright --key app goto http://localhost:5173/settings
  dor playwright --key app snapshot
  dor playwright --key app click e15
  dor playwright --key docs open surface:3
  dor playwright --surface surface:4 goto :5173

FLAGS
     [--key]        Workspace browser key (default "default").
  -s [--session]    Raw playwright session name (native spelling: -s).
     [--surface]    Existing playwright surface handle.
     [--from]       Reference Surface for placement and managed-key Workspace.
     [--workspace]  Workspace id or exact workspace-name: reference.
     [--focus]      Focus the created or reused Surface (default: only when typed alone at a prompt).
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

ARGUMENTS
  args...  Native playwright CLI arguments.

```
