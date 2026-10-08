# dor tool

Invocation: `dor tool --help`

```text
USAGE
  dor tool [--global] [--json] [--minimize] [--fresh] [--surface id|ref] [--cwd path] [--workspace ref] <name> [args...]
  dor tool [--json] [--minimize] [--surface id|ref] [--cwd path] [--workspace ref] -- <command>...
  dor tool --list [--global] [--cwd path] [--json]
  dor tool --help

Runs a command in a new surface and watches the ports it opens. When the command starts serving, the surface grows a browser in place — same surface, same id, no second pane — and the pane flips to it with the terminal behind the header's far-left chip. When the command exits the browser retires and the pane flips back.

Two forms. `dor tool <name>` runs an entry from the nearest dormouse.yml, walking up from the working directory, falling back to user-global tools. --global skips project discovery. The user file is $XDG_CONFIG_HOME/dormouse/dormouse.yml, or ~/.config/dormouse/dormouse.yml. `dor tool -- <command>` designates any command as a tool without a registry entry. Named tools accept arguments: `dor tool <name> [args...]`, or `dor tool <name> -- <args...>` for arguments beginning with a dash. Use an argument-list `run` in the configuration to accept inputs.

A tool has an identity if and only if its dormouse.yml entry gave it one, via prespawn_dedupe. With a key, a second invocation whose key matches reveals the running surface instead of starting a duplicate. Without one — and for every `dor tool -- <command>` — each invocation creates a fresh surface. Nothing is keyed on the command or the working directory: run the same command twice and you get two tools.

--fresh ignores a declared key and always creates.

A project dormouse.yml is repo-controlled and its entries execute, so it is inert until you approve it in Dormouse itself. For an unapproved repo the surface is created and reports "pending": its pane shows what would run and waits for you to allow the upstream, allow just this folder, or close it. Nothing from the repo runs until you choose, and declining records nothing.

Approving an upstream covers any folder whose git config names that upstream, every worktree and clone of the repo included. Approving a folder covers that checkout only, which is what you want for a branch you have not read.

Where the tool lands: typed alone at a prompt in a visible, integrated plain terminal whose directory is the tool's, it takes over that pane — no split, same surface, same scrollback — and reports "takeover". Anything else — an agent's invocation, a compound line, a pane with a helper, --minimize, --surface, --cwd elsewhere — splits without taking focus and prints the new surface's handle. The pane remains a Tool after its command exits: another invocation from that prompt splits unless it matches a keyed Tool; the same keyed Tool reruns in place. The handle prints before the command starts, since dor has to exit before its own shell is free to run it.

--cwd sets the working directory used to find dormouse.yml and to run the command; it defaults to the directory dor was invoked from.

--list runs nothing: it prints the Tools `dor tool <name>` would find from the working directory — the nearest project dormouse.yml and whether you have approved it, then the user file. Each Tool shows its command, render, port strategy, and whether it has a key, then the comment block directly above its entry, which is where a Tool is documented. A user Tool that a project Tool of the same name hides is marked shadowed. --global lists only user Tools.

Text output:
  created surface:3  "pnpm storybook"
  existing surface:3  "pnpm storybook"
  takeover surface:1  "pnpm storybook"

  project  /Users/me/projects/site/dormouse.yml  [approved]
    storybook  "pnpm storybook"  [iframe]  [port auto]  [keyed]
        The component catalog, for a human to look at.
  user  /Users/me/.config/dormouse/dormouse.yml  [not found]

JSON output:
  {
    "status": "created",
    "surface_id": "surface-3",
    "surface_ref": "surface:3",
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
     [--global]     Resolve only user-global tools.
     [--json]       Print JSON output.
     [--minimize]   Create the surface minimized.
     [--fresh]      Ignore a declared key and always create.
     [--surface]    Surface to split when creating.
     [--workspace]  Workspace to act in, instead of the caller's.
     [--cwd]        Working directory for the tool file and the command.
     [--list]       List the declared Tools instead of running one.
  -h  --help        Print help information and exit
      --            All subsequent inputs should be interpreted as arguments

```
