# Dor CLI

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane vocabulary.
> A **Surface** (the durable occupant of a Pane — a terminal Session or a browser
> surface) is `dor`'s user-facing CLI handle. Pane remains layout vocabulary in the
> implementation and in existing compatibility commands.

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
| Implemented webview control handler | `lib/src/components/wall/use-dor-control.ts` (the `useDorControl` hook, mounted by `lib/src/components/Wall.tsx`) |

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

- `DORMOUSE_NODE` — Node runtime used by the launcher. On Windows the standalone
  host must point this at a **console-subsystem** node: its bundled node is patched
  to the GUI subsystem (to avoid a stray terminal window when spawning the
  sidecar), but a GUI-subsystem node drops all stdout/stderr when `dor` runs inside
  a shell's ConPTY. See `docs/specs/standalone.md` (Windows node subsystem).
- `DORMOUSE_CLI_JS` — absolute path to staged `dist/dor.js`.
- `DORMOUSE_SURFACE_ID` — stable invoking Session/surface id.
- `DORMOUSE_HOST` — hosting app kind: `vscode` or `standalone`.
- `DORMOUSE_HOST_WORKSPACE` — VS Code only: what the owning window has open —
  the `.code-workspace` file when one is loaded, else the first workspace
  folder. Unset under the standalone app (no workspace concept) and for an
  empty VS Code window.
- `DORMOUSE_CONTROL_SOCKET` and `DORMOUSE_CONTROL_TOKEN` — private control
  endpoint credentials.

`DORMOUSE_CLI_BIN` is host-internal spawn configuration. Terminals should rely
on `PATH`, not on that variable.

On Windows, `DORMOUSE_CLI_BIN` and `DORMOUSE_CLI_JS` must be plain paths, never
`\\?\` verbatim paths. The standalone host derives them from Tauri's
`resource_dir()`, which returns a verbatim prefix in the bundled/dev layout; the
host strips it once at the boundary (`resolve_sidecar_path`), so every derived
path is plain. `dor.cmd` is reached through
`DORMOUSE_CLI_BIN` on `PATH`, and cmd.exe cannot execute a batch file via a
verbatim path — it fails with "The system cannot find the path specified."

`dor.cmd` (and any `.cmd`/`.bat`) must be checked out with **CRLF** line endings:
cmd.exe misparses LF-only batch files, dropping the leading character of each
line (`setlocal` → `tlocal`, `if not` → `not`) — so the launcher spews errors
even when it otherwise runs. A `.gitattributes` rule (`*.cmd text eol=crlf`)
enforces this; the POSIX `dor` launcher is pinned to `eol=lf`. Both host staging
copies bytes verbatim (`scripts/stage-dor-cli.mjs`), so the checked-out endings
are what ship.

### Git Bash PATH survival

`DORMOUSE_CLI_BIN` is prepended to the spawned PTY's `PATH` by the shared PTY
core (`withPrependedPath` in `standalone/sidecar/pty-core.js`). On Windows that
prepend must survive Git Bash / MSYS login. `/etc/profile` rebuilds `PATH` from
an exported `ORIGINAL_PATH` whenever that variable is already set, only capturing
the live `PATH` into it when it is unset. `ORIGINAL_PATH` leaks into the host env
whenever the host (VS Code, the standalone app) was itself launched from a Git
Bash session, and that inherited value predates our prepend — so a login shell
would silently drop `dor` from `PATH`. The core strips `ORIGINAL_PATH` from the
child env on win32 (`withoutInheritedMsysOriginalPath`), forcing the shell to
recapture the exact `PATH` we hand node-pty. cmd.exe / PowerShell never read
`ORIGINAL_PATH`, so the strip is a no-op for them.

## Spawning External Binaries

Any time Dormouse spawns an external/user-installed binary — `dor ab` driving
`agent-browser`, the agent-browser host running tab/eval/screenshot commands — it
goes through **`spawnAndCapture` from the `dor-lib-common` package**, never raw
`node:child_process` `spawn`. That helper is the single home for the hard-won
Windows recipe, shared by `dor` and the `lib` host (which otherwise have no common
code); both packages depend on `dor-lib-common`. It owns three concerns:

**1. cross-spawn, not raw spawn.** Two distinct failures bite a naive spawn on
Windows:

- **ENOENT on a bare name.** Node's `spawn` does not consult `PATHEXT`, so a bare
  `agent-browser` never resolves the `agent-browser.cmd` PATH shim that npm/vfox
  installs. (`agent-browser` works from a POSIX shell only because the file there
  is a real executable with a shebang; on Windows it is a `.cmd`.)
- **EINVAL on a `.cmd` even by full path.** Node ≥22 refuses to spawn `.cmd`/
  `.bat` files without a shell (the CVE-2024-27980 hardening), so resolving the
  absolute `.cmd` path and spawning it directly still fails.

`cross-spawn` resolves the command via `PATH`/`PATHEXT` and routes `.cmd`/`.bat`
through `cmd.exe` with correct argument escaping, and is a transparent passthrough
on POSIX. Caveat: a literal `%VAR%` inside an argument can still be expanded by
`cmd.exe` when it passes through a `.cmd` shim — an unavoidable Windows batch
limitation. Our forwarded arguments (URLs, selectors, the host's hardcoded `eval`
scripts) contain no `%VAR%` patterns, so this does not arise in practice.

**2. `windowsHide`.** cross-spawn runs `.cmd` shims through `cmd.exe`; without
`windowsHide` each spawn flashes a console window that steals focus — and the
panel's screenshot loop spawns one per stream-frame pulse, so a live page would
flicker windows several times a second.

**3. Resolve on `exit`, not `close`, with an exit-time snapshot.** `agent-browser
open` launches a long-lived per-session daemon that on Windows inherits the
parent's stdout/stderr pipes; those pipes never reach EOF while the daemon lives,
so `close` (which waits for stdio to drain) never fires and a `close`-only wait
hangs forever. `spawnAndCapture` waits for `close` but falls back to `exit` after
a short grace, and resolves the grace path with the output snapshotted at `exit`
so the daemon's post-command scribbles don't leak into the result. (POSIX dodges
the whole thing because the daemon double-forks and detaches from the inherited
fds, closing the pipe — which is why none of this surfaced on macOS.)

Resolution: `dor-lib-common`'s package `exports` point at its built `dist` (clean,
Node-type-free `.d.ts` for `dor`'s `tsc`, which deliberately avoids `@types/node`);
every esbuild/Vite consumer (`dist/dor.js`, the sidecar `.cjs`, vscode-ext) inlines
it. `dor`'s `prebuild` builds `dor-lib-common` first so its `.d.ts` exists.

## Host Plumbing

### Standalone

`standalone/package.json` runs `pnpm stage:dor-cli` before Tauri dev/build.
Rust resolves the staged/bundled CLI paths, starts the Node sidecar with
`DORMOUSE_HOST`, `DORMOUSE_NODE`, `DORMOUSE_CLI_BIN`, `DORMOUSE_CLI_JS`,
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

Dormouse supports multiple Workspaces within one Window (`docs/specs/glossary.md`):
standalone hosts several Workspaces with one active, and VS Code maps each webview
to a Workspace. The handle model therefore reserves `workspace:<n|name>` and
`window:<n>` refs. The full containment hierarchy is `Window ⊃ Workspace ⊃ Pane ⊃
Surface`. Each visible Pane has one selected Surface; a Surface is a terminal (a
Session) or a browser surface — the `iframe` / agent-browser renderers of `dor`'s
unified `browser` surface (`docs/specs/dor-browser.md`). User-facing `dor` commands
expose Surface handles; Pane remains layout vocabulary and compatibility-command
terminology.

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
- Reserved: `workspace:<n>` (and `workspace:<name>` when exactly one Workspace
  matches) and `window:<n>` select a container. The ref grammar is reserved now
  so surface/pane refs never collide with it; the flag and commands that consume
  it are staged — see [Future](#future).

## Current Implemented Commands

Implemented commands call private `surface.*` control methods. `surface.list`
derives its response from the current visible panes plus terminal state/activity
snapshots where available, then returns `workspace:1` and `window:1` — it
reports the single active Workspace (Workspace-aware tagging is staged; see
[Future](#future)).

Command tails captured after `--` are sent as raw argv arrays (`command:
string[]`); the host — not `dor` — quotes them for the target shell. `dor`
cannot know which shell the target surface runs, so it forwards argv unquoted
and the host (`lib/src/components/wall/use-dor-control.ts`, `dorCommandString`) detects the
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

- `dor split` [impl](../../dor/src/commands/split.ts) [docs](../../dor/test/snapshots/help/split.md).
  Bare `dor split` focuses the new surface (in passthrough mode focus follows the
  selection, so the user types straight into it); `dor split -- <command>` runs
  the command in the background and leaves focus on the caller, like `dor ensure`.
  Both are wired through `createSplitSurface`'s `focusNeutral` flag
  (`lib/src/components/wall/use-dor-control.ts`).
- `dor ensure` [impl](../../dor/src/commands/ensure.ts) [docs](../../dor/test/snapshots/help/ensure.md)
- `dor version` [impl](../../dor/src/commands/version.ts) [docs](../../dor/test/snapshots/help/version.md)
- `dor send` [impl](../../dor/src/commands/send.ts) [docs](../../dor/test/snapshots/help/send.md)
- `dor read` [impl](../../dor/src/commands/read.ts) [docs](../../dor/test/snapshots/help/read.md)
- `dor kill` [impl](../../dor/src/commands/kill.ts) [docs](../../dor/test/snapshots/help/kill.md)
- `dor iframe` — **provisional**; high-fidelity URL embed with structural
  limitations; the `iframe` renderer of the unified `browser` surface, see
  [dor-browser.md](dor-browser.md).
  [impl](../../dor/src/commands/iframe.ts) [docs](../../dor/test/snapshots/help/iframe.md)
- `dor agent-browser` / `dor ab` — delegates to the user's `agent-browser`,
  rendered in a Dormouse-native surface; the `ab-screencast` renderer of the
  unified `browser` surface, see [dor-browser.md](dor-browser.md)
- `dor identify` — JSON identity dump: caller surface (matched locally against
  `DORMOUSE_SURFACE_ID`, `null` when not visible), focused surface, and the
  hosting app (`DORMOUSE_HOST` / `DORMOUSE_HOST_WORKSPACE` / runtime paths).
  Composes over `surface.list` — no dedicated control method. Deliberately does
  not expose the control socket: the CLI is the public API and the socket is
  private plumbing.
  [impl](../../dor/src/commands/identify.ts) [docs](../../dor/test/snapshots/help/identify.md)
- `dor list-panes` [impl](../../dor/src/commands/list-panes.ts) [docs](../../dor/test/snapshots/help/list-panes.md)
- `dor list-pane-surfaces` [impl](../../dor/src/commands/list-pane-surfaces.ts) [docs](../../dor/test/snapshots/help/list-pane-surfaces.md)

## Future

- **Workspace handles and commands** — a `--workspace` target flag and `dor
  workspace` management commands (list / new / rename / close / switch)
  consuming the reserved `workspace:<n|name>` / `window:<n>` ref grammar in the
  handle model above. Like every other command they ship with their
  snapshot-tested help and the control methods that back them, not ahead of
  them. Staged with the workspaces rollout (`docs/specs/layout.md` `## Future`,
  workspaces-rollout).
- **Workspace-aware `surface.list`** — tags each surface with its real
  `workspace:<n>` / `window:<n>` membership instead of reporting the single
  active Workspace.
