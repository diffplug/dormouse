# Dor CLI

> See `docs/specs/glossary.md` for canonical Session and Pane vocabulary.
> `dor` uses `surface` for user-facing CLI handles. Pane remains layout
> vocabulary in the implementation and in existing compatibility commands.

Dormouse bundles a `dor` CLI into every terminal it launches. The CLI is the
public API; any socket used underneath it is private host plumbing.

Source of truth:

| Scope | Source |
| --- | --- |
| CLI parser and command registry | `dor/src/cli.ts` |
| Command behavior specs, parser, help, and output rendering | `dor/src/commands/*.ts` |
| Control method request/response types | `dor/src/commands/types.ts` |
| Socket client and request envelope | `dor/src/control-client.ts`, `dor/src/protocol.ts` |
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

The behavior specs live at the top of each command implementation file:

- [`dor split`](../../dor/src/commands/split.ts)
- [`dor ensure`](../../dor/src/commands/ensure.ts)
- [`dor list-panes`](../../dor/src/commands/list-panes.ts)
- [`dor list-pane-surfaces`](../../dor/src/commands/list-pane-surfaces.ts)

## Compatibility References

`dor-cli.md` documents the commands Dormouse actually exposes today. External
CLI migration guidance lives in separate specs so this file stays focused:

- `docs/specs/dor-cli-compat-cmux.md` describes how to migrate cmux-shaped
  scripts and habits.
- `docs/specs/dor-cli-compat-tmux.md` describes how to migrate tmux-shaped
  scripts and habits.

When adding a command because a migration pattern needs it, update the relevant
compatibility spec first, then update this file after the command is implemented
and snapshot tested.

## Errors

Successful commands exit `0`. Failed commands exit non-zero and print
`Error: <message>` to stderr.

Common failures:

- Missing or stale control endpoint.
- Unknown option or invalid flag value.
- Unsupported workspace/window target.
- Unsupported private control method.
- Layout not ready when the webview has not mounted.
