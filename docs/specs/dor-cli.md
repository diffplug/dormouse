# Dor CLI

> See `docs/specs/glossary.md` for canonical Session and Pane vocabulary. This
> spec uses `surface` for the CLI handle model because `dor` intentionally
> mirrors cmux terminology at the command boundary.

Dormouse bundles a `dor` CLI into every terminal it launches. The CLI is the
public API; any socket used underneath it is private host plumbing.

Source of truth:

| Scope | Source |
| --- | --- |
| CLI parser, command help, output rendering, current command support | `dor/src/cli.ts` |
| Socket client and request envelope | `dor/src/control-client.ts` |
| POSIX / Windows launchers | `dor/bin/dor`, `dor/bin/dor.cmd` |
| Snapshot tests for CLI output | `dor/test/cli-output.test.mjs`, `dor/test/snapshots/` |
| Shared staging script | `scripts/stage-dor-cli.mjs` |
| Standalone staging/runtime env | `standalone/package.json`, `standalone/src-tauri/src/lib.rs`, `standalone/sidecar/pty-core.js`, `standalone/sidecar/main.js` |
| VS Code staging/runtime env | `vscode-ext/package.json`, `vscode-ext/src/pty-manager.ts`, `vscode-ext/src/pty-host.js` |
| Control request routing into the webview | `standalone/src/tauri-adapter.ts`, `vscode-ext/src/message-router.ts`, `lib/src/lib/platform/vscode-adapter.ts` |
| Implemented webview control handler | `lib/src/components/Wall.tsx` |

## Bundling And PATH

`dor` must work without `npm i -g`. Both hosts stage the workspace `dor` package
before build/dev and prepend the staged `bin` directory to every spawned PTY's
`PATH`.

Staged package contents:

- `bin/dor` and `bin/dor.cmd` are tiny launchers.
- `dist/dor.js` is the compiled TypeScript entrypoint.
- `package.json` declares `"type": "module"` so Node runs the staged ESM file
  without depending on parent package metadata.

The launchers prefer the host-provided runtime:

```sh
exec "$DORMOUSE_NODE" "$DORMOUSE_CLI_JS" "$@"
```

```bat
"%DORMOUSE_NODE%" "%DORMOUSE_CLI_JS%" %*
```

They may fall back to `node` for developer/manual use, but Dormouse-launched
terminals must rely on injected env rather than a globally installed Node.

Public PTY env:

- `DORMOUSE_NODE` — Node runtime used by the launcher.
- `DORMOUSE_CLI_JS` — absolute path to staged `dist/dor.js`.
- `DORMOUSE_SURFACE_ID` — stable invoking Session/surface id.
- `DORMOUSE_CONTROL_SOCKET` and `DORMOUSE_CONTROL_TOKEN` — private control
  endpoint credentials.

`DORMOUSE_CLI_BIN` is host-internal spawn configuration. Terminals should rely
on `PATH`, not on that variable.

## Host Plumbing

### Standalone

`standalone/package.json` runs `pnpm stage:dor-cli` before Tauri dev/build.
Rust resolves the staged/bundled CLI paths, starts the Node sidecar with
`DORMOUSE_NODE`, `DORMOUSE_CLI_BIN`, `DORMOUSE_CLI_JS`,
`DORMOUSE_CONTROL_SOCKET`, and `DORMOUSE_CONTROL_TOKEN`, then the shared PTY
core prepends `DORMOUSE_CLI_BIN` and sets `DORMOUSE_SURFACE_ID` per PTY.

Control direction:

```text
dor process
  -> standalone sidecar JSON-lines net socket
  -> Rust command/event bridge
  -> TauriAdapter CustomEvent("dormouse:control-request")
  -> Wall handler
  -> Rust
  -> sidecar
  -> dor process
```

### VS Code

`vscode-ext/package.json` runs `pnpm stage:dor-cli` before bundling the
extension host and `pty-host.js`. The extension host computes the staged CLI
paths under `context.extensionPath/dor-cli`, starts `pty-host.js`, and sends the
same dor env on each PTY spawn.

`DORMOUSE_NODE` points at VS Code's own runtime (`process.execPath`, re-execed
as Node by VS Code's extension-host environment), not a user-installed Node.

Control direction:

```text
dor process
  -> pty-host JSON-lines net socket
  -> extension-host child-process IPC
  -> message-router
  -> VSCodeAdapter CustomEvent("dormouse:control-request")
  -> Wall handler
  -> message-router
  -> pty-host
  -> dor process
```

Because VS Code can host multiple Dormouse webviews in one extension host, the
request includes `DORMOUSE_SURFACE_ID`; `message-router.ts` routes to the webview
that owns that surface when one is available.

## Handle Model

Dormouse currently exposes one workspace and one window. Each visible Pane has
one terminal surface. The CLI still uses `surface` terminology for cmux
compatibility and accepts `pane` targets where cmux does.

Invariants:

- Stable ids and short refs are accepted where a surface/pane target is
  accepted.
- Short refs use cmux-style names: `surface:1`, `pane:2`, `workspace:1`,
  `window:1`.
- List output defaults to refs; commands that list handles accept
  `--id-format refs|uuids|both`.
- `--workspace workspace:1` / `--window window:1` and bare `1` are compatibility
  no-ops. Any other workspace/window target is rejected before host mutation.

## Current Commands

All implemented list commands call the private `surface.list` control method.
`Wall.tsx` derives the response from current Dockview panels plus terminal
state/activity snapshots, then returns `workspace:1` and `window:1`.

### `dor list-panes`

Usage:

```text
dor list-panes [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--window <id|ref|index>]
```

Behavior:

- Implemented cmux-compatible command.
- Lists visible Panes, grouped by `paneRef` in the `surface.list` response.
- Text output marks the focused Pane with `*`, prints the pane handle,
  `[N surface]` / `[N surfaces]`, and optional `[focused]`.
- `--json` returns `panes`, `workspace_ref`, and `window_ref`. Pane entries use
  cmux field names for focus, index, selected surface, and surface refs/ids.
- Dormouse currently has one terminal surface per Pane, so runtime
  `surface_count` is `1` for each Pane.

Text shape:

```text
* pane:1  [1 surface]  [focused]
```

### `dor list-pane-surfaces`

Usage:

```text
dor list-pane-surfaces [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--pane <id|ref|index>] [--window <id|ref|index>]
```

Behavior:

- Implemented cmux-compatible command.
- Defaults missing `--pane` to `focused`.
- `--pane` filters by surface id, surface ref, or pane ref. Because Dormouse has
  one surface per Pane, the command currently returns zero or one surface.
- Text output marks the selected surface with `*`, prints the surface handle,
  the surface title, and optional `[selected]`.
- `--json` returns `pane_ref`, `surfaces`, `workspace_ref`, and `window_ref`.
  Surface entries use cmux field names for index, selected state, title, and
  type.
- The `title` field for this command is the surface title reported by
  `surface.list`. It can look like a CWD when the shell is idle, or like the
  running command when a foreground command updates the title.

Text shape:

```text
* surface:1  dor list-pane-surfaces  [selected]
```

## Command Coverage

Status values:

| Status | Meaning |
| --- | --- |
| `implemented-blessed` | Implemented and intended as a first-class `dor` command. |
| `implemented-compat-only` | Implemented only to match an external CLI spelling; prefer a blessed `dor` command in new usage. |
| `planned` | Should be implemented next or soon, with semantics that fit Dormouse's model. |
| `undecided` | Not implemented; needs design work or a product decision. |
| `will-not-implement` | Out of scope for `dor`, incompatible with Dormouse's model, or deliberately not accepted as cruft. |

### cmux Commands

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

### tmux Commands

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

## cmux Compatibility

Dormouse tracks the public cmux CLI/API shape only where it maps cleanly:

- cmux has Pane + Surface; Dormouse currently has one terminal surface per Pane.
- cmux supports multiple workspaces/windows; Dormouse accepts only the singleton
  compatibility targets.
- cmux exposes both a CLI and socket API; Dormouse exposes only the CLI.
- In the cmux version used to derive this contract on 2026-05-28, the relevant
  working CLI commands are `list-panes` and `list-pane-surfaces`. The socket
  capability used underneath is named `surface.list`.
- Dormouse exposes only the implemented commands above. It does not currently
  expose aliases or recognized-but-unimplemented command stubs.
- Dormouse omits cmux JSON geometry fields such as `container_frame`,
  `pixel_frame`, rows/columns, and cell dimensions until those fields are part
  of the Dormouse control response.
- Dormouse also omits workspace/window UUID fields until the host exposes stable
  workspace/window ids distinct from the singleton refs.

## Errors

Successful commands exit `0`. Failed commands exit non-zero and print
`Error: <message>` to stderr.

Common failures:

- Missing or stale control endpoint.
- Unknown option or invalid flag value.
- Unsupported workspace/window target.
- Unsupported private control method.
- Layout not ready when the webview has not mounted.
