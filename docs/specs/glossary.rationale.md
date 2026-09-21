# Glossary — Rationale

> Informative companion to [glossary.md](glossary.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Panes and Surfaces

**Why `dor` addresses content by Surface ref, not Pane ref.** Once an in-pane surface strip puts several Surfaces in one Pane, every `read` / `send` / `await` / `kill` spelled against a Pane becomes ambiguous, while the layout-only commands still mean one thing — so Pane refs are left unspent for those.

**Why every row carries both capability flags.** `kind` is an enum, so a caller that branches on `kind === 'terminal'` silently stops matching the day a kind carrying both capabilities ships — `tool` (`docs/specs/dor-tool.md`) shipped as exactly that kind. `has_terminal` / `has_browser` express the same fact in a form that keeps matching, so a script written against today's two kinds still selects correctly against three; emitting them unconditionally, rather than only where they differ from the kind, is what makes that free to rely on.

## Invariants

**Why replacement keeps the `surface:N` ref but not the id.** `replaceSurface` replaces the Lath leaf, so its raw Surface id changes while the CLI ref continues addressing the replacement. Agent-browser headed/headless relaunches keep the same leaf and id; a minimized failed-connect rollback can also change render mode through a params update. Thus render mode alone cannot determine identity continuity.
