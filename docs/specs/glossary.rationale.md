# Glossary — Rationale

> Informative companion to [glossary.md](glossary.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Panes and Surfaces

**Why `dor` addresses content by Surface ref, not Pane ref.** Once an in-pane surface strip puts several Surfaces in one Pane, every `read` / `send` / `await` / `kill` spelled against a Pane becomes ambiguous, while the layout-only commands still mean one thing — so Pane refs are left unspent for those.

**Why every row carries both capability flags.** `kind` is an enum, so a caller that branches on `kind === 'terminal'` silently stops matching the day a kind carrying both capabilities ships — `tool` (`docs/specs/dor-tool.md`) shipped as exactly that kind. `has_terminal` / `has_browser` express the same fact in a form that keeps matching, so a script written against today's two kinds still selects correctly against three; emitting them unconditionally, rather than only where they differ from the kind, is what makes that free to rely on.

## Invariants

**Why a render swap keeps the id but shell replacement does not.** A render swap changes only the renderer of a Surface that owns no PTY, so its slot, TODO, and `dor` ref stay with it; minting a new id dropped the TODO and stranded any script holding the ref. A replaced shell's PTY is killed under its id, and that id stays marked: late output and exit can still arrive, VS Code's host drops them by `killedPtyIds`, and the alert manager keeps a `removed` tombstone until a live Session reports under the id. A browser reusing the id would inherit or be confused with those events. A browser also launches under its own id before placement decides whether it replaces the shell (`preparedId`).
