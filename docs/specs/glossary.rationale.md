# Glossary — Rationale

> Informative companion to [glossary.md](glossary.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Panes and Surfaces

**Why `dor` addresses content by Surface ref, not Pane ref.** A Pane ref names one content target only while a Pane holds exactly one Surface. That is true today but is not what the model reserves: a future in-pane surface strip puts several Surfaces in one Pane, at which point every `read` / `send` / `kill` spelled against a Pane becomes ambiguous. Leaving Pane refs unspent keeps them for the layout-only commands that will still mean one thing when the strip ships.

**Why every row carries both capability flags.** `kind` is an enum, so a caller that branches on `kind === 'terminal'` silently stops matching the day a kind carrying both capabilities ships — the staged `tool` (`docs/specs/dor-tool.md`) is that kind. `has_terminal` / `has_browser` express the same fact in a form that keeps matching, so a script written against today's two kinds still selects correctly against three. Emitting them unconditionally, rather than only where they differ from the kind, is what makes that guarantee free to rely on.

## Invariants

**Why a render-mode swap keeps the `surface:N` ref but not the id.** The swap is a replacement — `replaceSurface` puts a new Surface in the slot rather than mutating the old one — so the Lath leaf id, and with it the raw Surface id, cannot survive (`docs/specs/dor-browser.md` → Placement And Lifetime). Transferring the CLI ref across the replacement means a script that addressed the Surface before the swap still addresses it after; anything that captured the raw id does not, which is why the ref is the handle to hold.
