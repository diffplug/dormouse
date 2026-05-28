# Dor CLI cmux Compatibility

> See `docs/specs/dor-cli.md` for the current `dor` command contract. This
> file tracks cmux compatibility policy and command coverage.

Dormouse tracks the public cmux CLI/API shape only where it maps cleanly:

- cmux has Pane + Surface; Dormouse currently has one terminal surface per Pane.
- cmux has no analogue for Dormouse's "minimized" panes.
- cmux supports multiple workspaces/windows; Dormouse accepts only the singleton
  compatibility targets.
- cmux exposes both a CLI and socket API; Dormouse exposes only the CLI.
- In the cmux version used to derive this contract on 2026-05-28, the relevant
  working CLI commands are `list-panes` and `list-pane-surfaces`. The socket
  capability used underneath is named `surface.list`.
- Dormouse exposes only commands implemented in `dor`; it does not expose
  aliases or recognized-but-unimplemented command stubs.
- Dormouse omits cmux JSON geometry fields such as `container_frame`,
  `pixel_frame`, rows/columns, and cell dimensions until those fields are part
  of the Dormouse control response.
- Dormouse also omits workspace/window UUID fields until the host exposes stable
  workspace/window ids distinct from the singleton refs.

## Status Values

| Status | Meaning |
| --- | --- |
| `implemented-blessed` | Implemented and intended as a first-class `dor` command. |
| `implemented-compat-only` | Implemented only to match an external CLI spelling; prefer a blessed `dor` command in new usage. |
| `planned` | Should be implemented next or soon, with semantics that fit Dormouse's model. |
| `undecided` | Not implemented; needs design work or a product decision. |
| `will-not-implement` | Out of scope for `dor`, incompatible with Dormouse's model, or deliberately not accepted as cruft. |

## Command Coverage

Source: core cmux compatibility target set chosen for `dor` on 2026-05-28. This
is intentionally not a full `cmux --help` inventory; commands outside this table
are out of the current cmux compatibility scope.

| cmux command | Status | Notes |
| --- | --- | --- |
| `identify --json` | `planned` | Report caller context: current window, workspace, pane, and surface refs/ids. |
| `list-windows` | `planned` | Report the singleton Dormouse window until a multi-window model exists. |
| `list-workspaces` | `planned` | Report the singleton Dormouse workspace until a multi-workspace model exists. |
| `list-panes` | `implemented-blessed` | Implemented cmux-compatible pane listing. |
| `list-pane-surfaces --pane pane:1` | `implemented-blessed` | Implemented cmux-compatible pane-scoped surface listing. |
| `new-workspace` | `planned` | Create a new Dormouse workspace once workspace creation is exposed. |
| `new-split right --panel pane:1` | `planned` | cmux-compatible split creation. `--panel` is accepted only for cmux compatibility. |
| `move-surface --surface surface:7 --pane pane:2 --focus true` | `undecided` | Needs a clear mapping between cmux multi-surface panes and Dormouse's one-surface panes. |
| `split-off --surface surface:7 right` | `undecided` | Needs a clear mapping because Dormouse does not currently have multiple surfaces inside one Pane. |
| `reorder-surface --surface surface:7 --before surface:3` | `undecided` | Needs a clear mapping because surface order and pane order are currently the same thing in Dormouse. |
| `trigger-flash --surface surface:7` | `planned` | Attention cue for a specific surface/pane. |
