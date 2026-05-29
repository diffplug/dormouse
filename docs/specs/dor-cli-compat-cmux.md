# Dor CLI cmux Migration

> See `docs/specs/dor-cli.md` for the current `dor` command contract. This
> file is a migration guide for cmux-shaped habits and scripts, not an
> implementation backlog.

Dormouse should not grow a cmux clone inside `dor`. Use this guide to translate
the small part of cmux that maps cleanly onto Dormouse's model.

## Model Differences

- Dormouse uses `surface` as the user-facing handle in new CLI design. `pane`
  remains compatibility/layout vocabulary for `list-panes` and
  `list-pane-surfaces`.
- Dormouse currently has one terminal surface per Pane. cmux can model multiple
  surfaces in one Pane.
- Dormouse currently exposes one workspace and one window. `workspace:1`,
  `window:1`, and bare `1` are compatibility no-ops; other workspace/window
  targets are rejected.
- cmux exposes both a CLI and socket API. Dormouse exposes `dor` as the public
  API; the control socket is private host plumbing.
- Dormouse omits cmux JSON geometry fields such as `container_frame`,
  `pixel_frame`, rows/columns, and cell dimensions until those fields exist in
  the Dormouse control response.
- Dormouse omits workspace/window UUID fields until the host exposes stable ids
  distinct from singleton refs.
- Dormouse exposes only real `dor` commands. Do not add aliases, command stubs,
  or "recognized but unimplemented" spellings just because cmux has them.

## Migration Rules

- Prefer native Dormouse commands for new scripts: `dor split`, `dor ensure`,
  and the surface-oriented commands that follow them.
- When a cmux script has a `pane:N` target but the Dormouse command wants a
  surface, resolve the pane's selected surface with
  `dor list-pane-surfaces --pane pane:N --json`.
- When porting mechanically, current Dormouse target resolution accepts surface
  refs, surface ids, pane refs, and 1-based indexes. New scripts should keep
  surface refs once they have them.
- Treat cmux workspaces/windows as singleton context until Dormouse standalone
  grows multiple workspaces. VS Code-hosted Dormouse should stay single
  workspace.
- Keep JSON consumers tolerant of missing cmux geometry and UUID fields.

## Command Migration

| cmux intent | cmux spelling | Dormouse migration |
| --- | --- | --- |
| Identify current caller context | `cmux identify --json` | Use `DORMOUSE_SURFACE_ID` for the invoking surface and `dor list-pane-surfaces --pane focused --json` for the focused surface. A future Dormouse-native identify command should report surface, pane, workspace, and window refs/ids in one call. |
| List windows | `cmux list-windows` | Treat the current window as `window:1`. Do not add a list command until Dormouse has multiple windows or a real need for compatibility output. |
| List workspaces | `cmux list-workspaces` | Treat the current workspace as `workspace:1`. Add a Dormouse-native workspace command only when standalone supports multiple workspaces. |
| List panes | `cmux list-panes` | Use `dor list-panes`. It intentionally keeps cmux-compatible text shape for pane topology. |
| List surfaces in a pane | `cmux list-pane-surfaces --pane pane:1` | Use `dor list-pane-surfaces --pane pane:1`. With today's one-surface panes, this returns zero or one surface. |
| Create workspace | `cmux new-workspace` | No direct migration today. In standalone, this should become a Dormouse workspace command when multiple workspaces land. In VS Code, keep a single workspace. |
| Create split | `cmux new-split right --panel pane:1` | Use `dor split --right --surface <surface-ref>`. If the script only has `pane:1`, resolve it through `dor list-pane-surfaces --pane pane:1 --json` first. |
| Move surface into another pane | `cmux move-surface --surface surface:7 --pane pane:2 --focus true` | No direct migration today. Dormouse currently treats surface order and pane placement as the same thing. Add a native move/focus command only after the desired interactive action is clear. |
| Split a surface out of a pane | `cmux split-off --surface surface:7 right` | Usually translates to no operation because a Dormouse surface is already the split-level unit. If the intent is "create new space next to this surface", use `dor split --right --surface surface:7`. |
| Reorder surfaces | `cmux reorder-surface --surface surface:7 --before surface:3` | No direct migration today. This needs a Dormouse-native reorder/move design, not a cmux spelling. |
| Trigger attention cue | `cmux trigger-flash --surface surface:7` | No direct migration today. A future Dormouse command should be surface-oriented and map to the app's alert/attention model. |

## Porting Examples

Create a split next to the current cmux pane:

```sh
# cmux
cmux new-split right --panel pane:1

# dor
dor split --right --surface surface:1
```

Make a dev server idempotent rather than scripting pane existence:

```sh
# cmux-style scripts often inspect topology, then create conditionally.
# dor makes the idempotency key explicit with a user-enforced surface title.
dor ensure --title "dev server" -- pnpm dev
```
