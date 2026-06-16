# dor agent-browser

Invocation: `dor agent-browser --help`

```text
USAGE
  dor agent-browser [--key name|--session name] [args...]
  dor agent-browser --help

Forwards all arguments verbatim to your own agent-browser binary and binds the session to a Dormouse browser surface.

dor intercepts exactly two flags:
  --key <name>      Managed, workspace-scoped browser identity (default "default").
                    Maps to agent-browser session dormouse.1.<name>.
  --session <name>  Attach to a raw agent-browser session by its literal name.
                    Mutually exclusive with --key.

Everything else — subcommands, flags, selectors — is agent-browser's own
command surface. The binary is resolved from PATH (override with
DORMOUSE_AGENT_BROWSER_BIN) and is never bundled; install it with:
  npm i -g agent-browser

After a successful command, dor opens (or reuses) the browser surface bound to
the session: one session is always exactly one surface.

Examples:
  dor ab open http://localhost:5173        # key "default"
  dor ab --key storybook open http://localhost:6006
  dor ab click @e3                          # drives key "default"
  dor ab --key storybook reload             # drives key "storybook"

FLAGS
     [--key]      Workspace-scoped browser key (default "default").
     [--session]  Raw agent-browser session name (mutually exclusive with --key).
  -h  --help      Print help information and exit
      --          All subsequent inputs should be interpreted as arguments

ARGUMENTS
  args...  Arguments forwarded verbatim to agent-browser.

```
