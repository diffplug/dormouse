# Dor CLI cmux Compatibility

> See `docs/specs/dor-cli.md` for the current `dor` command contract. This
> file tracks cmux compatibility policy and command coverage.

Dormouse tracks the public cmux CLI/API shape only where it maps cleanly:

- cmux has Pane + Surface; Dormouse currently has one terminal surface per Pane.
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

Source: `cmux --help` observed on 2026-05-28. Rows are top-level cmux CLI
commands or command families as printed by that help output.

| cmux command | Status | Notes |
| --- | --- | --- |
| `welcome` | `will-not-implement` | cmux onboarding. |
| `docs` | `will-not-implement` | cmux documentation lookup. |
| `settings` | `will-not-implement` | cmux settings UI/files. |
| `config` | `will-not-implement` | cmux/Ghostty config management. |
| `shortcuts` | `will-not-implement` | cmux shortcut documentation. |
| `disable-browser` / `enable-browser` / `browser-status` | `will-not-implement` | cmux browser feature toggle. |
| `restore-session` | `undecided` | Dormouse has session restore, but `dor` exposure is not designed. |
| `open <path-or-url>...` | `undecided` | Could map to opening a terminal/browser pane later. |
| `feedback` | `will-not-implement` | Product feedback flow, not terminal control. |
| `feed` | `will-not-implement` | cmux agent feed UI. |
| `themes` | `undecided` | Dormouse has themes; CLI control is not designed. |
| `claude-teams` | `will-not-implement` | cmux agent integration. |
| `codex-teams` | `will-not-implement` | cmux agent integration. |
| `omo` / `omx` / `omc` | `will-not-implement` | cmux agent wrappers. |
| `hooks` | `will-not-implement` | cmux agent hooks. |
| `ping` | `undecided` | Useful health check, but not needed for user-facing interactivity yet. |
| `version` | `undecided` | Useful diagnostic command. |
| `capabilities` | `undecided` | Useful once the public CLI surface grows. |
| `events` | `undecided` | Event stream semantics need design. |
| `auth` / `login` / `logout` | `will-not-implement` | cmux account auth. |
| `vm` / `cloud` | `will-not-implement` | cmux cloud VM feature. |
| `rpc` | `will-not-implement` | Dormouse socket remains private; `dor` is the public API. |
| `identify` | `planned` | Useful for debugging caller/window/workspace/surface context. |
| `list-windows` | `will-not-implement` | Dormouse currently exposes one window. |
| `current-window` | `will-not-implement` | Dormouse currently exposes one window. |
| `new-window` | `will-not-implement` | Dormouse does not create app windows via `dor`. |
| `focus-window` | `will-not-implement` | Dormouse currently exposes one window. |
| `close-window` | `will-not-implement` | Destructive app-window command is out of scope. |
| `move-workspace-to-window` | `will-not-implement` | Multi-window model is absent. |
| `reorder-workspace` | `will-not-implement` | Multi-workspace ordering is absent. |
| `workspace-action` | `undecided` | Workspace metadata exists conceptually, but CLI shape is not designed. |
| `move-tab-to-new-workspace` | `will-not-implement` | cmux tab/workspace model does not map now. |
| `list-workspaces` | `undecided` | Could report the singleton workspace, but has low value now. |
| `new-workspace` | `undecided` | Dormouse workspace creation is not designed. |
| `ssh` | `undecided` | Could become a terminal spawn helper; not a layout primitive. |
| `remote-daemon-status` | `will-not-implement` | cmux remote daemon feature. |
| `new-split` | `undecided` | Overlaps `new-pane`; source-relative spelling may be useful but is not blessed. |
| `list-panes` | `implemented-blessed` | Implemented cmux-compatible pane listing. |
| `list-pane-surfaces` | `implemented-blessed` | Implemented cmux-compatible pane-scoped surface listing. |
| `tree` | `undecided` | Useful diagnostic view; text/JSON shape needs design. |
| `top` | `undecided` | Requires process/resource model. |
| `memory` | `undecided` | Requires process/resource model. |
| `focus-pane` | `planned` | Clean pane-focused command; observed success output is `OK pane:<n> workspace:1`. |
| `new-pane` | `planned` | Best fit for Dormouse splitting; observed success output is `OK surface:<n> pane:<n> workspace:1`. |
| `new-surface` | `will-not-implement` | cmux tab/surface-within-pane model; Dormouse has one surface per Pane. |
| `close-surface` | `planned` | Maps to closing a Dormouse pane/surface. |
| `move-surface` | `undecided` | Needs a multi-surface or move-pane decision. |
| `split-off` | `will-not-implement` | Requires multiple surfaces per Pane. |
| `reorder-surface` | `will-not-implement` | Requires multiple surfaces per Pane. |
| `tab-action` | `will-not-implement` | cmux tab/browser metadata model. |
| `surface resume` | `undecided` | Could map to Dormouse session persistence later. |
| `rename-tab` | `undecided` | Could map to Dormouse pane rename, but name should not imply tabs. |
| `drag-surface-to-split` | `will-not-implement` | Mouse/drag action does not need a CLI command now. |
| `refresh-surfaces` | `will-not-implement` | cmux-specific surface refresh. |
| `reload-config` | `will-not-implement` | cmux/Ghostty config reload. |
| `surface-health` | `undecided` | Could become diagnostics. |
| `debug-terminals` | `undecided` | Could become diagnostics. |
| `trigger-flash` | `undecided` | UI/debug command, not core CLI. |
| `list-panels` | `will-not-implement` | Legacy cmux surface-list spelling; intentionally removed as cruft. |
| `focus-panel` | `will-not-implement` | Legacy cmux surface focus spelling; use/plan `focus-pane` instead. |
| `close-workspace` | `will-not-implement` | Singleton workspace and destructive scope. |
| `select-workspace` | `will-not-implement` | Singleton workspace. |
| `rename-workspace` | `undecided` | Workspace naming is not exposed through `dor`. |
| `rename-window` | `will-not-implement` | Singleton app window. |
| `current-workspace` | `undecided` | Could report singleton workspace for scripts. |
| `read-screen` | `planned` | High-value agent/user interactivity command. |
| `send` | `planned` | High-value command for terminal input automation. |
| `send-key` | `planned` | High-value command for terminal key input automation. |
| `send-panel` | `will-not-implement` | Legacy panel spelling; avoid duplicate command surface. |
| `send-key-panel` | `will-not-implement` | Legacy panel spelling; avoid duplicate command surface. |
| `notify` | `undecided` | Dormouse notifications exist, but public CLI shape needs design. |
| `list-notifications` | `undecided` | Alert/TODO integration needs design. |
| `dismiss-notification` | `undecided` | Alert/TODO integration needs design. |
| `mark-notification-read` | `undecided` | Alert/TODO integration needs design. |
| `open-notification` | `undecided` | Alert/TODO integration needs design. |
| `jump-to-unread` | `undecided` | Alert/TODO integration needs design. |
| `clear-notifications` | `undecided` | Alert/TODO integration needs design. |
| `right-sidebar` | `will-not-implement` | cmux UI feature. |
| `set-status` | `undecided` | Could become pane/activity metadata later. |
| `clear-status` | `undecided` | Paired with `set-status`. |
| `list-status` | `undecided` | Paired with `set-status`. |
| `set-progress` | `undecided` | Could map to notification/progress state later. |
| `clear-progress` | `undecided` | Paired with `set-progress`. |
| `log` | `undecided` | Could map to event/log UI later. |
| `clear-log` | `undecided` | Paired with `log`. |
| `list-log` | `undecided` | Paired with `log`. |
| `sidebar-state` | `will-not-implement` | cmux UI feature. |
| `set-app-focus` | `will-not-implement` | Test/simulation hook. |
| `simulate-app-active` | `will-not-implement` | Test/simulation hook. |
| `capture-pane` | `planned` | tmux-compatible alias/shape for `read-screen` may be valuable. |
| `resize-pane` | `planned` | Maps to layout sizing; needs Dockview sizing semantics. |
| `pipe-pane` | `undecided` | Requires stream plumbing. |
| `wait-for` | `undecided` | Synchronization primitive; useful only after event APIs exist. |
| `swap-pane` | `undecided` | Layout operation exists conceptually; CLI semantics need design. |
| `break-pane` | `undecided` | Multi-workspace/window semantics do not map cleanly. |
| `join-pane` | `undecided` | Layout operation could map, but target semantics need design. |
| `next-window` / `previous-window` / `last-window` | `will-not-implement` | Multi-window tmux navigation does not map. |
| `last-pane` | `planned` | Useful pane navigation primitive. |
| `find-window` | `undecided` | Search/select semantics need design. |
| `clear-history` | `planned` | Maps to terminal scrollback/history clearing. |
| `set-hook` | `will-not-implement` | tmux scripting/config primitive. |
| `popup` | `will-not-implement` | tmux popup model. |
| `bind-key` / `unbind-key` | `will-not-implement` | Keybinding configuration is not `dor` scope. |
| `copy-mode` | `will-not-implement` | Terminal selection model is UI-owned. |
| `set-buffer` | `will-not-implement` | tmux paste-buffer model. |
| `list-buffers` | `will-not-implement` | tmux paste-buffer model. |
| `paste-buffer` | `will-not-implement` | tmux paste-buffer model. |
| `respawn-pane` | `undecided` | Could map to restarting a terminal Session. |
| `display-message` | `undecided` | Could map to transient UI notices. |
| `markdown open` | `will-not-implement` | cmux markdown viewer. |
| `browser disable` / `browser enable` / `browser status` | `will-not-implement` | cmux browser feature. |
| `browser open` / `browser open-split` | `undecided` | Dormouse browser panes are not in current model. |
| `browser goto` / `browser navigate` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser back` / `browser forward` / `browser reload` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser url` / `browser get-url` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser snapshot` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser eval` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser wait` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser click` / `dblclick` / `hover` / `focus` / `check` / `uncheck` / `scroll-into-view` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser type` / `fill` / `press` / `keydown` / `keyup` / `select` / `scroll` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser screenshot` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser get` / `is` / `find` / `frame` / `dialog` / `download` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser profiles` / `import` / `cookies` / `storage` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser tab` / `console` / `errors` / `highlight` / `state` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser addinitscript` / `addscript` / `addstyle` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `browser identify` | `will-not-implement` | Browser automation is cmux-specific for now. |
| `help` | `implemented-blessed` | Global help is implemented via `dor --help` / `dor help`. |
