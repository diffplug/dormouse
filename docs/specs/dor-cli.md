# Dor CLI

> See `docs/specs/glossary.md` for canonical Session and Pane vocabulary.
> `dor` uses `surface` for user-facing CLI handles. Pane remains layout
> vocabulary in the implementation and in existing compatibility commands.

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
one terminal surface. User-facing `dor` commands should expose surface handles;
Pane remains layout vocabulary and compatibility-command terminology.

Invariants:

- Stable ids and short refs are accepted where a surface/pane target is
  accepted.
- Short refs use cmux-style names: `surface:1`, `pane:2`, `workspace:1`,
  `window:1`.
- List output defaults to refs; commands that list handles accept
  `--id-format refs|uuids|both`.
- `--workspace workspace:1` / `--window window:1` and bare `1` are compatibility
  no-ops. Any other workspace/window target is rejected before host mutation.

## Current Implemented Commands

Implemented commands call private `surface.*` control methods. `surface.list`
derives its response from current Dockview panels plus terminal state/activity
snapshots, then returns `workspace:1` and `window:1`.

### `dor split`

Usage:

```text
dor split [--left|--right|--up|--down|--auto] [--command <cmd>] [--minimize] [--surface <id|ref|index>] [--json]
```

Behavior:

- Calls the private `surface.split` control method.
- Creates a new terminal surface by splitting an existing surface.
- Direction flags are mutually exclusive. If no direction is provided, `--auto`
  is used.
- `--auto` chooses `right` when the target surface is wide and `down` when it is
  narrow.
- `--surface` selects the surface to split. If omitted, Dormouse uses the
  caller surface when available, then the focused surface.
- `--command` runs the given command as the new terminal surface's initial
  command.
- `--minimize` creates the surface and immediately sends it to the minimized
  area.
- No workspace argument exists until Dormouse supports multiple workspaces.
- `split` does not know about non-terminal surface types. Compose future content
  commands through the terminal:

```sh
dor split --right --command "dor iframe https://example.com"
dor split --auto --command "dor agent-browser open https://example.com"
```

Text shape:

```text
created surface:2  [right]
created surface:3  [down]  [minimized]  "pnpm dev"
```

JSON shape:

```json
{
  "status": "created",
  "surface_id": "pane-abc",
  "surface_ref": "surface:2",
  "direction": "right",
  "minimized": false,
  "command": "pnpm dev"
}
```

### `dor ensure`

Usage:

```text
dor ensure [--title <title>] [--minimize] [--surface <id|ref|index>] [--json] -- <command...>
```

Behavior:

- Calls the private `surface.ensure` control method.
- Ensures one surface exists in the current workspace for a user-enforced title.
- The idempotency key is always the user-enforced title.
- If `--title` is omitted, Dormouse derives the title from the command after
  `--`.
- If a surface in the current workspace already has the enforced title,
  Dormouse returns that surface and does not start another command.
- If no surface has that enforced title, Dormouse creates a split, starts the
  command, marks the surface title as user-enforced, and returns the new
  surface.
- A user-enforced title is visible in the UI and must not be overwritten by
  terminal title escape sequences from the running process.
- Matching uses Dormouse metadata, not process inspection.
- Minimized surfaces participate in matching.
- `--minimize` applies only when creating a new surface; it does not minimize an
  existing match.
- `--surface` selects the surface to split only when creating a new surface. If
  omitted, Dormouse uses the same caller/focused fallback as `dor split`.
- Closed/killed surfaces do not participate in matching.
- No workspace argument exists until Dormouse supports multiple workspaces.

Text shape:

```text
created surface:3  "dev server"
existing surface:3  "dev server"
```

JSON shape:

```json
{
  "status": "created",
  "surface_id": "pane-def",
  "surface_ref": "surface:3",
  "title": "dev server",
  "command": "pnpm dev:workspace",
  "minimized": false
}
```

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

## Compatibility References

`dor-cli.md` documents the commands Dormouse actually exposes today. External
CLI compatibility planning lives in separate specs so this file stays focused:

- `docs/specs/dor-cli-compat-cmux.md` tracks cmux command coverage and policy.
- `docs/specs/dor-cli-compat-tmux.md` tracks tmux command coverage and policy.

When adding a command for compatibility, update the relevant compatibility spec
first, then update this file after the command is implemented and snapshot
tested.

## Errors

Successful commands exit `0`. Failed commands exit non-zero and print
`Error: <message>` to stderr.

Common failures:

- Missing or stale control endpoint.
- Unknown option or invalid flag value.
- Unsupported workspace/window target.
- Unsupported private control method.
- Layout not ready when the webview has not mounted.
