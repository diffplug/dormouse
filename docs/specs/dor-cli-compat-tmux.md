# Dor CLI tmux Migration

> See `docs/specs/dor-cli.md` for the current `dor` command contract. This
> file is a migration guide for tmux habits and scripts, not a command coverage
> table.

Dormouse is not trying to become a tmux server. Port tmux scripts by translating
the user's intended interactive action into a Dormouse command, not by copying
tmux's server/session/window/pane model.

## Model Differences

- tmux has a server with clients, sessions, windows, panes, buffers, options,
  hooks, keybindings, and copy mode. Dormouse exposes terminal surfaces inside
  the current app workspace.
- A tmux pane usually maps to a Dormouse surface. A tmux window/session/client
  usually has no Dormouse CLI equivalent.
- Dormouse commands run from terminals that the app launched. They rely on
  injected `DORMOUSE_*` env and private control credentials, not a global tmux
  server socket.
- Dormouse's default scripting handle should be a surface ref such as
  `surface:1`, not a tmux pane id such as `%1`.
- For idempotent workflows, prefer `dor ensure --title <title> -- <cmd>` over
  hand-rolled "find pane, then maybe create pane" logic.

## Migration Rules

- Replace `tmux split-window` with `dor split`.
- Replace "make sure this command exists somewhere" scripts with `dor ensure`.
- Replace topology reads with `dor list-panes` or `dor list-pane-surfaces`.
- Do not migrate tmux server/session/window/client management directly. Use
  Dormouse app/workspace behavior instead.
- Do not migrate tmux configuration commands (`bind-key`, `set-option`,
  `set-hook`, `source-file`) into `dor`. Those belong in Dormouse settings or
  UI, not the terminal control CLI.
- Do not migrate tmux paste-buffer/copy-mode commands into `dor` unless
  Dormouse adds a terminal capture or clipboard feature with its own native
  semantics.

## Command Migration

| tmux intent | tmux spelling | Dormouse migration |
| --- | --- | --- |
| Split horizontally | `tmux split-window -h` | Use `dor split --right`. Use `--left` when the desired interactive action is a split on the left. |
| Split vertically | `tmux split-window -v` | Use `dor split --down`. Use `--up` when the desired interactive action is a split above. |
| Let the app choose split direction | common custom tmux logic based on size | Use `dor split --auto`. Dormouse resolves this to right when wide and down when narrow. |
| Start a command in a new pane | `tmux split-window -h "pnpm dev"` | Use `dor split --right --command "pnpm dev"`. |
| Ensure one long-running command exists | custom `tmux list-panes` plus `split-window` script | Use `dor ensure --title "dev server" -- pnpm dev`. The title is the idempotency key. |
| Rename a pane/window for a command | `tmux rename-window "dev server"` or title conventions | Use `dor ensure --title "dev server" -- <cmd>` when creating/ensuring command surfaces. Manual UI rename remains separate. |
| List panes | `tmux list-panes` | Use `dor list-panes`. For surface-level detail, use `dor list-pane-surfaces --pane focused` or pass a pane ref. |
| Select/focus a pane | `tmux select-pane -t %1` | No direct CLI migration today. Dormouse focus is currently an interactive app action; a future command should be surface-oriented. |
| Kill a pane | `tmux kill-pane -t %1` | No direct CLI migration today. A future Dormouse command should require an explicit confirmation mode because it can destroy terminal text. |
| Capture pane contents | `tmux capture-pane` | No direct CLI migration today. Add a Dormouse-native capture command only if it can specify visible screen vs scrollback and output encoding clearly. |
| Send input to a pane | `tmux send-keys` | No direct CLI migration today. Add a Dormouse-native send/input command only with clear quoting, paste, and control-key semantics. |
| Clear history | `tmux clear-history` | No direct CLI migration today. This should map to Dormouse terminal scrollback clearing if added. |
| Resize pane | `tmux resize-pane` | No direct CLI migration today. This needs Dormouse layout sizing semantics, not tmux cell arithmetic copied directly. |
| Session attach/detach | `tmux attach-session`, `detach-client`, `switch-client` | No CLI migration. Dormouse is already the host application; use app windows/workspaces instead. |
| New session/window | `tmux new-session`, `new-window` | Use `dor split` or `dor ensure` for terminal work. Standalone workspaces may later cover some window/session use cases; VS Code should remain single workspace. |
| Buffers and copy mode | `copy-mode`, `save-buffer`, `paste-buffer`, `list-buffers` | No CLI migration. Dormouse owns selection and clipboard behavior in the UI. |
| Options, hooks, config | `set-option`, `set-hook`, `bind-key`, `source-file` | No CLI migration. These belong in Dormouse configuration or extension/app integration. |

## Porting Examples

Create a terminal next to the current one:

```sh
# tmux
tmux split-window -h

# dor
dor split --right
```

Start or reuse a project dev server:

```sh
# tmux scripts often search pane titles or process text first.
# dor makes that identity explicit.
dor ensure --title "dev server" -- pnpm dev
```

List the focused surface with JSON output:

```sh
dor list-pane-surfaces --pane focused --json
```
