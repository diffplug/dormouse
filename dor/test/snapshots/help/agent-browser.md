# dor agent-browser

Invocation: `dor agent-browser --help`

```text
USAGE
  dor agent-browser [--key name|--session name|--surface handle] [--from handle] [--workspace ref] [--focus] [args...]
  dor agent-browser --help

Forwards all arguments verbatim to your own agent-browser binary and binds the session to a Dormouse browser surface.

dor intercepts exactly three mutually exclusive identity flags:
  --key <name>       Managed, workspace-scoped browser identity (default "default").
                     Maps to agent-browser session dormouse.<workspace>.<name>,
                     so the same key in another Workspace is another browser.
  --session <name>   Attach to a raw agent-browser session by its literal name.
  --surface <handle> Drive the browser Surface a handle names (surface:N,
                     surface:self, surface:focused, title:<title>). dor asks the
                     host which agent-browser session that Surface is bound to,
                     which is the only way to address a GUI-spawned session.

It also intercepts --workspace <ref>, which is not an identity: it says which
Workspace of this Window the browser Surface is opened in and which one a
handle resolves against (workspace:<id> or workspace-name:<name>); and --focus
(or --focus=true|false), which says whether that Surface takes focus.

--from <handle> is a placement reference: the Surface a new browser pane
splits from, whose Workspace a --key resolves in. It places only a browser
this command creates; a reused one stays where it is. It cannot be combined
with --surface, which names the existing browser to drive.

dor reads these flags anywhere in the arguments, up to an optional bare --,
which it forwards unchanged. Everything else, and everything after that --, is
agent-browser's own command surface: subcommands, flags, selectors. The binary
is resolved from PATH (override with DORMOUSE_AGENT_BROWSER_BIN) and is never
bundled; install it with:
  npm i -g agent-browser

Dormouse intercepts dor-embed-size to query or set the pane's browser viewport:
  dor agent-browser dor-embed-size --json
  dor agent-browser dor-embed-size 1440 900 --dpr 2
  dor agent-browser dor-embed-size --preset pane-sync

and dor-diagnostics to print, as JSON, what the pane and the host know about
its stream — for a pane that froze, or never showed its page:
  dor agent-browser --surface surface:3 dor-diagnostics

After a successful command, dor opens the browser surface bound to the session,
or reuses the one it already has. A playwright browser (render_mode playwright-*) is
driven with dor playwright --surface instead.

Typed alone at a prompt, the command focuses the Surface it opens or reuses; an agent's or a script's invocation leaves focus where it is. --focus or --focus=false decides either way. An already-visible browser keeps focus unchanged unless --focus is explicit; the default still reveals and focuses a minimized browser.

The exit status is agent-browser's own; 1 when dor refuses the command or fails
before running it; or 4 when agent-browser succeeded but dor could not open
or reuse its browser Surface. The command already ran and its output is printed,
so do not repeat it blindly: check the page first.

In an "open" command, dor also resolves a Dormouse target in place of a URL:
a schemeless host:port (and the ":<port>" localhost shorthand) defaults to
http:// rather than agent-browser's https://, and a terminal Surface handle
(surface:N, surface:self, or surface:focused) resolves to the
dev-server URL that terminal owns via the host port scan.

Examples:
  dor agent-browser open http://localhost:5173        # key "default"
  dor agent-browser open localhost:5173                # → http://localhost:5173/
  dor agent-browser open :5173                         # → http://localhost:5173/
  dor agent-browser open surface:3                     # open the port terminal surface:3 owns
  dor agent-browser --key storybook open http://localhost:6006
  dor agent-browser click @e3                          # drives key "default"
  dor agent-browser --key storybook reload             # drives key "storybook"
  dor agent-browser --surface surface:4 click @e3      # drives whatever surface:4 is bound to

FLAGS
     [--key]        Workspace-scoped browser key (default "default").
     [--session]    Raw agent-browser session name (mutually exclusive with --key/--surface).
     [--surface]    Surface handle whose bound session to drive (mutually exclusive with --key/--session).
     [--from]       Reference Surface for placement and managed-key Workspace.
     [--workspace]  Workspace id or exact workspace-name: reference.
     [--focus]      Focus the created or reused Surface (default: only when typed alone at a prompt).
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

ARGUMENTS
  args...  Arguments forwarded verbatim to agent-browser.

```
