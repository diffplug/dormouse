# dor ensure

Invocation: `dor ensure --help`

```text
USAGE
  dor ensure [--json] [--minimize] [--restart] [--surface id|ref|index] [--cwd path] -- <command>...
  dor ensure --help

Ensures one surface in the current workspace is running the given command at the given path. If it's already running, no-op. If it isn't, then it creates a split and runs the command.

Matching uses the command each shell reports it is running via Dormouse shell integration (OSC 633), not process inspection. This captures the typed command (`npm run dev`), not the forked child process (`node .../vite`), and works for shells the user started by hand as well as shells Dormouse started. The match is exact: `npm run dev` and `npm run dev --host` are different commands and get separate surfaces.

ensure requires that integration: a surface can only be matched, reused, or restarted if its shell reports its command. So if the shell has no OSC 633 integration (e.g. cmd.exe), ensure fails with an error rather than starting an untrackable surface — run it from a shell with integration, such as Git Bash or PowerShell.

A surface matches only while the command is live. Once the command exits and the shell returns to its prompt, the surface no longer matches; the next ensure causes a fresh split rather than reusing the idle shell. Minimized surfaces participate in matching. Closed/killed surfaces do not.

Two surfaces running the same command in different working directories are distinct (e.g. the same dev server in two worktrees). Both keep running; ensure never collapses them.

--cwd sets the working directory used both for matching and for the new command. If omitted, Dormouse uses the directory dor was invoked from. The path is resolved to an absolute path and matched exactly; symlinks are not resolved, so two routes to the same directory are treated as distinct.

--minimize applies only when creating a new surface; it does not minimize an existing match.

--restart applies only to an already-running match: it interrupts the live command (Ctrl+C), waits for the shell to return to its prompt, then re-runs the command in place and blocks until the command is live again. A restarted surface keeps its minimized/visible state. If no surface is running the command, --restart behaves like a plain ensure and creates one.

--surface selects the surface to split only when creating a new surface. If omitted, Dormouse uses the same caller/focused fallback as dor split.

Text output:
  created surface:3  "npm run dev"
  existing surface:3  "npm run dev"
  restarted surface:3  "npm run dev"

JSON output:
  {
    "status": "created",
    "surface_id": "pane-def",
    "surface_ref": "surface:3",
    "command": "npm run dev",
    "cwd": "/Users/me/projects/site",
    "minimized": false
  }

FLAGS
     [--json]      Print JSON output.
     [--minimize]  Create the surface minimized.
     [--restart]   Restart a matching surface in place.
     [--surface]   Surface to split when creating.
     [--cwd]       Working directory for matching and for the new command.
  -h  --help       Print help information and exit
      --           All subsequent inputs should be interpreted as arguments

```
