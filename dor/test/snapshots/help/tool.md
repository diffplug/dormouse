# dor tool

Invocation: `dor tool --help`

```text
USAGE
  dor tool [--json] [--minimize] [--fresh] [--surface id|ref] [--cwd path] <name>
  dor tool [--json] [--minimize] [--surface id|ref] [--cwd path] -- <command>...
  dor tool --help

Runs a command in a new surface and watches the ports it opens. When the command starts serving, the surface grows a browser in place — same surface, same id, no second pane — and the pane flips to it with the terminal behind the header's far-left chip. When the command exits the browser retires and the pane flips back.

Two forms. `dor tool <name>` runs an entry from the nearest dormouse.yml, walking up from the working directory. `dor tool -- <command>` designates any command as a tool without a registry entry. A named tool takes no extra arguments yet.

A tool has an identity if and only if its dormouse.yml entry gave it one, via prespawn_dedupe. With a key, a second invocation whose key matches reveals the running surface instead of starting a duplicate. Without one — and for every `dor tool -- <command>` — each invocation creates a fresh surface. Nothing is keyed on the command or the working directory: run the same command twice and you get two tools.

--fresh ignores a declared key and always creates.

A dormouse.yml is repo-controlled and its entries execute, so it is inert until you approve the repo in Dormouse itself. An unapproved repo fails with a message rather than prompting in the terminal; approve it in the app and run the command again. Declining is remembered too.

Where the tool lands: it always splits without taking focus and prints the new surface's handle, whether a human typed it or a script did. Taking over the calling pane when the invocation is typed alone at a prompt is designed but not built.

--cwd sets the working directory used to find dormouse.yml and to run the command; it defaults to the directory dor was invoked from.

Text output:
  created surface:3  "pnpm storybook"
  existing surface:3  "pnpm storybook"

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
     [--json]      Print JSON output.
     [--minimize]  Create the surface minimized.
     [--fresh]     Ignore a declared key and always create.
     [--surface]   Surface to split when creating.
     [--cwd]       Working directory for the tool file and the command.
  -h  --help       Print help information and exit
      --           All subsequent inputs should be interpreted as arguments

```
