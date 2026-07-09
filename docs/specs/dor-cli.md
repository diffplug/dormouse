# Dor CLI

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane vocabulary.
> A **Surface** (the durable occupant of a Pane — a terminal Session or a browser
> surface) is `dor`'s user-facing CLI handle. Pane remains layout vocabulary;
> public `dor` targeting addresses Surfaces, not layout positions.

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
expose Surface handles; Pane remains layout vocabulary and is not part of the
public target grammar.

Invariants:

- Stable ids and stable short refs are accepted where a Surface target is
  accepted. A target may be `surface:N`, a stable Surface id, or
  `surface:<stable-id>`. `surface:focused` selects the focused Surface in the
  current Workspace; `surface:self` selects the invoking Surface from
  `DORMOUSE_SURFACE_ID`.
- Short refs use `surface:1`, `surface:2`, ... and are Workspace-scoped stable
  refs, not layout/list positions. Each Workspace starts at `surface:1` and
  assigns the next number when a Surface is created/restored. The live id→ref map
  and a separate monotonic counter both persist in the session snapshot
  (`PersistedSession.surfaceRefs` / `surfaceRefsNext`); the counter — not the max
  of the surviving map — is the source of truth for the next number, so a killed
  Surface's entry is dropped from the map immediately without its number ever
  being reused. Reordering panes, minimizing, reattaching, zooming, focusing, and
  browser render-mode swaps do not change the ref. Killing a Surface retires its
  ref; a later target that names it fails instead of silently retargeting.
- Surface targets also accept `title:<exact display title>`, primarily for human
  recovery; automation should prefer refs/ids from command responses or
  `dor list --json`. Action commands (`read`, `send`, `kill`) resolve against
  listed Surfaces, including minimized ones. Placement/reference commands
  (`split`, `ensure`, `iframe`, browser creation) resolve against visible
  Surfaces. If multiple Surfaces in the relevant scope match, the command fails
  and lists the matching surface refs.
- Bare numeric targets and `pane:N` are not Surface handles. Pane refs are
  reserved for future layout-only commands if those commands ever need them.
- Text list output defaults to refs; commands that list handles accept
  `--id-format refs|ids|both` (`uuids` is accepted as a compatibility alias for
  `ids`). JSON list output always includes both refs and stable ids.
- Reserved: `workspace:<n>` (and `workspace:<name>` when exactly one Workspace
  matches) and `window:<n>` select a container. The ref grammar is reserved now
  so Surface refs never collide with it; the flag and commands that consume it
  are staged — see [Future](#future). Stable Surface ids are globally unique, but
  cross-Workspace id routing is staged with Workspace-aware listing/targeting;
  the current webview control handler resolves ids in the mounted Workspace.

## Current Implemented Commands

Implemented commands call private `surface.*` control methods. `surface.list`
derives its response from the current Workspace's Surfaces — the visible panes
**plus minimized (doored) Surfaces**, each tagged with its `view`
(`paned` / `zoomed` / `minimized`) — joined with terminal state and
activity snapshots. It returns `workspace:1` and `window:1`: it reports the
single active Workspace (Workspace-aware tagging is staged; see
[Future](#future)). Two builders back this on the host
(`lib/src/components/Wall.tsx`): `buildDorSurfaces` is the visible-pane
projection used for `dor` commands that need geometry (split / browser-surface
placement), while `buildDorSurfaceList` adds the minimized Surfaces for
`dor list` and for direct terminal operations (`send`, `read`, `kill`). `dor
list` rows are sorted by the Workspace-stable `surface:N` ref; the ref registry
is owned by `Wall` and persisted with the session, independent of Lath layout
order. Minimized refs remain valid targets for operations that do not need a
visible reference pane.

When the request sets `includePorts` (`dor list --ports`), the host calls
`PlatformAdapter.getOpenPorts(id)` (`docs/specs/dor-browser.md` → Dev-Server
Chip) for each terminal Surface, in parallel. Enumeration shells out per pane
(`lsof` / `Get-NetTCPConnection`) under `OPEN_PORT_TIMEOUT_MS`, so it is opt-in;
a remote paired session reports none, and any error degrades to an empty list
rather than failing the call.

Command tails captured after `--` are sent as raw argv arrays (`command:
string[]`); the host — not `dor` — quotes them for the target shell. `dor`
cannot know which shell the target surface runs, so it forwards argv unquoted
and the host (`lib/src/components/wall/use-dor-control.ts`, `dorCommandString`) detects the
target shell, picks a quoting style with
[`shellCommandKind` / `buildShellCommandForKind`](../../dor/src/commands/shell-quote.ts)
(`cmd` / `posix` / `powershell`), and renders a single command string used for
output, JSON responses, default `ensure` titles, and the launched command alike.

Every first-party command except the `dor agent-browser` / `dor ab` passthrough
accepts `--json` and emits a stable object with the same handles as its text
output. Single-Surface responses always include both `surface_id` (the stable
id) and `surface_ref` (the Workspace-stable short ref). `dor ab` forwards
arguments to the user's `agent-browser` CLI, so any JSON mode there belongs to
that delegated command surface rather than to `dor`.

Commands that operate on one existing Surface take the target as a required
positional handle: `dor read <surface>`, `dor send <surface> ...`, and
`dor kill <surface> ...`. Commands that create/place a Surface keep `--surface`
as an optional visible reference Surface (`split`, `ensure`, `iframe`, and
browser creation). `dor send <surface>` accepts exactly one input mode:
`--text`/`--key`, `--stdin`, or `--sequence`. `--text` and `--key` may be
combined only in that order, duplicate input flags are rejected, and
`--sequence` is the explicit form for arbitrary ordering or multiple events.

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
- `dor list` — the unified Surface listing. Lists every Surface in the current
  Workspace (terminals and browser Surfaces, including minimized ones), one row
  per Surface in stable `surface:N` order. Text marks the focused Surface with
  `*` and the calling terminal with `(you)`, and shows kind, render mode (`-` for
  terminals), `view`, location (cwd for terminals, URL for browser Surfaces),
  title, and `[ringing]` / `[todo]` tags.
  Filters are ANDed: `--kind terminal|browser`, `--view
  paned|zoomed|minimized`, exact `--command <text>`, `--cwd <path>` (resolved
  like `dor ensure --cwd`, relative to the invoking shell's `PWD` when
  available), and `--port <number>`. `--ports` adds every terminal's listening
  ports. `--port` is distinct from `--ports`: it filters to terminal Surfaces
  that own the port (browser Surfaces never match, even when showing that URL),
  implies the same opt-in port scan, and includes port details in JSON / text
  output. `--json` always includes both stable ids and stable refs, and
  additionally emits the identity dump `dor identify` used to print — top-level
  `caller_surface_ref` / `caller_surface_id` (matched locally against
  `DORMOUSE_SURFACE_ID`, `null` when the caller is not in the list),
  `focused_surface_ref` / `focused_surface_id`, and a `host` block
  (`DORMOUSE_HOST` / `DORMOUSE_HOST_WORKSPACE` / runtime paths). It deliberately
  does not expose the control socket: the CLI is the public API and the socket is
  private plumbing.
  Replaces the retired cmux-shaped `list-panes` / `list-pane-surfaces` and the
  `identify` command. Filtering by activity/state and workspace scope are staged
  (see [Future](#future)). [impl](../../dor/src/commands/list.ts)
  [docs](../../dor/test/snapshots/help/list.md)

## Future

- **`dor` CLI evaluation stories** — keys are intentionally not a
  surface-wide concept today. `dor ensure` already has an **implicit**
  command+cwd idempotency key so an agent can discover and reuse a command the
  user started by hand. Traditional PTY Surfaces otherwise have identity by PTY:
  a command is state inside that PTY, and refs/ids from `dor list --json` are the
  automation handles. Browser Surfaces are different because the controlled
  session is externally held by `agent-browser`; `dor ab --key <name>` is the
  stable join key for that external browser session and the Dormouse Surface
  bound to it.

  These stories are product tests for the whole CLI: command orchestration,
  targeting, browser handoff, cleanup, JSON automation, and keying. The Dream
  column is intentionally aspirational and only shows the delta from the current
  flow; promote implemented deltas above the fold. After the `dor list` filters
  and positional action targets, the remaining deltas are browser open target
  resolution and any future story that cannot be expressed cleanly as `dor list`
  discovery followed by a handle-taking command.

  | Story | Current commands | Dream commands | Needed features |
  | --- | --- | --- | --- |
  | Sharing a dev server | User already has a worktree terminal running `npm dev`. Agent runs `dor ensure -- npm dev`; if the same command is live in the same resolved cwd, Dormouse returns the existing `surface:N`. Restart is `dor ensure --restart -- npm dev`, preserving layout and minimized/visible state. To open a browser today, `dor list --command "npm dev" --cwd . --ports --json` returns the matching Surface with ports, then the agent opens `dor ab open http://localhost:<port>`. | `dor ensure -- npm dev` followed by `dor ab open surface:N` or `dor iframe surface:N`; the browser command resolves the terminal Surface to the dev server URL. | Browser open target resolution (below). No surface-wide key needed; the point is seamless discovery of a user-started PTY command plus direct browser handoff. |
  | Launching a sub-agent | Claude runs `dor split -- codex`, captures the returned `surface:N`, then uses `dor send surface:N --sequence '[{"text":"/review"},{"key":"enter"}]'` or `dor send surface:N --text "/review" --key enter`, followed by `dor read surface:N`. | ✓ | None. `--sequence` remains the fully ordered form; `--text` plus `--key` covers the common "type this line and press enter" case and must appear in that order. |
  | Client/server browser testing | `dor ab --key client open <client-url>` and `dor ab --key server open <server-url>` create or reuse two browser sessions. The `--key` is agent-browser-specific and the passthrough also extracts it later in argv. | ✓ | None. |
  | Multi-worktree same command | Two worktrees can both run `dor ensure -- npm dev`; matching is disambiguated by resolved cwd, so the commands do not collapse. `dor list --command "npm dev" --cwd /path/to/worktree --json` discovers the intended one. A bare target such as `dor kill "npm dev"` is intentionally not supported. | ✓ | None. Keep filtered discovery in `dor list`; `read` / `send` / `kill` stay handle-taking commands. |
  | Long-running background job | `dor ensure --minimize -- npm test -- --watch` keeps a watcher out of the main layout. `dor list --command "npm test -- --watch" --cwd . --json` rediscovers the minimized watcher after layout churn, and `dor read surface:N`, `dor send surface:N ...`, or `dor kill surface:N ...` can target it. | ✓ | None. Surface-wide `--key watch` stays deferred unless refs plus filters fail this story. |
  | Port-owner handoff | Agent runs `dor list --port 5173 --json`, gets the owning terminal Surface directly, then opens or reuses a browser surface for that port with `dor ab --key client open http://localhost:5173`. Browser Surfaces never match `--port`; a browser can view a dev server, but it does not own the listening socket. | ✓ | None. |
  | Safe cleanup | Automation uses `dor list --command "npm dev" --cwd . --json` followed by `dor kill <ref> --confirm-if-read text`. The ref must come from recent `dor list --json` or a command response; `title:<exact>` exists but can drift or be ambiguous. | ✓ | None. Avoid duplicating list filters onto `read` / `send` / `kill`; the two-step composition is the intended automation shape. |

- **Browser open target resolution** — `dor ab open <target>` and `dor iframe
  <target>` accept an explicit terminal Surface handle (`surface:N`,
  `surface:<stable-id>`, `surface:self`, or `surface:focused`) wherever they
  currently accept an absolute URL. Resolution calls the same host port scan as
  `dor list --ports`.
  V1 groups listening records by port, so one dev server bound on `localhost`, a
  LAN address, and an overlay-network address is still one candidate; Dormouse
  opens `http://localhost:<port>/`. Zero candidate ports fail clearly. Multiple
  distinct candidate ports fail and list choices until an explicit port selector
  exists. Future tether address selection can choose a non-localhost address from
  the same candidate set without changing the surface-target grammar.

- **Additional `dor list` filters** — activity/state filters are deliberately
  deferred: `--running` as shorthand for `--activity running`, full `--activity
  unknown|prompt|editing|running|finished`, and possible alert filters such as
  `--alert` / `--todo`. Add only once a story needs them, and ship each with
  snapshot-tested help.
- **`dor list` workspace scope** — today `dor list` shows only the active
  Workspace and the noun stays "Surface" (no workspace rows). When workspaces
  land, add `--all` (widen the surface scope to every Workspace, grouped by a
  Workspace header), `--workspace <ref>` (narrow to one), and `--workspaces` (the
  cheap overview: one row per Workspace with its `active` flag and union status —
  ringing / todo / count from `docs/specs/glossary.md`). `dor list` owns all
  read/enumeration; the `dor workspace` command below owns mutation only, so the
  overview is never duplicated. Host asymmetry constrains `--all`: standalone can
  reach unmounted Workspaces (their stores survive unmount, layouts are
  persisted, and `getOpenPorts` is PTY-keyed so it still works), but VS Code puts
  each Workspace in a separate webview, so cross-Workspace listing must aggregate
  at the extension host, not the per-webview control handler. Staged with the
  workspaces rollout (`docs/specs/layout.md` `## Future`, workspaces-rollout).
  The same scope owns cross-Workspace action targeting by stable Surface id:
  today the per-webview control handler can only resolve ids in the mounted
  Workspace, even though the ids themselves are globally unique.
- **Workspace handles and commands** — a `--workspace` target flag and `dor
  workspace` management commands (new / rename / close / switch — mutation only)
  consuming the reserved `workspace:<n|name>` / `window:<n>` ref grammar in the
  handle model above. Like every other command they ship with their
  snapshot-tested help and the control methods that back them, not ahead of
  them. Staged with the workspaces rollout (`docs/specs/layout.md` `## Future`,
  workspaces-rollout).
- **Workspace-aware `surface.list`** — tags each surface with its real
  `workspace:<n>` / `window:<n>` membership instead of reporting the single
  active Workspace.
