# Dor CLI

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane
> vocabulary. A Surface is `dor`'s user-facing handle; Pane stays layout
> vocabulary, out of the public target grammar.
>
> Owns the CLI Dormouse bundles into every terminal it launches, end to end:
> staging, the PTY env contract, external-binary spawning, control plumbing,
> handles, the shipped command set, and the bundled agent skill. **The CLI is
> the public API; any socket under it is private host plumbing.**
>
> Defers to `docs/specs/dor-browser.md` for what a browser Surface renders and
> to `docs/specs/alert.md` for `dor await`'s wake conditions. Evidence:
> [dor-cli.rationale.md](dor-cli.rationale.md).

## Bundling And PATH

**`dor` must work without `npm i -g`.** Both hosts stage the workspace `dor`
package (`scripts/stage-dor-cli.mjs`) before build and prepend the staged `bin`
directory to every spawned PTY's `PATH`. Staged: `bin/dor` + `bin/dor.cmd`,
`dist/dor.js` (the esbuild bundle), and a generated `package.json` declaring
`"type": "module"` so Node runs the staged ESM without parent package metadata.

**Both launchers must set `ELECTRON_RUN_AS_NODE=1` themselves** before
`exec "$DORMOUSE_NODE" "$DORMOUSE_CLI_JS"`, or under VS Code `dor` silently
does nothing and **exits 0** (rationale). **Dormouse-launched terminals must
rely on injected env, never on a globally installed Node**; each launcher's
`PATH`-`node` fallback is for developer/manual use.

Public PTY env:

- `DORMOUSE_NODE` — Node runtime the launcher execs; `process.execPath` under VS
  Code. **On Windows the standalone host must point this at a console-subsystem
  node**, never its GUI-subsystem bundled node, which drops all stdout/stderr
  under a shell's ConPTY (rationale; `docs/specs/standalone.md`, Windows node
  subsystem).
- `DORMOUSE_CLI_JS` — absolute path to staged `dist/dor.js`.
- `DORMOUSE_SURFACE_ID` — stable invoking Session/surface id.
- `DORMOUSE_HOST` — hosting app kind: `vscode` or `standalone`.
- `DORMOUSE_HOST_WORKSPACE` — VS Code only: the loaded on-disk `.code-workspace`
  file, else the first workspace folder (an untitled workspace has no file and
  falls through). Unset under standalone and for an empty VS Code window.
- `DORMOUSE_CONTROL_SOCKET` and `DORMOUSE_CONTROL_TOKEN` — private control
  endpoint credentials, **set together or not at all** ([Control-channel
  security](#control-channel-security)). The token is the shared secret both
  ends prove knowledge of, so it **must** be a CSPRNG value (24 random bytes,
  hex — `randomBytes` in the VS Code host, `getrandom` in the standalone host)
  and never goes on the wire.

The CLI also reads `DORMOUSE_AGENT_BROWSER_BIN`, the user's own binary override
that no host sets (`docs/specs/dor-browser.md`).

**`DORMOUSE_CLI_BIN` is host-internal spawn configuration, never
terminal-facing:** `pty-core` prepends its *value* to the child's `PATH`, then
deletes the variable (with `DORMOUSE_SHELL_INTEGRATION_DIR`) from the child env,
so a terminal sees `dor` on `PATH` and nothing else.

**On Windows, `DORMOUSE_CLI_BIN` and `DORMOUSE_CLI_JS` must be plain paths,
never `\\?\` verbatim paths** — cmd.exe cannot execute `dor.cmd` through one,
and Tauri's `resource_dir()` hands out a verbatim prefix (rationale).

**`dor.cmd` (and any `.cmd`/`.bat`) must be checked out with CRLF** — cmd.exe
misparses LF-only batch files (rationale), and staging copies bytes verbatim.
`.gitattributes` pins it (`*.cmd text eol=crlf`; the POSIX launcher `eol=lf`).

### Git Bash PATH survival

**On Windows the `PATH` prepend must survive Git Bash / MSYS login:** the PTY
core strips `ORIGINAL_PATH` from the child env on win32, so a login shell cannot
rebuild a pre-prepend `PATH` from it (rationale). No-op for cmd.exe /
PowerShell, which never read it.

**A caller cwd must leave the MSYS drive form before it goes on the wire.** Git
Bash exports `PWD` as a POSIX path (`/c/Users/…`) that win32 `path.resolve`
would mangle into `C:\c\Users\…` and match no Surface; `msysToWindowsCwd` folds
it back to a native path, backing `dor ensure --cwd` and `dor list --cwd`.

Source of truth: `dor/bin/dor`, `dor/bin/dor.cmd`, `scripts/stage-dor-cli.mjs`,
`withoutInheritedMsysOriginalPath` in `standalone/sidecar/pty-core.js`,
`msysToWindowsCwd` in `dor/src/commands/shared.ts`, `resolve_sidecar_path` in
`standalone/src-tauri/src/lib.rs`, `vscode-ext/src/pty-manager.ts`, and
`vscode-ext/src/pty-host.js`.

## Spawning External Binaries

**Every spawn of an external/user-installed binary must go through
`spawnAndCapture` from `dor-lib-common`, never raw `node:child_process`
`spawn`** — `dor ab` driving `agent-browser`, the agent-browser host running
tab/eval/screenshot commands, and anything added later. It is the only code
`dor` and the `lib` host share, and owns three concerns:

- **cross-spawn, not raw spawn** — Node's own `spawn` cannot reach a Windows
  `.cmd` PATH shim by either route (rationale); cross-spawn resolves through
  `PATH`/`PATHEXT`, routes `.cmd`/`.bat` through `cmd.exe` with correct argument
  escaping, and passes through untouched on POSIX. **Never forward an argument
  containing a literal `%VAR%`** — `cmd.exe` expands it through a `.cmd` shim,
  an unavoidable batch limitation; today's forwarded arguments carry none.
- **`windowsHide`.** Without it every `.cmd` shim flashes a focus-stealing
  console window, once per screenshot stream-frame pulse (rationale).
- **Resolve on `exit`, not `close`, with an exit-time snapshot** — the
  `agent-browser open` daemon leaves a `close`-only wait hanging forever on
  Windows (rationale). `spawnAndCapture` waits for `close` but falls back to
  `exit` after a short grace, snapshotting the output at `exit` so the daemon's
  later scribbles stay out.

**`spawnAndCapture` never throws:** a spawn-level failure resolves as
`{ ok: false, error }`.

**Must release captured stdout/stderr pipes when the result settles**, including
the exit-grace fallback, without terminating descendants (rationale).
`dor-lib-common/test/spawn.test.mjs` pins caller exit with an inherited-pipe daemon
still alive.

**Resolution.** `dor-lib-common`'s `exports` point at its built `dist`
(Node-type-free `.d.ts`, since `dor`'s `tsc` avoids `@types/node`); every
esbuild/Vite consumer inlines it. **The `dor` and `dormouse-lib` prebuilds must
build `dor-lib-common` first**, or those `.d.ts` files are missing when either
typechecks.

Source of truth: `dor-lib-common/src/spawn.ts`, `dor-lib-common/package.json`,
`dor/package.json`, and `lib/package.json`.

## Host Plumbing

### Standalone

`standalone/package.json`'s `stage` step (before `build` and `tauri`, not bare
`vite` dev) runs `stage:dor-cli`. Rust resolves the staged/bundled CLI paths and
starts the Node sidecar with `DORMOUSE_HOST`, `DORMOUSE_NODE`,
`DORMOUSE_CLI_BIN`, `DORMOUSE_CLI_JS`, and `DORMOUSE_CONTROL_TOKEN`; the shared
PTY core then prepends `DORMOUSE_CLI_BIN` and sets `DORMOUSE_SURFACE_ID` per
PTY. **Rust must not set `DORMOUSE_CONTROL_SOCKET`:** the sidecar picks the path
itself and restores both control variables to its own `process.env` — what
`pty-core` merges into every spawned shell — only once the socket is bound,
holding stdin commands until then so no PTY spawns with the channel's fate
undecided.

Control direction: `dor` → sidecar JSON-lines net socket → Rust command/event
bridge → `TauriAdapter` `CustomEvent("dormouse:control-request")` → Wall
handler, and back along the same hops.

### VS Code

`vscode-ext/package.json` runs `pnpm stage:dor-cli` before bundling the
extension host and `pty-host.js`. The extension host computes staged CLI paths
under `context.extensionPath/dor-cli`, forks `pty-host.js`, and sends the same
dor env on each PTY spawn. **`getDorRuntimeEnv` must omit both control
variables:** the token reaches `pty-host.js` through the fork env alone, and the
host folds it with a bound socket path onto each spawn's env itself. The `ready`
message that releases the extension host's queued messages is held until the
channel settles, so no spawn can race the bind.

Control direction: `dor` → pty-host JSON-lines net socket → extension-host
child-process IPC → `message-router` → `VSCodeAdapter`
`CustomEvent("dormouse:control-request")` → Wall handler, and back.

Because one extension host can hold multiple Dormouse webviews, the request
carries `DORMOUSE_SURFACE_ID` and `message-router.ts` routes it to the webview
that owns that surface. **A named surface no active webview owns must fail**
(`No Dormouse webview owns surface '<id>'`) rather than fall back to a sibling;
a request with no surface id goes to the first active router.

### Control-channel security

The control channel carries the whole surface API — keystrokes into any pane,
its screen and scrollback back out, `dor kill` — so the threat is another local
principal getting between `dor` and its host (rationale). Three defences, in the
control server both hosts load:

**The server picks the path, and picks it unguessably.** POSIX:
`<tmpdir>/dormouse-dor-<uid>/<8 random bytes>.sock`, the parent directory
created `0700` and checked before every bind — a real directory, not a symlink,
owned by this uid, at exactly mode `0700`. One of ours that is merely loose gets
tightened; anything else **stands the channel down** (the same predicate as
`peerDirIsSafe()`). 8 random bytes rather than 16, so the POSIX path clears
macOS's `sun_path` cap (rationale). Windows: `\\.\pipe\dormouse-dor-<8 random
bytes>` — its machine-wide namespace has no directory to harden, leaving only
unpredictability. **Neither spelling may derive from the PID**, which is
enumerable and recycled.

**The server proves itself first, and the token — a bearer credential — never
goes on the wire in either direction.** The server speaks first with a challenge
nonce; the client answers `HMAC-SHA256(token, "dor-control/client <nonce>")` and
a nonce of its own; the server answers `HMAC-SHA256(token, "dor-control/server
<nonce>")` before the client sends any request (rationale). **A peer that fails
its half is hung up on with no reply** (rationale); a connection that says
nothing at all is dropped after 10s. **Both sides must compare proofs in
constant time** (SHA-256 digests through `timingSafeEqual`), never a
short-circuiting string compare. The two proof domains are mirrored between
client and server, pinned by `lib/src/lib/mirrored-constants.test.ts`.

**A lost bind is fatal to the channel, never to the host.** Neither host exits,
but **the token stops at the process that owns the server** (rationale):
`pty-host.js` and the sidecar delete both control variables from their own
environment on startup and re-attach them to spawned shells only once `ready`
resolves, each as above. When the bind is lost — a squatted Windows pipe name,
an unsafe socket directory, an uncleanable socket file — the variables stay
gone. **Both hosts hold their spawn path until `ready` settles** (2s ceiling) so
the first terminal cannot race the bind.

### Deadlines And Cancellation

Each request carries the client's own `timeoutMs` on the wire; the control
server treats it as a hint and sets a timer at the client's deadline plus 10s.
**Every valid request must preserve `host ceiling < client socket < server
reaper`,** so a server timeout can never turn the host's normal timeout result
into a transport error. `dor await` accepts a host ceiling of at most 24h, its
socket deadline is 5s later, and the maximum server deadline is therefore 24h +
15s. Absent or nonsense hints (non-finite, ≤ 0, or above 24h + 5s) fall back to
the server default of 65s, which clears the longest fixed client deadline (`dor
ensure --restart` at 60s).

**Some requests outlive their client.** When a socket closes with entries still
pending, or the server's own timer fires, the server drops the entry and emits
`dor:controlCancel { requestId }` — the cancellation counterpart of
`dor:controlRequest` / `dor:controlResponse`. Standalone carries it over the
request's own sidecar → Rust → adapter hop, which requires that **`dor-*`
request ids never collide with Rust's own `req-*` invoke ids**, so the
forwarder's pending-invoke lookup misses and the event reaches the webview; VS
Code carries it over child-process IPC to `ptyManager.onDorControlCancel`,
broadcast to every active router since only the webview holding that id has
anything to abort. Each adapter keeps one `requestId → AbortController` map: the
handler receives that controller's `signal`, a cancel aborts it, responding
forgets it. **A handler that parks must release whatever it armed when the
signal fires** — nothing it responds with afterwards can reach the client. A
late response for a reaped id is a silent no-op on the server.

Source of truth: `standalone/sidecar/dor-control-server.js`,
`dor/src/control-client.ts`, `dor/src/protocol.ts`, `peerDirIsSafe` in
`vscode-ext/src/peer-link.ts`, `lib/src/lib/platform/dor-control-dispatch.ts`,
and each host's hop in `standalone/src/tauri-adapter.ts`,
`standalone/src/browser-sidecar-adapter.ts`,
`lib/src/lib/platform/vscode-adapter.ts`, `vscode-ext/src/pty-manager.ts`, and
`vscode-ext/src/message-router.ts`.

## Handle Model

`Window ⊃ Workspace ⊃ Pane ⊃ Surface` (`docs/specs/glossary.md`). **User-facing
`dor` commands expose Surface handles only**, and because a Window can hold
several Workspaces the handle model reserves `workspace:<n|name>` and
`window:<n>` refs.

Invariants:

- A target may be `surface:N`, a stable Surface id, or `surface:<stable-id>`.
  `surface:focused` selects the focused Surface in the current Workspace;
  `surface:self` the invoking Surface from `DORMOUSE_SURFACE_ID`. An omitted
  target falls back to the caller, then to the focused Surface.
- Short refs (`surface:1`, `surface:2`, …) are Workspace-scoped stable refs, not
  layout/list positions: each Workspace starts at `surface:1` and assigns the
  next number when a Surface is created/restored. The map and its counter
  persist in the session snapshot, which is what keeps a retired number from
  being reused (`docs/specs/transport.md` → "Persisted session types"). **Only
  creation assigns a ref** — layout churn (reorder,
  minimize/reattach, zoom, focus), replacing an untouched terminal with a
  browser Surface, and browser render-mode swaps all leave it unchanged.
  **Killing a Surface retires its ref; a later target that names it must fail
  rather than silently retarget.**
- Surface targets also accept `title:<exact display title>`, for human recovery;
  a title can drift, so automation should prefer refs from command responses or
  `dor list`. Action commands (`read`, `send`, `await`, `kill`, `dor ab
  --surface`) resolve against listed Surfaces, **minimized ones included** — a
  minimized Surface is still a live target, and a parked agent-browser surface
  still holds its daemon session. `split` and `ensure --surface` resolve their
  *reference* target the same way so minimized peers participate in ambiguity
  checks; when that reference is minimized, the new terminal is created
  minimized too and its Door inserted immediately right of the reference Door.
  Browser placement commands (`iframe`, browser creation) resolve against
  visible Surfaces. **If multiple Surfaces in the relevant scope match, the
  command fails and lists the matching refs.**
- **Bare numeric targets and `pane:N` are not Surface handles.** Pane refs stay
  reserved for future layout-only commands.
- Text list output defaults to refs; commands that list handles accept
  `--id-format refs|ids|both` (`uuids` is a compatibility alias for `ids`). JSON
  list output always includes both refs and stable ids.
- Reserved: `workspace:<n>` (and `workspace:<name>` when exactly one Workspace
  matches) and `window:<n>` select a container. The grammar is reserved now so
  Surface refs never collide with it; the flag and the commands consuming it are
  staged — see [Future](#future). The webview handler already rejects any
  workspace/window target other than the singleton `workspace:1` / `window:1`.
  Stable Surface ids are globally unique, but cross-Workspace id routing is
  staged with Workspace-aware listing/targeting; today's handler resolves ids in
  the mounted Workspace.

Source of truth: `dor/src/commands/shared.ts`, `dor/src/commands/types.ts`, and
the ref registry in `lib/src/components/wall/use-dor-control.ts`.

## Current Implemented Commands

Implemented commands call private `surface.*` control methods, **enumerated once
in `dor/src/protocol.ts` (`SURFACE_CONTROL_METHODS`)** so the emitting client
and the dispatching webview cannot drift. `surface.list` joins the current
Workspace's Surfaces — visible panes **plus minimized (doored)** ones, each
tagged `view` (`paned` / `zoomed` / `minimized`) — with terminal state and
activity snapshots, and reports the single active Workspace as `workspace:1` /
`window:1` (Workspace-aware tagging is staged; see [Future](#future)). Per the
visible-vs-listed split [Handle Model](#handle-model) states, **a visible split
reference adds a pane in Lath, a minimized one a sibling Door in the
baseboard.** **`dor list` rows sort by the Workspace-stable `surface:N` ref**, a
registry `Wall` owns and persists with the session, independent of Lath layout
order.

**Port enumeration is opt-in.** With `includePorts` set (`dor list --ports` /
`--port`) the host calls `PlatformAdapter.getOpenPorts(id)`
(`docs/specs/dor-browser.md` → Dev-Server Chip) per terminal Surface in
parallel, shelling out per pane (`lsof` / `Get-NetTCPConnection`) under
`OPEN_PORT_TIMEOUT_MS`. A remote paired session reports none, and any error
degrades to an empty list rather than failing the call.

**`dor` forwards command tails as raw argv; the host quotes them** — `dor`
cannot know which shell the target surface runs, so tails after `--` travel as
`command: string[]` and the host renders **one** command string, used for
output, JSON responses, default `ensure` titles, and the launched command alike.
It picks the style (`cmd` / `posix` / `powershell`) with the same classifier
clipboard/drop path escaping uses
([mouse-and-clipboard.md](mouse-and-clipboard.md) §8.6).

**Every first-party command except the `dor agent-browser` / `dor ab`
passthrough accepts `--json`**, emitting a stable object with the same handles
as its text output; single-Surface responses always carry both `surface_id`
(stable) and `surface_ref` (Workspace-stable short ref). Text output carries the
same refs and is the primary interface, for agents as much as humans. Any JSON
mode under `dor ab` belongs to the delegated `agent-browser`.

**A command that operates on one existing Surface takes the target as a required
positional handle** (`read` / `send` / `await` / `kill`); **a command that
creates or places a Surface keeps `--surface` as an optional *reference*
Surface** (`split`, `ensure`, `iframe`, browser creation). So `--surface` means
"place near this" everywhere except [`dor
ab`](#agent-browser-surface-addressing), whose whole positional space belongs to
`agent-browser`, leaving `--surface` its only room for a real target.

The generated help snapshots own command names, syntax, flags, and defaults.
Where `stricli` cannot express a shape, a command may declare narrow,
snapshot-tested `findReplace` / `remove` help patches (`root` / `command-usage`
/ `command-detail` scope, `HELP_PATTERN_TOKENS` syntax) — not a general docs
renderer. **stricli's default `--help-all`/`-H` integration must stay
unregistered**: it bypasses those patches and prints raw usage lines
contradicting what the commands accept, leaving `--help`/`-h` the single
documented help surface. `dor --version`/`-v` (sole argument only) is rewritten
to `dor version`, and `ab` to `agent-browser`, before parsing.

The spec keeps the behavior help cannot express:

| Command | Behavioral contract |
|---|---|
| `split` | **Only a bare split focuses the new Surface.** A `--` marker or command tail leaves the caller focused; pre-parse preserves the marker stricli discards. |
| `ensure` | **Must have a `--` command tail.** Matching uses the exact OSC 633 command plus resolved CWD; `cmd.exe` without integration fails immediately, other unintegrated shells time out after 8s and lose their throwaway split. `--restart` drives the live PTY in place, preserving layout and minimized/visible state, so it works on Doors too. |
| `send` | **Must select exactly one input mode.** Text then key is the only mixed order; duplicate flags require the explicit sequence form. |
| `read` | Clean, ANSI-free rendered lines; line limits count rendered lines. |
| `await` | **Must name `--until quiet\|exit`; never infer it.** Timeout 1–86400 whole seconds, default 600; `alert.md` owns wake semantics. |
| `kill` | **Must select exactly one confirmation mode.** Conditional text needs four non-whitespace characters and must match `read`; browser Surfaces are killable. |
| `iframe`, `agent-browser` / `ab` | `dor-browser.md` owns the renderers; see [target resolution](#browser-open-target-resolution) and [addressing](#agent-browser-surface-addressing). The passthrough is intercepted before stricli parses it. |
| `list` | Filters are ANDed client-side; `--port` filters terminals (browser Surfaces never match) and implies the opt-in detail scan, `--ports` only requests it. |
| `skill` | Prints the bundled skill or installs its bootstrap stub; [Agent Skill](#agent-skill) owns the contract. |

**`await` never prints terminal text.** Stdout is only the resolution cause, the
narrative goes to stderr on every outcome, and JSON appears only on a resolution
(rationale). Exit codes: 0 resolution, 1 usage/target error, 2 timeout, 3
Surface death; other commands use only 0/1.

`list --json` includes stable ids and refs, capability booleans, caller/focus
identity, singleton Workspace/Window refs, and Host identity/runtime paths — but
**never the control socket**. **Consumers must gate on `has_terminal` /
`has_browser`, not `kind`**, the vocabulary commands also use in target errors.
Activity/state filters and Workspace scope are staged (see [Future](#future)).

Source of truth: `dor/src/commands/`, `HELP_PATTERN_TOKENS` and pre-parsing in
`dor/src/cli.ts`, `shellCommandKind` / `buildShellCommandForKind` in
`dor/src/commands/shell-quote.ts`, `buildDorSurfaces` / `buildDorSurfaceList` in
`lib/src/components/Wall.tsx`, `dorCommandString` and host dispatch in
`lib/src/components/wall/use-dor-control.ts`; help snapshots in
`dor/test/snapshots/help/`, pinned exhaustive by `dor/test/cli-help.test.mjs`.

## Browser Open Target Resolution

`dor ab open <target>` and `dor iframe <target>` accept, wherever they take an
absolute URL:

- a terminal **Surface handle** ([Handle Model](#handle-model)) — resolved to
  the dev server that terminal owns; and
- a schemeless **`host:port`** — defaulted to `http://` (`box.ts.net:3000` →
  `http://box.ts.net:3000/`), including the bare **`:port`** localhost shorthand
  (`:5173` → `http://localhost:5173/`). Purely a string rewrite, so it needs no
  host and works outside Dormouse.

**The explicit port, never the hostname, is the signal for the `http` default**
(rationale). An explicit scheme is always honored — a public HTTPS service on a
nonstandard port is the one case needing the scheme typed. This overrides
`agent-browser`'s own `https`-default for a bare `host:port`, since a local dev
server on https just SSL-errors. **Reject** an input that is neither a URL nor a
`host:port`, including a purely numeric "host" like `800:600` (rationale).

**Resolution is CLI-side**, so `dor ab` hands `agent-browser` a real URL rather
than a handle a binary would resolve differently. Only the `open` / `goto` /
`navigate` verbs resolve, matching the target by **shape, not position** since
`dor` can't know agent-browser's flag arity (`open --headed surface:3`
resolves); **only the first special-shaped argument is rewritten**, these verbs
taking a single target. A Surface handle requires a live control endpoint
(failing clearly outside Dormouse); the `host:port` inference does not.

A Surface handle resolves through the `surface.resolveOpen` control method,
which runs the same host port scan as `dor list --ports` (visible panes **and**
minimized doors). V1 groups all TCP listening records by distinct port, so
multiple bindings for one dev server remain one candidate:

| Candidates | Outcome |
| --- | --- |
| zero | fails — `surface:N is not serving any port` |
| one | `http://localhost:<port>/` when a loopback or any-interface bind exists, otherwise the specific bound LAN/Tailnet address |
| multiple distinct ports | fails and lists the choices, until an explicit port selector exists |

Only terminal Surfaces own ports, so a browser-Surface handle is rejected.

Source of truth: `dor/src/commands/open-target.ts`,
`dor/src/commands/iframe.ts`, `dor/src/commands/agent-browser.ts`, `resolveOpen`
in `dor/src/protocol.ts`, the `surface.resolveOpen` handler in
`lib/src/components/wall/use-dor-control.ts`, `listenerUrlsByPort` in
`lib/src/components/wall/port-url.ts`.

## Agent-Browser Surface Addressing

`dor ab --surface <handle> <verb...>` drives the browser Surface a handle names
rather than a session the caller must already know — the same handle addressing
terminal verbs use (`dor read surface:3`).

**`--surface` is a third mutually exclusive identity flag beside `--key` and
`--session`** — naming a browser twice is a mistake, never a precedence
question, so any two of the three fail (`--key and --surface are mutually
exclusive`). It changes *addressing* only: every other argument is still
forwarded verbatim, and the host-side subcommand allowlist is untouched. **A
managed `--key` must match `[A-Za-z0-9._-]+`**, because it becomes part of a
session name that becomes a filesystem path.

**Resolution is host-side**, mirroring `surface.resolveOpen`: the CLI sends the
handle to `surface.resolveAgentBrowser` and forwards the session it gets back.
The handle resolves against **listed** Surfaces ([Handle Model](#handle-model)),
and the host applies two gates in order:

- **Browser-gated** (`docs/specs/glossary.md` → Panes and Surfaces). A target
  with no browser fails with the shared capability wording under [`dor
  list`](#current-implemented-commands).
- **Render-mode-gated.** Past that gate, a browser Surface on the `iframe`
  renderer is a browser with nothing to drive: `surface 'surface:2' is not
  agent-browser rendered (render_mode: iframe)`.

Neither gate covers an agent-browser Surface the context menu created eagerly,
whose daemon boot has not yet named it ([dor-browser.md](dor-browser.md) → Pane
Context Menu Connect): capability and renderer but no session, failing with
`surface 'surface:2' has no agent-browser session yet`.

Because the session comes from the surface rather than a key, **`--surface` is
the only way to drive a GUI-spawned `dormouse.1.gui-<hex>` session**, which no
`--key` can name ([dor-browser.md](dor-browser.md) → Managed identity). Like
every handle target, it requires a live control endpoint.

Source of truth: `extractSessionFlags` / `resolveSession` in
`dor/src/commands/agent-browser.ts`, `resolveAgentBrowser` in
`dor/src/protocol.ts`, `ResolveAgentBrowserSessionRequest` / `Response` in
`dor/src/commands/types.ts`, `requireBrowserSurface` and the
`surface.resolveAgentBrowser` handler in
`lib/src/components/wall/use-dor-control.ts`, and
`agentBrowserSessionFromParams` in `lib/src/components/wall/browser-surface.ts`.

## Agent Workflows

These scenarios are the CLI's product-level acceptance tests: the commands must
*compose*, not merely work alone. All reduce to one shape — **discover the
target Surface with `dor list` (filtered), then act on it with a handle-taking
command.** So matching lives in `dor list` alone; `read` / `send` / `await` /
`kill` **must not grow their own match syntax**, and a bare `dor kill "npm dev"`
stays unsupported.

**Identity follows the Surface, not a user-supplied key:** a terminal Surface is
named by its Workspace-stable `surface:N` ref, or rediscovered after layout
churn by `--command` / `--cwd` / `--port`, and `dor ensure`'s command+cwd match
is an implicit key that also lets an agent adopt a command the user started by
hand. Only browser Surfaces carry an explicit join key (`dor ab --key <name>`),
because their session is held externally by `agent-browser`.

| Workflow | How the shipped CLI does it |
| --- | --- |
| Share a dev server | `dor ensure -- npm dev` reuses a command already live in the same resolved cwd; `dor ab open surface:N` / `dor iframe surface:N` then resolves that terminal's port in one step. Two-step form: `dor list --command "npm dev" --cwd . --ports`, then `dor ab open http://localhost:<port>`. |
| Launch a sub-agent | `dor split -- codex` returns `surface:N`, then `dor send surface:N …` and `dor read surface:N`. |
| Wait on a sub-agent | `dor await surface:5 --until quiet && dor read surface:5`, instead of a `dor list` polling loop. |
| Client / server browser testing | `dor ab --key client open <url>` and `--key server` create or reuse two independent browser Surfaces. |
| Multi-worktree, same command | Two worktrees each run `dor ensure -- npm dev`; the resolved cwd keeps them distinct for `dor list --command "npm dev" --cwd <worktree>`. |
| Long-running background job | `dor ensure --minimize -- npm test -- --watch` keeps a watcher out of the layout, and `dor list --command …` rediscovers it after churn. |
| Port-owner handoff | `dor list --port 5173` returns the terminal owning the socket; `dor ab --key client open http://localhost:5173` binds the browser side. |
| Safe cleanup | `dor list --command "npm dev" --cwd .`, then `dor kill <ref> --confirm-if-read <text>` on a ref from that listing. |

## Agent Skill

`dor/skill.md` is the agent skill: instructions teaching a coding agent inside a
Dormouse terminal to drive it through `dor` — the Agent Workflows above, recast
as a targeting model plus recipes. Distribution splits into content and
bootstrap so each is exactly as stable as it needs to be:

- **Content ships with the CLI.** `scripts/generate-dor-skill.mjs` (prebuild,
  like the version metadata) inlines the markdown into the bundle as the
  gitignored `generated-skill.ts`, so `dor skill` prints text version-locked to
  the CLI that staged it and the staged package stays launchers + bundle. **The
  skill body must carry no environment detection:** if `dor skill` ran, `dor` is
  available — detection lives only in the stub.
- **Bootstrap is a loud stub that barely drifts.** `dor skill --install` writes
  a marker-delimited block (`<!-- dor-skill:begin` … `dor-skill:end -->`) into
  the project's agent instructions file, resolved against the invoking shell's
  PWD like `dor ensure --cwd`. Its core is the detection rule — *if
  `DORMOUSE_SURFACE_ID` is set, run `dor skill` and follow it; otherwise ignore
  this section* — plus two mandatory directives a pointer-only stub proved too
  soft to enforce (rationale): never background a long-running process (use `dor
  ensure`), never use a native browser tool (use `dor ab`). **Nothing else may
  join them**, and **`dor/skill.md` must lead with the same two** (rationale).
  The env guard keeps the block inert for collaborators who don't run Dormouse,
  and **committing it is the point** — one teammate's install covers every agent
  and every clone.
- **File selection.** An existing block in `AGENTS.md` or `CLAUDE.md` (checked
  in that order) is rewritten in place; everything outside the markers is
  untouched, so re-running is idempotent. Otherwise: append to `AGENTS.md` when
  it exists; else to `CLAUDE.md` when it exists and does not already import
  `@AGENTS.md`; else create `AGENTS.md`. **A begin marker without a well-ordered
  end marker fails** (`malformed dor-skill block`) rather than guessing. Output
  reports the bare file name only (`created AGENTS.md` / `updated CLAUDE.md`),
  never an absolute path.

Source of truth: `dor/src/commands/skill.ts`, `scripts/generate-dor-skill.mjs`,
`dor/skill.md`, whose byte-identity with `dor skill` output is pinned by
`dor/test/cli-output.test.mjs`.

## Future

- **Surface a dead control channel in the UI.** A lost bind leaves one
  `[dor-control]` line on the host's stderr, and all a user sees is `dor`
  reporting "Dormouse control endpoint is not available in this terminal yet" —
  which reads like a startup race rather than a channel that will never come up.
  Open design question: where the visible notice goes, given that the Baseboard
  carrying the standalone update notice (`docs/specs/auto-update.md`) has no VS
  Code counterpart. The plumbing exists — both hosts already know the outcome at
  `ready` (see [Control-channel security](#control-channel-security)).

- **`dor skill` follow-ons** — skill-ecosystem publication (plugin marketplaces,
  npm) distributes the bootstrap stub, never a copy of the content. A user-level
  `--global` install variant waits until a story needs it.

- **Additional `dor list` filters** — activity/state filters are deliberately
  deferred: `--running` as shorthand for `--activity running`, full `--activity
  unknown|prompt|editing|running|finished`, and possible alert filters such as
  `--alert` / `--todo`. Add only once a story needs them, each with
  snapshot-tested help.
- **`dor list` workspace scope** — today `dor list` shows only the active
  Workspace, with no workspace rows. When workspaces land, add `--all` (every
  Workspace, grouped by a Workspace header), `--workspace <ref>` (narrow to
  one), and `--workspaces` (the cheap overview: one row per Workspace with its
  `active` flag and union status — ringing / todo / count from
  `docs/specs/glossary.md`). `dor list` owns all read/enumeration and `dor
  workspace` below owns mutation only, so the overview is never duplicated. Host
  asymmetry constrains `--all`: standalone can reach unmounted Workspaces
  (stores survive unmount, layouts are persisted, `getOpenPorts` is PTY-keyed),
  but VS Code puts each Workspace in a separate webview, so cross-Workspace
  listing must aggregate at the extension host, not the per-webview control
  handler. This scope also owns cross-Workspace action targeting by stable
  Surface id, which today's handler resolves only in the mounted Workspace.
  Staged with the workspaces rollout (`docs/specs/layout.md` `## Future`,
  workspaces-rollout).
- **Workspace handles and commands** — a `--workspace` target flag and `dor
  workspace` management commands (new / rename / close / switch — mutation only)
  consuming the reserved `workspace:<n|name>` / `window:<n>` ref grammar above.
  Like every command they ship with snapshot-tested help and the control methods
  that back them, not ahead of them. Staged with the workspaces rollout
  (`docs/specs/layout.md` `## Future`, workspaces-rollout).
- **Workspace-aware `surface.list`** — tags each surface with its real
  `workspace:<n>` / `window:<n>` membership instead of reporting the single
  active Workspace.
