# dor tool

Invocation: `dor tool --help`

```text
USAGE
  dor tool [--global] [--json] [--minimize] [--fresh] [--surface id|ref] [--cwd path] [--workspace ref] <name> [args...]
  dor tool [--json] [--minimize] [--surface id|ref] [--cwd path] [--workspace ref] -- <command>...
  dor tool --help

Runs a command in a new surface and watches the ports it opens. When the command starts serving, the surface grows a browser in place — same surface, same id, no second pane — and the pane flips to it with the terminal behind the header's far-left chip. When the command exits the browser retires and the pane flips back.

Two forms. `dor tool <name>` runs an entry from the nearest dormouse.yml, walking up from the working directory, falling back to user-global tools. --global skips project discovery. The user file is $XDG_CONFIG_HOME/dormouse/dormouse.yml, or ~/.config/dormouse/dormouse.yml. `dor tool -- <command>` designates any command as a tool without a registry entry. Named tools accept arguments: `dor tool <name> [args...]`, or `dor tool <name> -- <args...>` for arguments beginning with a dash. Use an argument-list `run` in the configuration to accept inputs.

A tool has an identity if and only if its dormouse.yml entry gave it one, via prespawn_dedupe. With a key, a second invocation whose key matches reveals the running surface instead of starting a duplicate. Without one — and for every `dor tool -- <command>` — each invocation creates a fresh surface. Nothing is keyed on the command or the working directory: run the same command twice and you get two tools.

--fresh ignores a declared key and always creates.

A project dormouse.yml is repo-controlled and its entries execute, so it is inert until you approve it in Dormouse itself. For an unapproved repo the surface is created and reports "pending": its pane shows what would run and waits for you to allow the upstream, allow just this folder, or close it. Nothing from the repo runs until you choose, and declining records nothing.

Approving an upstream covers every worktree and clone of that repo. Approving a folder covers that checkout only, which is what you want for a branch you have not read.

Where the tool lands: typed alone at a prompt, it takes over the pane you typed it in — no split, same surface, same scrollback — and reports "takeover". Anything else splits without taking focus and prints the new surface's handle. The take-over needs an integrated shell running `dor tool` as the whole command line, a visible plain terminal pane without an auxiliary helper, and the tool's directory to be that pane's own, so an agent's invocation, a compound line, --minimize, --surface, and --cwd elsewhere all split instead. The handle prints before the command starts, since dor has to exit before its own shell is free to run it.

--cwd sets the working directory used to find dormouse.yml and to run the command; it defaults to the directory dor was invoked from.

Text output:
  created surface:3  "pnpm storybook"
  existing surface:3  "pnpm storybook"
  takeover surface:1  "pnpm storybook"

JSON output:
  {
    "status": "created",
    "surface_id": "pane-def",
    "surface_ref": "surface:3",
    "command": "pnpm storybook",
    "cwd": "/Users/me/projects/site",
    "minimized": false,
    "key": ["storybook", "/Users/me/projects/site"]
  }

FLAGS
     [--global]     Resolve only user-global tools.
     [--json]       Print JSON output.
     [--minimize]   Create the surface minimized.
     [--fresh]      Ignore a declared key and always create.
     [--surface]    Surface to split when creating.
     [--workspace]  Workspace to act in, instead of the caller's.
     [--cwd]        Working directory for the tool file and the command.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

```
