# Dor CLI

Dormouse ships with a `dor` CLI. The goal of the CLI is to allow programmatic control of Dormouse features while staying compatible with the useful parts of the public `cmux` CLI/API contract where the models overlap.

## Handle model

Dormouse has a single window/workspace model for now, and each visible pane has exactly one surface. The CLI still uses `surface` terminology for cmux compatibility because cmux users and agents target terminal tabs/surfaces through that handle.

Handle rules:

- Commands accept stable ids and short refs where a surface is accepted.
- Short refs use cmux-style names such as `surface:1`, `pane:2`, `workspace:1`, and `window:1`.
- Output defaults to short refs. Commands that list handles also accept `--id-format refs|uuids|both`; `refs` is the default.
- `DORMOUSE_SURFACE_ID` is the stable id for the invoking terminal surface. It is the default source surface for commands such as `new-split`.
- Dormouse does not support multiple windows or workspaces yet. `--workspace workspace:1` and `--window window:1` are accepted as no-op compatibility flags; any other workspace/window target is rejected with a clear error.

## Shim and path prepending

Dormouse must make `dor` available in every terminal session it launches without
requiring a global install such as `npm i -g`. The CLI is bundled with both the
VS Code extension and the standalone app, and every spawned PTY receives a
Dormouse-controlled CLI directory prepended to `PATH`.

The bundled CLI directory contains:

- `dor` — POSIX launcher script.
- `dor.cmd` — Windows launcher script for `cmd.exe` and PowerShell.
- `dor.js` — compiled TypeScript CLI entrypoint.
- `package.json` — package metadata declaring `"type": "module"` so Node runs
  the compiled ESM entrypoint without falling back to parent sidecar metadata.

The launcher scripts are intentionally tiny wrappers around the bundled
JavaScript entrypoint. They must use environment variables injected by the host,
not `#!/usr/bin/env node`, because standalone users may not have `node` on their
global `PATH`.

POSIX launcher shape:

```sh
#!/bin/sh
exec "$DORMOUSE_NODE" "$DORMOUSE_CLI_JS" "$@"
```

Windows launcher shape:

```bat
@echo off
"%DORMOUSE_NODE%" "%DORMOUSE_CLI_JS%" %*
```

At PTY spawn time, the host injects:

- `DORMOUSE_NODE` — absolute path to the Node.js runtime Dormouse will use for
  `dor`.
- `DORMOUSE_CLI_JS` — absolute path to the bundled `dor.js` entrypoint.
- `DORMOUSE_SURFACE_ID` — stable PTY/session id for commands that need to act
  relative to the invoking terminal.
- `DORMOUSE_CONTROL_SOCKET` / `DORMOUSE_CONTROL_TOKEN` when the control socket is
  available.

The host also prepends the bundled CLI directory to `PATH`, so `dor new-split left`
works from any Dormouse-launched shell. This path only needs to be stable for the
lifetime of the spawned PTY; it is acceptable for the VS Code extension install
path or standalone app resource path to change across app upgrades because new
PTYs receive a freshly computed path.

The same CLI package may also be published to npm for users who want `dor`
available outside Dormouse-launched shells, but the bundled PATH-injected CLI is
the supported default. The bundled CLI must remain version-matched to the running
host.

## Standalone implementation

The standalone Tauri app stages the workspace `dor` package into
`standalone/sidecar/dor-cli` before dev/build. Tauri includes that staged
directory through the existing sidecar resource bundle.

At app startup, Rust starts the Node.js sidecar with absolute paths for
`DORMOUSE_NODE`, the staged CLI entrypoint, and a private control socket/token.
The sidecar prepends the staged `bin` directory to each spawned PTY's `PATH` and
sets the public PTY environment described above. The sidecar may use an internal
`DORMOUSE_CLI_BIN` value while spawning PTYs, but terminal sessions should rely
on `PATH` rather than that internal variable.

`dor` talks to the standalone app over a JSON-lines Node `net` socket. The
sidecar validates the token, forwards the request to Rust as `dor:controlRequest`,
Rust emits that to the webview, and `Wall` answers from current Dockview and
terminal-state snapshots. Responses travel back through Rust to the sidecar,
then to the `dor` process. The socket protocol is an implementation detail; the
public API is the CLI.

## VS Code implementation

The VS Code extension stages the same workspace `dor` package into
`vscode-ext/dor-cli` before the extension-host build. Packaged VSIX files include
that staged directory alongside `dist/` and `media/`.

The extension host starts `pty-host.js` with the same `DORMOUSE_NODE`,
`DORMOUSE_CLI_JS`, private control socket, and token shape used by standalone.
The forked PTY host runs the same control server module as standalone and uses
the shared PTY core to prepend the staged `bin` directory to each spawned PTY's
`PATH` while setting `DORMOUSE_SURFACE_ID`.

Because VS Code can host multiple Dormouse webviews in one extension host, `dor`
requests include the invoking `DORMOUSE_SURFACE_ID` as socket metadata. The PTY
host forwards the request over child-process IPC, the extension router sends it
to the webview that owns that surface, and the shared `Wall` handler answers from
Dockview and terminal-state snapshots. Responses travel back through the router
to the PTY host and finally to the `dor` process.

## cmux compatibility

We try to be compatible with [the public cmux API](https://cmux.com/docs/api) so that it is easy for users and agents to move back and forth between the two applications. Some key differences:

- cmux allows multiple tabs within a split, Dormouse allows only a single tab. cmux calls a given split a "Pane", and a tab within that split a "Surface". Our CLI uses the `surface` terminology for compatibility with cmux, and we support the `--surface` argument.
- cmux has multiple workspaces. Dormouse has one, so `--workspace workspace:1` is accepted as a compatibility no-op and other workspace targets are rejected.
- cmux allows multiple windows. Dormouse does not support cutting across VS Code and the standalone, so `--window window:1` is accepted as a compatibility no-op and other window targets are rejected.
- cmux has a CLI tool and a public socket API. Dormouse exposes only the CLI as public API; any socket used by `dor` is an implementation detail.

Current cmux exposes surface operations under a mix of names. In the installed cmux version used to derive this spec, `cmux list-surfaces` and `cmux focus-surface` are not CLI commands. The equivalent CLI commands are `cmux list-panels` and `cmux focus-panel`, while the socket capabilities are named `surface.list` and `surface.focus`.

Dormouse's canonical command names use `surface`; it also accepts the current cmux `panel` aliases where they map cleanly.

## Commands

### `dor new-split`

Usage:

```text
dor new-split <left|right|up|down> [--surface <id|ref|index>] [--panel <id|ref|index>] [--focus <true|false>] [--workspace <id|ref|index>] [--window <id|ref|index>]
```

Behavior:

- Splits from the source surface in the requested direction.
- The source surface defaults to `DORMOUSE_SURFACE_ID`.
- `--panel` is an alias for `--surface`.
- `--focus` defaults to `false`; when false, focus remains on the original surface. When true, focus moves to the new surface.
- The new split creates a new Dormouse pane with one terminal surface.
- Success prints `OK surface:<n> workspace:1` and exits `0`, matching cmux's text output shape.

Observed cmux output:

```text
$ cmux new-split right --focus false
OK surface:2 workspace:1
```

After that command, `cmux tree` showed a new `pane:2` containing `surface:2`, while the caller remained focused because `--focus false`.

### `dor list-surfaces`

Aliases:

- `dor list-panels`
- `dor list-pane-surfaces` with cmux's pane-scoped default

Usage:

```text
dor list-surfaces [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--window <id|ref|index>] [--pane <id|ref|index>]
```

Behavior:

- Lists terminal surfaces in the current workspace.
- `--pane` restricts the list to a pane. Because Dormouse has one surface per pane, this returns either one surface or no surfaces.
- `dor list-pane-surfaces` defaults `--pane` to the focused/current pane when `--pane` is omitted, matching cmux. `dor list-surfaces` and `dor list-panels` list all surfaces in the current workspace when `--pane` is omitted.
- Text output marks the focused surface with `*`.
- Text output includes the surface ref, type (`terminal`), `[focused]` when applicable, and the display title.
- `--id-format both` prints the stable id after the short ref.
- `--json` returns structured data with `surfaces`, `workspace_ref`, and `window_ref`.

Observed cmux text output shape:

```text
$ cmux list-panels
* surface:1  terminal  [focused]  "build"
  surface:2  terminal  "repo"
```

Observed cmux `--id-format both` output shape:

```text
$ cmux list-panels --id-format both
  surface:1 11111111-1111-4111-8111-111111111111  terminal  "build"
* surface:2 22222222-2222-4222-8222-222222222222  terminal  [focused]  "repo"
```

Observed cmux JSON shape:

```json
{
  "surfaces": [
    {
      "focused": true,
      "index": 0,
      "index_in_pane": 0,
      "pane_ref": "pane:1",
      "ref": "surface:1",
      "requested_working_directory": "/path/to/project",
      "selected_in_pane": true,
      "title": "build",
      "type": "terminal"
    }
  ],
  "window_ref": "window:1",
  "workspace_ref": "workspace:1"
}
```

### `dor focus-surface`

Alias:

- `dor focus-panel`

Usage:

```text
dor focus-surface (--surface <id|ref|index> | --panel <id|ref|index>) [--workspace <id|ref|index>] [--window <id|ref|index>]
dor focus-surface <id|ref|index>
```

Behavior:

- Focuses the requested surface.
- `--panel` is an alias for `--surface`.
- The target is required unless passed positionally.
- Success prints `OK surface:<n> workspace:1` and exits `0`, matching cmux's current `focus-panel` output shape.

Observed cmux output:

```text
$ cmux focus-panel --panel surface:2
OK surface:2 workspace:1
```

After that command, `cmux identify` reported the caller as `surface:1` and the focused surface as `surface:2`, so Dormouse should preserve the distinction between the invoking surface and the app's focused surface.

## Errors

Successful commands exit `0`. Failed commands exit non-zero and print `Error: <message>` to stderr. A command must not perform a partial layout mutation when argument validation fails.

Common failures:

- Missing or stale control socket.
- Missing target for `focus-surface`.
- Unknown source or target surface.
- Unsupported workspace/window target.
- Invalid direction for `new-split`.
