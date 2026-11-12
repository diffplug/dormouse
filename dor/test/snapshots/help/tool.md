# dor tool

Invocation: `dor tool --help`

```text
USAGE
  dor tool [--global] [--focus] [--json] [--minimize] [--fresh] [--surface handle] [--cwd path] [--workspace ref] <name> [args...]
  dor tool [--focus] [--json] [--minimize] [--surface handle] [--cwd path] [--workspace ref] -- <command>...
  dor tool [--global] [--focus] [--json] [--minimize] [--fresh] [--surface handle] [--cwd path] [--workspace ref]
  dor tool --list [--global] [--cwd path] [--json]
  dor tool --help

Runs a command in a new surface and watches the ports it opens. When the command starts serving, the surface grows a browser in place — same surface, same id, no second pane — and the pane flips to it with the terminal behind the header's far-left chip. When the command exits the browser retires and the pane flips back.

Two forms. `dor tool <name>` runs an entry from the nearest dormouse.yml, walking up from the working directory, falling back to user-global tools. --global skips project discovery. The user file is $XDG_CONFIG_HOME/dormouse/dormouse.yml, or ~/.config/dormouse/dormouse.yml. `dor tool -- <command>` designates any command as a tool without a registry entry. Named tools accept arguments: `dor tool <name> [args...]`, or `dor tool <name> -- <args...>` for arguments beginning with a dash. Use an argument-list `run` in the configuration to accept inputs.

A tool has an identity if and only if its dormouse.yml entry gave it one, via prespawn_dedupe. With a key, a second invocation whose key matches reveals the running surface instead of starting a duplicate. Without one — and for every `dor tool -- <command>` — each invocation creates a fresh surface. Nothing is keyed on the command or the working directory: run the same command twice and you get two tools.

--fresh ignores a declared key and always creates.

A project dormouse.yml is repo-controlled and its entries execute, so it is inert until you approve it in Dormouse itself. For an unapproved repo the surface is created and reports "pending": its pane shows what would run and waits for you to allow the upstream, allow just this folder, or close it. Nothing from the repo runs until you choose, and declining records nothing.

Approving an upstream covers any folder whose git config names that upstream, every worktree and clone of the repo included. Approving a folder covers that checkout only, which is what you want for a branch you have not read.

Where the tool lands: typed alone at a prompt in a visible, integrated plain terminal whose directory is the tool's, it takes over that pane — no split, same surface, same scrollback — and reports "takeover". Anything else — an agent's invocation, a compound line, a pane with a helper, --minimize, --surface, --cwd elsewhere — splits and prints the new surface's handle. Once the command exits the pane is a plain terminal again; a later invocation from its prompt takes it over afresh. The handle prints before the command starts, since dor has to exit before its own shell is free to run it.

Typed alone at a prompt, the command focuses the Surface it opens or reuses; an agent's or a script's invocation leaves focus where it is. --focus or --focus=false decides either way. --minimize turns the default off, and --focus with --minimize is an error.

--cwd sets the working directory used to find dormouse.yml and to run the command; it defaults to the directory dor was invoked from.

--list runs nothing: it prints the Tools `dor tool <name>` would find from the working directory — the nearest project dormouse.yml and whether you have approved it, then the user file. Each Tool shows its command, render, port strategy, and whether it has a key, then the comment block directly above its entry, which is where a Tool is documented. A user Tool that a project Tool of the same name hides is marked shadowed. A user Tool imported from another dormouse.yml shows that file, and one that does not resolve is marked broken with the reason. --global lists only user Tools.

Without a name or --, in an interactive terminal, a fuzzy finder lists the Tools --list would. Type to filter, ↑/↓ or the mouse to select, Enter or a double-click to run. Beside the list — or on one status line when the terminal is narrower than 100 columns — it shows the highlighted Tool's tags, file, and description. A shadowed user Tool runs as --global would run it. Esc or Ctrl+C cancels, exiting 1 silently. The other flags apply to the chosen Tool. With no Tool declared, it prints the listing instead. Without a terminal, or with --json, it prints what --list prints, unless --focus, --minimize, --fresh, --surface, or --workspace asks for a launch.

command_state, the [tag] in text output, says what the reply proves about the command; status says how the Surface was found or made. Neither promises a successful exit or a ready service: check readiness separately. It is one of:
  unconfirmed        a new Surface; its command is not yet seen starting
  running            the shell reported the command running
  awaiting_approval  the pane waits for you to approve the project dormouse.yml; nothing has run
  queued             not started yet: a takeover, answered before its command is typed so dor can exit and free the shell, or a reused Tool whose re-run has not started
  ended              the new Surface's command already ended, perhaps with a nonzero exit

Text output:
  created surface:3  [unconfirmed]  "pnpm storybook"
  existing surface:3  [running]  "pnpm storybook"
  takeover surface:1  [queued]  "pnpm storybook"
  pending surface:3  [awaiting_approval]  "pnpm storybook"

  project  /Users/me/projects/site/dormouse.yml  [approved]
    storybook  "pnpm storybook"  [iframe]  [port auto]  [keyed]
        The component catalog, for a human to look at.
  user  /Users/me/.config/dormouse/dormouse.yml  [not found]

JSON output:
  {
    "status": "created",
    "command_state": "unconfirmed",
    "surface_id": "surface:3",
    "command": "pnpm storybook",
    "cwd": "/Users/me/projects/site",
    "minimized": false,
    "key": ["storybook", "/Users/me/projects/site"]
  }

  {
    "project": { "path": "/Users/me/projects/site/dormouse.yml", "approved": true },
    "user": { "path": "/Users/me/.config/dormouse/dormouse.yml", "found": false },
    "tools": [
      {
        "name": "storybook",
        "scope": "project",
        "run": "pnpm storybook",
        "render": "iframe",
        "port": "auto",
        "keyed": true,
        "description": "The component catalog, for a human to look at.",
        "shadowed": false
      }
    ]
  }

FLAGS
     [--focus]      Focus the created or reused Surface (default: only when typed alone at a prompt).
     [--global]     Resolve only user-global tools.
     [--json]       Print a JSON result or error object.
     [--minimize]   Create the surface minimized.
     [--fresh]      Ignore a declared key and always create.
     [--surface]    Surface to split when creating.
     [--workspace]  Workspace to act in, instead of the caller's.
     [--cwd]        Working directory for the tool file and the command.
     [--list]       List the declared Tools instead of running one.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

```
