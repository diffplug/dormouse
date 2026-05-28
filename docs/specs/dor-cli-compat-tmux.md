# Dor CLI tmux Compatibility

> See `docs/specs/dor-cli.md` for the current `dor` command contract. This
> file tracks tmux compatibility policy and command coverage.

Dormouse is not trying to become a tmux server. tmux compatibility is valuable
only where a tmux command name or output shape gives users and agents a familiar
way to control Dormouse panes and terminal text.

## Status Values

| Status | Meaning |
| --- | --- |
| `implemented-blessed` | Implemented and intended as a first-class `dor` command. |
| `implemented-compat-only` | Implemented only to match an external CLI spelling; prefer a blessed `dor` command in new usage. |
| `planned` | Should be implemented next or soon, with semantics that fit Dormouse's model. |
| `undecided` | Not implemented; needs design work or a product decision. |
| `will-not-implement` | Out of scope for `dor`, incompatible with Dormouse's model, or deliberately not accepted as cruft. |

## Command Coverage

Local `tmux` is not installed in this workspace, so this table is a conservative
coverage policy for the tmux command set rather than a version-pinned dump from
`tmux list-commands`. Before implementing a broad tmux-compatibility layer,
refresh this table against the exact tmux version being targeted.

| tmux command | Status | Notes |
| --- | --- | --- |
| `attach-session` | `will-not-implement` | tmux server/client session attachment. |
| `bind-key` | `will-not-implement` | Keybinding configuration is not `dor` scope. |
| `break-pane` | `undecided` | Could map to moving a pane, but tmux window semantics do not fit yet. |
| `capture-pane` | `planned` | High-value screen/scrollback read command. |
| `choose-buffer` | `will-not-implement` | Interactive tmux buffer UI. |
| `choose-client` | `will-not-implement` | tmux client UI. |
| `choose-session` | `will-not-implement` | tmux session UI. |
| `choose-tree` | `will-not-implement` | tmux chooser UI. |
| `choose-window` | `will-not-implement` | tmux window UI. |
| `clear-history` | `planned` | Maps to clearing terminal scrollback/history. |
| `clock-mode` | `will-not-implement` | tmux UI mode. |
| `command-prompt` | `will-not-implement` | tmux command UI. |
| `confirm-before` | `will-not-implement` | tmux command wrapper. |
| `copy-mode` | `will-not-implement` | Dormouse selection is UI-owned. |
| `customize-mode` | `will-not-implement` | tmux configuration UI. |
| `delete-buffer` | `will-not-implement` | tmux paste-buffer model. |
| `detach-client` | `will-not-implement` | tmux client/session model. |
| `display-menu` | `will-not-implement` | tmux UI menu. |
| `display-message` | `undecided` | Could map to transient Dormouse UI notices. |
| `display-panes` | `undecided` | Could map to pane labels/selection overlay. |
| `display-popup` | `will-not-implement` | tmux popup model. |
| `find-window` | `undecided` | Search/select semantics need design. |
| `has-session` | `will-not-implement` | tmux server/session existence check. |
| `if-shell` | `will-not-implement` | tmux scripting primitive. |
| `join-pane` | `undecided` | Layout operation could map, but target semantics need design. |
| `kill-pane` | `planned` | Maps to closing a Dormouse pane/surface. |
| `kill-server` | `will-not-implement` | Destructive tmux server command. |
| `kill-session` | `will-not-implement` | tmux session model. |
| `kill-window` | `will-not-implement` | tmux window model. |
| `last-pane` | `planned` | Useful pane navigation primitive. |
| `last-window` | `will-not-implement` | tmux window model. |
| `link-window` | `will-not-implement` | tmux window/session model. |
| `list-buffers` | `will-not-implement` | tmux paste-buffer model. |
| `list-clients` | `will-not-implement` | tmux client model. |
| `list-commands` | `undecided` | Could report supported `dor` commands later. |
| `list-keys` | `will-not-implement` | tmux keybinding configuration. |
| `list-panes` | `implemented-blessed` | Implemented using cmux-compatible `dor list-panes`. |
| `list-sessions` | `will-not-implement` | tmux session model. |
| `list-windows` | `will-not-implement` | tmux window model. |
| `load-buffer` | `will-not-implement` | tmux paste-buffer model. |
| `lock-client` | `will-not-implement` | tmux client model. |
| `lock-server` | `will-not-implement` | tmux server model. |
| `lock-session` | `will-not-implement` | tmux session model. |
| `move-window` | `will-not-implement` | tmux window model. |
| `new-session` | `will-not-implement` | tmux session model. |
| `new-window` | `will-not-implement` | tmux window model. |
| `next-layout` | `undecided` | Could map to layout cycling if added. |
| `next-window` | `will-not-implement` | tmux window model. |
| `paste-buffer` | `will-not-implement` | tmux paste-buffer model. |
| `pipe-pane` | `undecided` | Requires stream plumbing. |
| `previous-layout` | `undecided` | Could map to layout cycling if added. |
| `previous-window` | `will-not-implement` | tmux window model. |
| `refresh-client` | `will-not-implement` | tmux client model. |
| `rename-session` | `will-not-implement` | tmux session model. |
| `rename-window` | `will-not-implement` | tmux window model. |
| `resize-pane` | `planned` | Maps to layout sizing; needs Dockview sizing semantics. |
| `resize-window` | `will-not-implement` | tmux window model. |
| `respawn-pane` | `undecided` | Could map to restarting a terminal Session. |
| `respawn-window` | `will-not-implement` | tmux window model. |
| `rotate-window` | `will-not-implement` | tmux window/pane layout model does not directly map. |
| `run-shell` | `will-not-implement` | tmux scripting primitive. |
| `save-buffer` | `will-not-implement` | tmux paste-buffer model. |
| `select-layout` | `undecided` | Could map to layout presets if added. |
| `select-pane` | `planned` | Maps to focusing a Dormouse pane. |
| `select-window` | `will-not-implement` | tmux window model. |
| `send-keys` | `planned` | High-value terminal input automation. |
| `send-prefix` | `will-not-implement` | tmux prefix/keybinding model. |
| `server-access` | `will-not-implement` | tmux server access control. |
| `set-buffer` | `will-not-implement` | tmux paste-buffer model. |
| `set-environment` | `will-not-implement` | tmux server environment model. |
| `set-hook` | `will-not-implement` | tmux scripting/config primitive. |
| `set-option` | `will-not-implement` | tmux option model. |
| `set-window-option` | `will-not-implement` | tmux window option model. |
| `show-buffer` | `will-not-implement` | tmux paste-buffer model. |
| `show-environment` | `will-not-implement` | tmux server environment model. |
| `show-hooks` | `will-not-implement` | tmux scripting/config primitive. |
| `show-messages` | `will-not-implement` | tmux message log model. |
| `show-options` | `will-not-implement` | tmux option model. |
| `show-window-options` | `will-not-implement` | tmux window option model. |
| `source-file` | `will-not-implement` | tmux config file loading. |
| `split-window` | `planned` | tmux name for creating a new pane by splitting. |
| `swap-pane` | `undecided` | Layout operation exists conceptually; CLI semantics need design. |
| `swap-window` | `will-not-implement` | tmux window model. |
| `switch-client` | `will-not-implement` | tmux client/session model. |
| `unbind-key` | `will-not-implement` | Keybinding configuration is not `dor` scope. |
| `wait-for` | `undecided` | Synchronization primitive; useful only after event APIs exist. |
