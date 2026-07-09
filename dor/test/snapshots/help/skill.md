# dor skill

Invocation: `dor skill --help`

```text
USAGE
  dor skill [--install] [--json]
  dor skill --help

Prints the Dormouse agent skill — instructions that teach a coding agent to drive Dormouse through the dor CLI: run background processes in visible panes, open browser surfaces, and launch and coordinate sub-agents. The text ships inside the CLI, so it always matches the Dormouse that staged it.

--install instead writes a marker-delimited bootstrap stub into the project's agent instructions file. The stub is the detection rule — if DORMOUSE_SURFACE_ID is set, run `dor skill` and follow it — plus two loud, mandatory directives (use `dor ensure` for long-running processes, `dor ab` for browsers) that must land before an agent would think to run `dor skill`. It stays otherwise fact-free, so a committed stub does not go stale.

If AGENTS.md or CLAUDE.md already contains the block, it is rewritten in place. Otherwise the stub goes to AGENTS.md when it exists, else to CLAUDE.md when it exists and does not already import AGENTS.md (via `@AGENTS.md`), else to a newly created AGENTS.md. Everything outside the markers is left untouched, so re-running is idempotent.

Text output:
  created AGENTS.md
  updated CLAUDE.md

JSON output:
  {
    "status": "created",
    "file": "AGENTS.md"
  }

FLAGS
     [--install]  Install the bootstrap stub into the project's agent instructions file.
     [--json]     Print JSON output.
  -h  --help      Print help information and exit
      --          All subsequent inputs should be interpreted as arguments

```
