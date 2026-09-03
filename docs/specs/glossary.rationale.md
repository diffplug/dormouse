# Glossary — Rationale

> Informative companion to [glossary.md](glossary.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Panes and Surfaces

**Why `dor` addresses content by Surface ref, not Pane ref.** Once an in-pane surface strip puts several Surfaces in one Pane, every `read` / `send` / `kill` spelled against a Pane becomes ambiguous, while the layout-only commands still mean one thing — so Pane refs are left unspent for those.

**Why every row carries both capability flags.** `kind` is an enum, so a caller that branches on `kind === 'terminal'` silently stops matching the day a kind carrying both capabilities ships — the staged `tool` (`docs/specs/dor-tool.md`) is that kind. `has_terminal` / `has_browser` express the same fact in a form that keeps matching, so a script written against today's two kinds still selects correctly against three; emitting them unconditionally, rather than only where they differ from the kind, is what makes that free to rely on.

## Invariants

**Why a render-mode swap keeps the `surface:N` ref but not the id.** The swap is a replacement — `replaceSurface` puts a new Surface in the slot rather than mutating the old one — so the Lath leaf id, and with it the raw Surface id, cannot survive (`docs/specs/dor-browser.md` → Placement And Lifetime). Carrying the CLI ref across the replacement means a script that addressed the Surface before the swap still addresses it after; one that captured the raw id does not.
