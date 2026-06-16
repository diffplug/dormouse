# Dor CLI

> See `docs/specs/glossary.md` for canonical Session and Pane vocabulary.
> `dor` uses `surface` for user-facing CLI handles. Pane remains layout
> vocabulary in the implementation and in existing compatibility commands.

Dormouse bundles a `dor` CLI into every terminal it launches. The CLI is the
public API; any socket used underneath it is private host plumbing.

Source of truth:

| Scope | Source |
| --- | --- |
| `stricli` application, command registry, and stdout/stderr capture | `dor/src/cli.ts` |
| Command implementation, `stricli` flag definitions, and output rendering | `dor/src/commands/*.ts` |
| Control method request/response types | `dor/src/commands/types.ts` |
| Socket client and request envelope | `dor/src/control-client.ts`, `dor/src/protocol.ts` |
| POSIX / Windows launchers | `dor/bin/dor`, `dor/bin/dor.cmd` |
| Snapshot tests for CLI output and help text | `dor/test/cli-output.test.mjs`, `dor/test/cli-help.test.mjs`, `dor/test/snapshots/` |
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

Dormouse currently exposes one workspace and one window internally, but no
workspace/window targeting CLI flags. Each visible Pane has one selected
surface. Most surfaces are terminals; `dor iframe` introduces a non-terminal
iframe surface. User-facing `dor` commands should expose surface handles; Pane
remains layout vocabulary and compatibility-command terminology.

Invariants:

- Stable ids and short refs are accepted where a surface/pane target is
  accepted.
- Surface targets also accept `title:<exact display title>`. If exactly one
  visible surface has that title, it is selected. If multiple visible surfaces
  match, the command fails and lists the matching surface refs.
- Short refs currently use cmux-style names for implemented handles:
  `surface:1`, `pane:2`.
- List output defaults to refs; commands that list handles accept
  `--id-format refs|uuids|both`.
- Workspace/window refs and target flags will be added only when Dormouse
  actually supports them.

## Iframe Surface: Limitations And Status

> Status: **provisional.** The `dor iframe` surface works for displaying a page,
> but has structural limitations (below) that may keep it from shipping. The
> likely path forward is to ship an **agent-browser** surface instead — a
> Dormouse-controlled browser view (see `lib/src/components/wall/AgentBrowserPanel.tsx`)
> that does not embed a foreign page as a peer browsing context — and to drop or
> hide `dor iframe`. That surface is specified in
> [dor-agent-browser.md](dor-agent-browser.md). Do not build features on top of
> the iframe surface until this is resolved.

An `<iframe>` pointed at an arbitrary URL is a **separate browsing context** from
the Wall. Dormouse's input, focus, and attention model assumes a single
same-document context, so the iframe surface conflicts with it in ways that are
inherent to the browser, not bugs we can patch away:

- **Focus leaves Dormouse entirely.** When the iframe gains focus, a focused
  cross-origin frame owns the keyboard. Its keystrokes fire in *its* document and
  never reach the parent. Dormouse's global shortcuts are a capturing `window`
  keydown listener (`lib/src/components/wall/use-wall-keyboard.ts`), so dual-tap-⌘,
  pane navigation, split, and kill all go dead until focus returns to the Wall.
  The same-origin policy means the parent cannot observe or intercept those keys —
  this cannot be fixed, only designed around (e.g. a click-to-interact overlay, or
  an accept-focus model with a mouse-driven escape affordance).

- **The app reads iframe-focus as being backgrounded.** Focusing the iframe fires
  a `blur` on the parent `window`. Current handlers treat that as the whole app
  losing focus: `Wall.tsx` clears cross-session attention, and
  `use-window-focused.ts` flips `windowFocused` to `false`, which drives the
  active styling (e.g. `SurfacePaneHeader.tsx`'s `isActiveHeader`). The result is
  every header/focus-ring goes inactive and attention clears the instant the
  iframe is focused. This part *is* fixable (distinguish `document.activeElement`
  being one of our own iframes from a real window blur) but is not yet done.

- **No programmatic focus handle.** `focusSession` (`lib/src/lib/terminal-lifecycle.ts`)
  only knows xterm terminals in a registry. The iframe pane is not registered, so
  `onClickPanel → enterTerminalMode → focusSession(iframeId)` is a no-op: Dormouse
  cannot focus the iframe programmatically and cannot tell when it is focused.

- **Some sites refuse to be framed, with no error signal.** Servers that send
  `X-Frame-Options` or a CSP `frame-ancestors` directive cannot be embedded at
  all, yielding a blank pane. Cross-origin frames do not report load errors to the
  embedder (`onError` never fires; `onLoad` fires even for a blocked frame), so the
  surface cannot reliably distinguish "loading", "blocked", and "broken". The
  current `IframePanel` shows a best-effort stall hint after a timeout only.

- **The VS Code webview must opt into framing.** The webview CSP
  (`vscode-ext/src/webview-html.ts`) is `default-src 'none'`; without a `frame-src`
  directive every `<iframe>` is blocked outright (blank white pane). A
  `frame-src http: https:` allowance is required for the surface to render at all.

## Current Implemented Commands

Implemented commands call private `surface.*` control methods. `surface.list`
derives its response from current Dockview panels plus terminal state/activity
snapshots where available, then returns `workspace:1` and `window:1`.

Command tails captured after `--` are sent as raw argv arrays (`command:
string[]`); the host — not `dor` — quotes them for the target shell. `dor`
cannot know which shell the target surface runs, so it forwards argv unquoted
and the host (`lib/src/components/Wall.tsx`, `dorCommandString`) detects the
target shell, picks a quoting style with
[`shellCommandKind` / `buildShellCommandForKind`](../../dor/src/commands/shell-quote.ts)
(`cmd` / `posix` / `powershell`), and renders a single command string used for
output, JSON responses, default `ensure` titles, and the launched command alike.

User-facing command docs live in the generated help snapshots. Implementation
details live in the command files. When `stricli` cannot express a desired
help shape, commands may declare narrow template-pattern `findReplace` /
`remove` help patches; those patches are intentionally snapshot-tested rather
than treated as a general docs renderer. Supported pattern tokens are `<LS>`
(line start plus leading horizontal whitespace), `<WS>` (one or more horizontal
whitespace characters), and `<TO-EOL>` (rest of line including the newline or
EOF). Command help patches can target the `command-usage` section separately
from `command-detail`.

- `dor split` [impl](../../dor/src/commands/split.ts) [docs](../../dor/test/snapshots/help/split.md)
- `dor ensure` [impl](../../dor/src/commands/ensure.ts) [docs](../../dor/test/snapshots/help/ensure.md)
- `dor version` [impl](../../dor/src/commands/version.ts) [docs](../../dor/test/snapshots/help/version.md)
- `dor send` [impl](../../dor/src/commands/send.ts) [docs](../../dor/test/snapshots/help/send.md)
- `dor read` [impl](../../dor/src/commands/read.ts) [docs](../../dor/test/snapshots/help/read.md)
- `dor kill` [impl](../../dor/src/commands/kill.ts) [docs](../../dor/test/snapshots/help/kill.md)
- `dor iframe` [impl](../../dor/src/commands/iframe.ts) [docs](../../dor/test/snapshots/help/iframe.md)
- `dor agent-browser` / `dor ab` — delegates to the user's `agent-browser`,
  rendered in a Dormouse-native surface; see [dor-agent-browser.md](dor-agent-browser.md)
  (the chosen alternative to the iframe surface)
- `dor list-panes` [impl](../../dor/src/commands/list-panes.ts) [docs](../../dor/test/snapshots/help/list-panes.md)
- `dor list-pane-surfaces` [impl](../../dor/src/commands/list-pane-surfaces.ts) [docs](../../dor/test/snapshots/help/list-pane-surfaces.md)
