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
  a CWD-style surface label, and optional `[selected]`.
- `--json` returns `pane_ref`, `surfaces`, `workspace_ref`, and `window_ref`.
  Surface entries use cmux field names for index, selected state, title, and
  type.
- The `title` field for this command prefers `requested_working_directory`
  formatted as a short trailing path. When no CWD is known, it prints
  `<cwd unknown>` rather than falling back to the transient running command
  title.

Text shape:

```text
* surface:1  …/worktrees/0cbc/mouseterm  [selected]
```

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
