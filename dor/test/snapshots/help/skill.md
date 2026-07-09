# dor skill

Invocation: `dor skill --help`

```text
USAGE
  dor skill [--install] [--json]
  dor skill --help

Prints the Dormouse agent skill — instructions that teach a coding agent to drive Dormouse through the dor CLI: run background processes in visible panes, open browser surfaces, and launch and coordinate sub-agents. The text ships inside the CLI, so it always matches the Dormouse that staged it.

--install instead writes a marker-delimited bootstrap stub into the project's agent instructions file. The stub's whole content is the detection rule — if DORMOUSE_SURFACE_ID is set, run `dor skill` and follow it — so a committed stub carries no CLI facts of its own and never goes stale.

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
