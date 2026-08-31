# Dor CLI

> See `docs/specs/glossary.md` for canonical Surface / Session / Pane vocabulary.
> A **Surface** (the durable occupant of a Pane — a terminal Session or a browser
> surface) is `dor`'s user-facing CLI handle; Pane stays layout vocabulary and is
> not part of the public target grammar.
>
> Owns the CLI Dormouse bundles into every terminal it launches: staging + `PATH`,
> the PTY env contract, the `spawnAndCapture` rule for external binaries, host
> control-socket plumbing, the Surface handle model, the shipped command set, and
> the bundled agent skill. **The CLI is the public API; any socket under it is
> private host plumbing.**
>
> Defers to `docs/specs/dor-browser.md` for what a browser Surface renders and to
> `docs/specs/alert.md` for `dor await`'s wake conditions. Evidence and
> dead-approach history: [dor-cli.rationale.md](dor-cli.rationale.md).

## Bundling And PATH

**`dor` must work without `npm i -g`.** Both hosts stage the workspace `dor`
package (`scripts/stage-dor-cli.mjs`) before build and prepend the staged `bin`
directory to every spawned PTY's `PATH`. Staged contents: `bin/dor` +
`bin/dor.cmd` (tiny launchers), `dist/dor.js` (the esbuild bundle), and a
generated `package.json` declaring `"type": "module"` so Node runs the staged
ESM without depending on parent package metadata.

**Both launchers must set `ELECTRON_RUN_AS_NODE=1` themselves** before
`exec "$DORMOUSE_NODE" "$DORMOUSE_CLI_JS"`: under VS Code `DORMOUSE_NODE` is the
editor's Electron binary, which behaves as Node only with that variable, and
terminals routinely strip it from the ambient env. Without it Electron launches
its GUI, ignores the script, and **exits 0** — `dor` silently does nothing. The
`PATH`-`node` fallback in each launcher is for developer/manual use;
**Dormouse-launched terminals must rely on injected env, never on a globally
installed Node.**

Public PTY env:

- `DORMOUSE_NODE` — Node runtime the launcher execs. **On Windows the standalone
  host must point this at a console-subsystem node**: its bundled node is
  patched to the GUI subsystem (no stray terminal window when spawning the
  sidecar), and a GUI-subsystem node drops all stdout/stderr under a shell's
  ConPTY (`docs/specs/standalone.md`, Windows node subsystem). Under VS Code it
  is `process.execPath`, the editor's own runtime.
- `DORMOUSE_CLI_JS` — absolute path to staged `dist/dor.js`.
- `DORMOUSE_SURFACE_ID` — stable invoking Session/surface id.
- `DORMOUSE_HOST` — hosting app kind: `vscode` or `standalone`.
- `DORMOUSE_HOST_WORKSPACE` — VS Code only: what the owning window has open —
  the on-disk `.code-workspace` file when one is loaded (an untitled workspace
  has no file and falls through), else the first workspace folder. Unset under
  the standalone app (no workspace concept) and for an empty VS Code window.
- `DORMOUSE_CONTROL_SOCKET` and `DORMOUSE_CONTROL_TOKEN` — private control
  endpoint credentials, **set together or not at all** (see
  [Control-channel security](#control-channel-security)). The token is the
  shared secret both ends prove knowledge of, so it **must** be a CSPRNG value
  (24 random bytes, hex-encoded — `randomBytes` in the VS Code host, the OS
  CSPRNG via `getrandom` in the standalone host), and never goes on the wire.

The CLI also reads `DORMOUSE_AGENT_BROWSER_BIN` when present, but no host sets
it — it is the user's own binary override (`docs/specs/dor-browser.md`).

**`DORMOUSE_CLI_BIN` is host-internal spawn configuration, never terminal-facing:**
`pty-core` prepends its *value* to the child's `PATH`, then deletes the variable
itself (with `DORMOUSE_SHELL_INTEGRATION_DIR`) from the child env, so a terminal
sees `dor` on `PATH` and nothing else.

**On Windows, `DORMOUSE_CLI_BIN` and `DORMOUSE_CLI_JS` must be plain paths,
never `\\?\` verbatim paths** — cmd.exe cannot execute a batch file via a
verbatim path, and `dor.cmd` is reached through `DORMOUSE_CLI_BIN` on `PATH`
(rationale). Tauri's `resource_dir()` returns a verbatim prefix in the
bundled/dev layout; the standalone host strips it once at the boundary
(`resolve_sidecar_path`), so every derived path is plain.

**`dor.cmd` (and any `.cmd`/`.bat`) must be checked out with CRLF line
endings** — cmd.exe misparses LF-only batch files and drops the leading
character of every line (rationale). `.gitattributes` enforces it
(`*.cmd text eol=crlf`; the POSIX launcher is pinned `eol=lf`), and both hosts'
staging copies bytes verbatim (`scripts/stage-dor-cli.mjs`), so the checked-out
endings are what ship.

### Git Bash PATH survival

**On Windows the `PATH` prepend must survive Git Bash / MSYS login.**
`/etc/profile` rebuilds `PATH` from an exported `ORIGINAL_PATH` whenever that
variable is already set, and the inherited value predates our prepend, so the
PTY core strips `ORIGINAL_PATH` from the child env on win32
(`withoutInheritedMsysOriginalPath` in `standalone/sidecar/pty-core.js`),
forcing the shell to recapture the exact `PATH` we hand node-pty. No-op for
cmd.exe / PowerShell, which never read it.

**A caller cwd must leave the MSYS drive form before it goes on the wire.** Git
Bash exports `PWD` as a POSIX path (`/c/Users/…`) that win32 `path.resolve`
would mangle into `C:\c\Users\…` and match no Surface; `msysToWindowsCwd`
(`dor/src/commands/shared.ts`) folds it back to a native path, and backs both
`dor ensure --cwd` and `dor list --cwd`.

Source of truth: `dor/bin/dor`, `dor/bin/dor.cmd`,
`scripts/stage-dor-cli.mjs`, and host staging/env wiring in
`standalone/src-tauri/src/lib.rs`, `standalone/sidecar/pty-core.js`,
`vscode-ext/src/pty-manager.ts`, and `vscode-ext/src/pty-host.js`.

## Spawning External Binaries

**Every spawn of an external/user-installed binary must go through
`spawnAndCapture` from the `dor-lib-common` package, never raw
`node:child_process` `spawn`** — `dor ab` driving `agent-browser`, the
agent-browser host running tab/eval/screenshot commands, and anything added
later. It is the single home for the hard-won Windows recipe, shared by `dor`
and the `lib` host (which otherwise have no common code); both packages depend
on `dor-lib-common`. It owns three concerns:

- **cross-spawn, not raw spawn.** Two failures bite a naive spawn on Windows:
  Node's `spawn` does not consult `PATHEXT`, so a bare `agent-browser` ENOENTs
  instead of resolving the `agent-browser.cmd` PATH shim npm/vfox installs (on
  POSIX the file is a real executable with a shebang); and Node ≥22 refuses to
  spawn `.cmd`/`.bat` without a shell (the CVE-2024-27980 hardening), so
  spawning the resolved absolute `.cmd` EINVALs too. `cross-spawn` resolves via
  `PATH`/`PATHEXT`, routes `.cmd`/`.bat` through `cmd.exe` with correct argument
  escaping, and is a transparent passthrough on POSIX. **Never forward an
  argument containing a literal `%VAR%`** — `cmd.exe` expands it on the way
  through a `.cmd` shim, an unavoidable batch limitation. Today's forwarded
  arguments (URLs, selectors, the host's hardcoded `eval` scripts) carry none.
- **`windowsHide`.** cross-spawn runs `.cmd` shims through `cmd.exe`; without it
  each spawn flashes a focus-stealing console window — and the panel's
  screenshot loop spawns one per stream-frame pulse, so a live page would
  flicker windows several times a second.
- **Resolve on `exit`, not `close`, with an exit-time snapshot.** `agent-browser
  open` launches a long-lived per-session daemon that on Windows inherits the
  parent's stdout/stderr pipes; they never reach EOF while the daemon lives, so
  `close` never fires and a `close`-only wait hangs forever (rationale).
  `spawnAndCapture` waits for `close` but falls back to `exit` after a short
  grace, resolving that path with the output snapshotted at `exit` so the
  daemon's post-command scribbles stay out of the result.

`spawnAndCapture` never throws: a spawn-level failure resolves as
`{ ok: false, error }`.

**Resolution.** `dor-lib-common`'s package `exports` point at its built `dist`
(clean, Node-type-free `.d.ts` for `dor`'s `tsc`, which deliberately avoids
`@types/node`); every esbuild/Vite consumer (`dist/dor.js`, the sidecar `.cjs`,
vscode-ext) inlines it. **The `dor` and `dormouse-lib` prebuilds must build
`dor-lib-common` first** so its `.d.ts` files exist before either package
typechecks imports through those exports.

Source of truth: `dor-lib-common/src/spawn.ts`, `dor-lib-common/package.json`,
`dor/package.json`, and `lib/package.json`.

## Host Plumbing

### Standalone

`standalone/package.json`'s `stage` step (run before `build` and `tauri`, not
before bare `vite` dev) runs `stage:dor-cli`. Rust resolves the staged/bundled
CLI paths, starts the Node sidecar with `DORMOUSE_HOST`, `DORMOUSE_NODE`,
`DORMOUSE_CLI_BIN`, `DORMOUSE_CLI_JS`, and `DORMOUSE_CONTROL_TOKEN`, then the
shared PTY core prepends `DORMOUSE_CLI_BIN` and sets `DORMOUSE_SURFACE_ID` per
PTY. **Rust must not set `DORMOUSE_CONTROL_SOCKET`:** the sidecar chooses the
path itself and puts both control variables back into its own `process.env` —
what `pty-core` merges into every spawned shell — only once the socket is bound,
holding incoming stdin commands until then so no PTY can be spawned into the
window where the channel's fate is undecided.

Control direction: `dor` → sidecar JSON-lines net socket → Rust command/event
bridge → `TauriAdapter` `CustomEvent("dormouse:control-request")` → Wall handler,
and the response back along the same hops.

### VS Code

`vscode-ext/package.json` runs `pnpm stage:dor-cli` before bundling the
extension host and `pty-host.js`. The extension host computes the staged CLI
paths under `context.extensionPath/dor-cli`, starts `pty-host.js`, and sends the
same dor env on each PTY spawn. **`getDorRuntimeEnv` must omit both control
variables:** the token reaches `pty-host.js` through the fork env alone, and the
host pairs it with a bound socket path onto each spawn's env itself. The `ready`
message that releases the extension host's queued messages is held until the
channel has settled, so no spawn can race the bind.

Control direction: `dor` → pty-host JSON-lines net socket → extension-host
child-process IPC → `message-router` → `VSCodeAdapter`
`CustomEvent("dormouse:control-request")` → Wall handler, and back.

Because VS Code can host multiple Dormouse webviews in one extension host, the
request carries `DORMOUSE_SURFACE_ID` and `message-router.ts` routes it to the
webview that owns that surface. **A named surface no active webview owns must
fail** (`No Dormouse webview owns surface '<id>'`) rather than fall back to a
sibling; a request with no surface id goes to the first active router.

### Control-channel security

The control channel carries the whole surface API — `dor send` types arbitrary
keystrokes into any pane, `dor read` returns its screen and scrollback, `dor
kill` destroys it — so the threat is another local principal (a second account
on the box, or any process running as the user) getting between `dor` and its
host. All three defences live in
[`dor-control-server.js`](../../standalone/sidecar/dor-control-server.js), which
both hosts load, and its client half in
[`control-client.ts`](../../dor/src/control-client.ts).

**The server picks the path, and picks it unguessably.** POSIX:
`<tmpdir>/dormouse-dor-<uid>/<8 random bytes>.sock`, the parent directory
created `0700` and re-checked on every use — a real directory, not a symlink,
owned by this uid, at exactly mode `0700`. One of ours that is merely loose gets
tightened; anything else **stands the channel down** (the same predicate as
`peerDirIsSafe()` in [`peer-link.ts`](../../vscode-ext/src/peer-link.ts)). 8
random bytes rather than 16, because the POSIX path must clear macOS's
`sun_path` cap (rationale). Windows: `\\.\pipe\dormouse-dor-<8 random bytes>` —
the pipe namespace is machine-wide with no directory to harden, so
unpredictability is all that is left. **Neither spelling may derive from the
PID**, which is enumerable and recycled.

**The server proves itself first, and the token — a bearer credential — never
goes on the wire in either direction.** The server speaks first with a challenge
nonce; the client answers with `HMAC-SHA256(token, "dor-control/client
<nonce>")` and a nonce of its own; the server answers that with
`HMAC-SHA256(token, "dor-control/server <nonce>")` before the client sends any
request, so whoever merely bound the path learns two nonces and nothing else. A
peer that fails its half is hung up on **with no reply** (rationale); a
connection that says nothing at all is dropped after 10s. **Both sides must
compare proofs in constant time** (SHA-256 digests through `timingSafeEqual`),
never a short-circuiting string compare. The two proof domains are mirrored
between client and server, pinned by `lib/src/lib/mirrored-constants.test.ts`.

**A lost bind is fatal to the channel, never to the host.** PTY work must
survive a dead control channel, so neither host exits — but a host that kept
handing `DORMOUSE_CONTROL_TOKEN` to every shell would be feeding clients and
tokens to whoever won the race. **So the token stops at the process that owns
the server:** `pty-host.js` and the sidecar delete both control variables from
their own environment on startup (`pty-core` merges `process.env` into every
shell) and re-attach them to spawned shells only once `ready` resolves — the
sidecar by restoring them to its `process.env`, `pty-host.js` by folding them
onto each spawn's env. When the bind is lost — a squatted Windows pipe name, an
unsafe socket directory, a socket file that cannot be cleared — the variables
stay gone and `dor` reports the endpoint as unavailable rather than dialling a
stranger. Both hosts hold their spawn path until `ready` settles (2s ceiling) so
the first terminal cannot race the bind.

### Deadlines And Cancellation

Each request carries the client's own `timeoutMs` on the wire; the control
server treats it as a hint and sets a timer that deliberately outlasts it — the
client's deadline plus 10s. **Every valid request must preserve `host ceiling <
client socket < server reaper`,** so a server timeout can never turn the host's
normal timeout result into a transport error. `dor await` accepts a host ceiling
of at most 24h, its socket deadline is 5s later, and the maximum server deadline
is therefore 24h + 15s. Absent or nonsense hints (non-finite, ≤ 0, or above
24h + 5s) fall back to the server default of 65s, which clears the longest fixed
client deadline (`dor ensure --restart` at 60s).

**Some requests outlive their client.** When a socket closes with entries still
pending, or when the server's own timer fires, the server drops the entry and
emits `dor:controlCancel { requestId }` — the cancellation counterpart of
`dor:controlRequest` / `dor:controlResponse`. Standalone carries it over the
same sidecar → Rust → adapter hop as the request (`dor-*` request ids never
collide with Rust's own `req-*` invoke ids, so the forwarder's pending-invoke
lookup misses and the event is emitted to the webview); VS Code carries it over
child-process IPC to `ptyManager.onDorControlCancel`, which broadcasts it to
every active router since only the webview holding that id has anything to
abort. In the webview each adapter keeps one `requestId → AbortController` map:
the request's handler receives that controller's `signal`, a cancel aborts it,
and responding forgets it. **A handler that parks must release whatever it armed
when the signal fires** — nothing it responds with afterwards can reach the
client. A late response for a reaped id is a silent no-op on the server.

Source of truth: `standalone/sidecar/dor-control-server.js`,
`dor/src/control-client.ts`, `dor/src/protocol.ts`,
`lib/src/lib/platform/dor-control-dispatch.ts`, and each host's hop in
`standalone/src/tauri-adapter.ts`, `standalone/src/browser-sidecar-adapter.ts`,
`lib/src/lib/platform/vscode-adapter.ts`, `vscode-ext/src/pty-manager.ts`, and
`vscode-ext/src/message-router.ts`.

## Handle Model

`Window ⊃ Workspace ⊃ Pane ⊃ Surface` (`docs/specs/glossary.md`): a Surface is a
terminal Session or a browser surface — the `iframe` / agent-browser renderers
of `dor`'s unified `browser` surface (`docs/specs/dor-browser.md`).
**User-facing `dor` commands expose Surface handles only.** Because a Window can
hold several Workspaces
(standalone hosts them with one active; VS Code maps each webview to one), the
handle model reserves `workspace:<n|name>` and `window:<n>` refs.

Invariants:

- A target may be `surface:N`, a stable Surface id, or `surface:<stable-id>`.
  `surface:focused` selects the focused Surface in the current Workspace;
  `surface:self` selects the invoking Surface from `DORMOUSE_SURFACE_ID`. An
  omitted target falls back to the caller, then to the focused Surface.
- Short refs (`surface:1`, `surface:2`, …) are Workspace-scoped stable refs, not
  layout/list positions: each Workspace starts at `surface:1` and assigns the
  next number when a Surface is created/restored. The live id→ref map and a
  separate monotonic counter both persist in the session snapshot
  (`PersistedSession.surfaceRefs` / `surfaceRefsNext`); **the counter — not the
  max of the surviving map — is the source of truth for the next number**, so a
  killed Surface's entry drops from the map immediately without its number ever
  being reused. Reordering panes, minimizing, reattaching, zooming, focusing,
  replacing an untouched terminal with a browser Surface, and browser
  render-mode swaps do not change the ref. **Killing a Surface retires its ref;
  a later target that names it must fail rather than silently retarget.**
- Surface targets also accept `title:<exact display title>`, primarily for human
  recovery; automation should prefer refs from command responses or `dor list`.
  Action commands (`read`, `send`, `await`, `kill`, `dor ab --surface`) resolve
  against listed Surfaces, minimized ones included — a minimized Surface is
  still a live target, and a parked agent-browser surface still holds its daemon
  session. `split` and `ensure --surface` resolve their *reference* target the
  same way so minimized peers participate in ambiguity checks; when that
  reference is minimized, the new terminal is created minimized too and its Door
  is inserted immediately right of the reference Door. Browser placement
  commands (`iframe`, browser creation) resolve against visible Surfaces.
  **If multiple Surfaces in the relevant scope match, the command fails and
  lists the matching surface refs.**
- **Bare numeric targets and `pane:N` are not Surface handles.** Pane refs are
  reserved for future layout-only commands if those commands ever need them.
- Text list output defaults to refs; commands that list handles accept
  `--id-format refs|ids|both` (`uuids` is accepted as a compatibility alias for
  `ids`). JSON list output always includes both refs and stable ids.
- Reserved: `workspace:<n>` (and `workspace:<name>` when exactly one Workspace
  matches) and `window:<n>` select a container. The ref grammar is reserved now
  so Surface refs never collide with it; the flag and commands that consume it
  are staged — see [Future](#future). The webview handler already rejects any
  workspace/window target other than the singleton `workspace:1` / `window:1`.
  Stable Surface ids are globally unique, but cross-Workspace id routing is
  staged with Workspace-aware listing/targeting; the current webview control
  handler resolves ids in the mounted Workspace.

Source of truth: handle parsing in `dor/src/commands/shared.ts`, request and row
types in `dor/src/commands/types.ts`, and the ref registry/resolution in
`lib/src/components/wall/use-dor-control.ts`.

## Current Implemented Commands

Implemented commands call private `surface.*` control methods, **enumerated once
in `dor/src/protocol.ts` (`SURFACE_CONTROL_METHODS`)** so the emitting client and
the dispatching webview cannot drift. `surface.list` derives its response from
the current Workspace's Surfaces — the visible panes **plus minimized (doored)
Surfaces**, each tagged with its `view` (`paned` / `zoomed` / `minimized`) —
joined with terminal state and activity snapshots, and reports the single active
Workspace as `workspace:1` / `window:1` (Workspace-aware tagging is staged; see
[Future](#future)). Two host builders (`lib/src/components/Wall.tsx`) implement
the visible-vs-listed split the [Handle Model](#handle-model) states:
`buildDorSurfaces` is the visible-pane projection for commands that need
geometry, `buildDorSurfaceList` adds the minimized Surfaces. A visible split
reference adds a new pane in Lath; a minimized one adds a sibling Door in the
baseboard. `dor list` rows sort by the Workspace-stable `surface:N` ref, whose
registry `Wall` owns and persists with the session, independent of Lath layout
order.

`dor tool` runs a command as a Dor Tool — a Surface that grows a browser in
place once the command binds a port. It uses the `ensure` spawn path's
mechanics but **not** its command+cwd matching: a tool has an identity only if
a `dormouse.yml` entry gave it one. Source of truth: `dor/src/commands/tool.ts`,
help snapshot `dor/test/snapshots/help/tool.md`; behavior is owned by
`docs/specs/dor-tool.md`.

**Port enumeration is opt-in.** When the request sets `includePorts` (`dor list
--ports` / `--port`), the host calls `PlatformAdapter.getOpenPorts(id)`
(`docs/specs/dor-browser.md` → Dev-Server Chip) for each terminal Surface in
parallel, shelling out per pane (`lsof` / `Get-NetTCPConnection`) under
`OPEN_PORT_TIMEOUT_MS`. A remote paired session reports none, and any error
degrades to an empty list rather than failing the call.

**`dor` forwards command tails as raw argv; the host quotes them.** Tails
captured after `--` travel as `command: string[]`, because `dor` cannot know
which shell the target surface runs. The host
(`lib/src/components/wall/use-dor-control.ts`, `dorCommandString`) detects the
target shell, picks a quoting style with
[`shellCommandKind` / `buildShellCommandForKind`](../../dor/src/commands/shell-quote.ts)
(`cmd` / `posix` / `powershell`), and renders one command string used for
output, JSON responses, default `ensure` titles, and the launched command alike.
The same module classifies shells for clipboard/drop path escaping, which faces
the identical "which parser reads this line" question — see
[mouse-and-clipboard.md](mouse-and-clipboard.md) §8.6.

**Every first-party command except the `dor agent-browser` / `dor ab`
passthrough accepts `--json`** and emits a stable object with the same handles as
its text output; single-Surface responses always carry both `surface_id` (the
stable id) and `surface_ref` (the Workspace-stable short ref). Text output is the
primary interface for agents as well as humans and carries the same refs;
`--json` is for pipelines that consume output mechanically. `dor ab` forwards
arguments to the user's `agent-browser`, so any JSON mode there belongs to that
delegated command surface.

**A command that operates on one existing Surface takes the target as a required
positional handle** (`dor read` / `send` / `await` / `kill`); **a command that
creates or places a Surface keeps `--surface` as an optional *reference*
Surface** (`split`, `ensure`, `iframe`, browser creation). So `--surface` means
"place near this" everywhere except [`dor ab`](#agent-browser-surface-addressing),
where it is a real target ("act on this"): the whole positional space of that
command belongs to `agent-browser`, so its target has nowhere else to go.

User-facing command docs live in the generated help snapshots; implementation
details live in the command files. When `stricli` cannot express a desired help
shape, commands may declare narrow template-pattern `findReplace` / `remove`
help patches, scoped to `root` / `command-usage` / `command-detail`; the tokens
are `<LS>` (line start plus leading horizontal whitespace), `<WS>` (horizontal
whitespace), and `<TO-EOL>` (rest of line). Those patches are snapshot-tested
rather than treated as a general docs renderer, and **stricli's default
`--help-all`/`-H` integration must stay unregistered** because it bypasses them
and prints raw usage lines contradicting what the commands accept
(`dor/src/cli.ts`) — `--help`/`-h` is the single documented help surface. `dor
--version`/`-v` (sole argument only) is rewritten to `dor version`, and `ab` to
`agent-browser`, before parsing.

The snapshots own command names, syntax, flags, and defaults. The spec keeps the
behavior that help cannot express:

| Command | Behavioral contract |
|---|---|
| `split` | **Only a bare split focuses the new Surface.** A `--` marker or command tail leaves the caller focused; pre-parse preserves the marker that stricli discards. |
| `ensure` | **Must have a `--` command tail.** Matching uses the exact OSC 633 command plus resolved CWD; `cmd.exe` without integration fails immediately, other unintegrated shells time out after 8s and lose their throwaway split, and restart drives the live PTY so it also works on Doors. |
| `send` | **Must select exactly one input mode.** Text then key is the only mixed order; duplicate flags require the explicit sequence form. |
| `read` | Returns clean, ANSI-free rendered lines; line limits count rendered lines. |
| `await` | **Must name `--until quiet\|exit`; never infer it.** Timeout is 1–86400 whole seconds, default 600; `alert.md` owns wake semantics. |
| `kill` | **Must select exactly one confirmation mode.** Conditional text needs four non-whitespace characters and must match `read`; browser Surfaces are killable. |
| `iframe`, `agent-browser` / `ab` | `dor-browser.md` owns the renderers; [target resolution](#browser-open-target-resolution) and [agent-browser addressing](#agent-browser-surface-addressing) live below. The passthrough is intercepted before stricli parses it. |
| `list` | Lists every current-Workspace Surface, including Doors, in stable ref order. Filters are ANDed client-side; `--port` filters terminals (browser Surfaces never match) and implies the opt-in detail scan, while `--ports` only requests details. |
| `skill` | Prints the bundled skill or installs its bootstrap stub; [Agent Skill](#agent-skill) owns the contract. |

**`await` never prints terminal text.** Stdout is only the resolution cause;
the narrative goes to stderr on every outcome, and JSON appears only on a
resolution. Exit codes are 0 resolution, 1 usage/target error, 2 timeout, and 3
Surface death; other commands use only 0/1. Compose it with `dor read` when the
screen is needed. (rationale)

`list --json` includes stable ids and refs, capability booleans, caller/focus
identity, singleton Workspace/Window refs, and Host identity/runtime paths.
**Consumers must gate on `has_terminal` / `has_browser`, not `kind`.** Commands
use the same capability vocabulary in target errors. **Never expose the control
socket:** the CLI is public; the socket is private. Activity/state filters and
Workspace scope are staged (see [Future](#future)).

Source of truth: generated help in `dor/test/snapshots/help/`, exhaustiveness in
`dor/test/cli-help.test.mjs`, command behavior in `dor/src/commands/`, CLI
pre-parsing in `dor/src/cli.ts`, and host dispatch in
`lib/src/components/wall/use-dor-control.ts`.

## Browser Open Target Resolution

`dor ab open <target>` and `dor iframe <target>` accept, wherever they take an
absolute URL:

- a terminal **Surface handle** ([Handle Model](#handle-model)) — resolved to
  the dev server that terminal owns; and
- a schemeless **`host:port`** — defaulted to `http://` (`localhost:5173`,
  `box.ts.net:3000`, `192.168.1.5:8080` → `http://…/`), including the bare
  **`:port`** localhost shorthand (`:5173` → `http://localhost:5173/`). Purely a
  string rewrite, so it needs no host and works outside Dormouse.

**The explicit port, never the hostname, is the signal for the `http`
default** — a hostname cannot be classified public vs. private by inspection
(`box.ts.net` looks like any other domain), while a bare `host:port` is
overwhelmingly a dev/infra server (rationale). An explicit scheme is always
honored, and a public HTTPS service on a nonstandard port is the one case that
needs the scheme typed. This deliberately overrides `agent-browser`'s own
`https`-default for a bare `host:port`, since a local dev server on https just
SSL-errors. **Reject** an input that is neither a URL nor a `host:port`,
including a purely numeric "host" (`800:600`) that `new URL` would otherwise
pack into a bogus IPv4.

**Resolution is CLI-side** (`dor/src/commands/open-target.ts`), so `dor ab` can
hand `agent-browser` a real URL — a handle or bare `host:port` would otherwise
reach a binary that resolves it differently. For `dor ab`, only the `open` /
`goto` / `navigate` verbs resolve, and the target is matched by **shape, not
position** (`dor` can't know agent-browser's flag arity), so `open --headed
surface:3` resolves too; only the first special-shaped argument is rewritten,
since these verbs take a single target. A Surface handle requires a live control
endpoint (it fails clearly outside Dormouse); the `host:port` inference does not.

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

Source of truth: `dor/src/commands/open-target.ts` (classification + `:port`
sugar + `surface.resolveOpen` call), `dor/src/commands/iframe.ts` /
`dor/src/commands/agent-browser.ts` (the two entry points),
`dor/src/protocol.ts` (`resolveOpen`), the `surface.resolveOpen` handler in
`lib/src/components/wall/use-dor-control.ts`, and the port→URL grouping/selection
in `lib/src/components/wall/port-url.ts` (`listenerUrlsByPort`).

## Agent-Browser Surface Addressing

`dor ab --surface <handle> <verb...>` drives the browser Surface a handle names
rather than a session the caller must already know, closing the asymmetry
between terminal verbs, which are handle-addressed (`dor read surface:3`), and
browser verbs, which were keyed only by `--key` / `--session`.

**`--surface` is a third mutually exclusive identity flag beside `--key` and
`--session`** — naming a browser twice is always a mistake, never a precedence
question, so any two of the three fail (`--key and --surface are mutually
exclusive`). It changes *addressing* only: every other argument is still
forwarded verbatim, and the host-side subcommand allowlist is untouched. **A
managed `--key` must match `[A-Za-z0-9._-]+`**, because it becomes part of a
session name that becomes a filesystem path.

**Resolution is host-side**, mirroring `surface.resolveOpen`: the CLI sends the
handle to the `surface.resolveAgentBrowser` control method and forwards the
session it gets back. The handle resolves against **listed** Surfaces
([Handle Model](#handle-model)), and the host applies two gates in order:

- **Browser-gated** (`docs/specs/glossary.md` → Panes and Surfaces). A target
  with no browser fails with the shared capability wording documented under
  [`dor list`](#current-implemented-commands).
- **Render-mode-gated.** Past that gate, a browser Surface on the `iframe`
  renderer is a browser with nothing to drive: `surface 'surface:2' is not
  agent-browser rendered (render_mode: iframe)`.

Neither gate covers one further case: an agent-browser Surface the context menu
created eagerly, whose daemon boot has not yet named it
([dor-browser.md](dor-browser.md) → Pane Context Menu Connect). It has the
capability and the renderer but no session, and fails with `surface 'surface:2'
has no agent-browser session yet`.

Because the session comes from the surface rather than from a key, **`--surface`
is the only way to drive a GUI-spawned `dormouse.1.gui-<hex>` session**, which
no `--key` can name ([dor-browser.md](dor-browser.md) → Managed identity). Like
every handle target, it requires a live control endpoint and fails clearly
outside Dormouse.

Source of truth: `dor/src/commands/agent-browser.ts`
(`extractSessionFlags`, `resolveSession`), `dor/src/protocol.ts`
(`resolveAgentBrowser`), `dor/src/commands/types.ts`
(`ResolveAgentBrowserSessionRequest` / `Response`), and the
`surface.resolveAgentBrowser` handler in
`lib/src/components/wall/use-dor-control.ts` (`requireBrowserSurface`,
`agentBrowserSessionFromParams`).

## Agent Workflows

These end-to-end scenarios are the CLI's product-level acceptance tests: each
checks that the commands *compose* into a real automation, not just that they
work in isolation. They all reduce to one shape — **discover the target Surface
with `dor list` (filtered), then act on it with a handle-taking command.** So
matching lives in `dor list` alone; `read` / `send` / `kill` **must not grow
their own match syntax**, and a bare `dor kill "npm dev"` stays unsupported.

**Identity follows the Surface, not a user-supplied key:** a terminal Surface is
named by its Workspace-stable `surface:N` ref, or rediscovered after layout churn
by `--command` / `--cwd` / `--port`, and `dor ensure`'s command+cwd match is an
implicit key that also lets an agent adopt a command the user started by hand.
Only browser Surfaces carry an explicit join key (`dor ab --key <name>`), because
their session is held externally by `agent-browser`.

| Workflow | How the shipped CLI does it |
| --- | --- |
| Share a dev server | `dor ensure -- npm dev` reuses the command already live in the same resolved cwd (`--restart` re-runs it in place, preserving layout and minimized/visible state). `dor ab open surface:N` (or `dor iframe surface:N`) resolves the terminal's dev-server port and opens it in one step — see [Browser Open Target Resolution](#browser-open-target-resolution). The explicit two-step form still works: `dor list --command "npm dev" --cwd . --ports`, then `dor ab open http://localhost:<port>`. |
| Launch a sub-agent | `dor split -- codex` returns `surface:N`; drive it with `dor send surface:N --text "/review" --key enter` (or `--sequence` for arbitrary ordering), then read it back with `dor read surface:N`. |
| Wait on a sub-agent | `dor split -- otheragent` returns `surface:5`; `dor await surface:5 --until quiet && dor read surface:5` blocks until the peer settles, exits, or rings, then shows the result — no polling `dor list` in a loop. `--until exit` is the strict form for a build or test run that must not be mistaken for done on a mid-run bell. The wait absorbs the bell, so it does not also ring for a human watching the same Surface. |
| Client / server browser testing | `dor ab --key client open <client-url>` and `dor ab --key server open <server-url>` create or reuse two independent browser Surfaces. |
| Multi-worktree, same command | Two worktrees each run `dor ensure -- npm dev`; the resolved cwd keeps them distinct, and `dor list --command "npm dev" --cwd <worktree>` selects the intended one. |
| Long-running background job | `dor ensure --minimize -- npm test -- --watch` keeps a watcher out of the layout; `dor list --command "npm test -- --watch"` rediscovers the minimized Surface after churn, and `read` / `send` / `kill` target it by ref. |
| Port-owner handoff | `dor list --port 5173` returns the terminal that owns the socket (browser Surfaces never match `--port`), then `dor ab --key client open http://localhost:5173` binds the browser side. |
| Safe cleanup | `dor list --command "npm dev" --cwd .`, then `dor kill <ref> --confirm-if-read <text>`. The ref comes from a recent listing or command response; `title:<exact>` also targets one but can drift. |

## Agent Skill

`dor/skill.md` is the agent skill: instructions that teach a coding agent
running inside a Dormouse terminal to drive it through `dor` — the Agent
Workflows above, recast as a targeting model plus recipes. Distribution splits
into content and bootstrap so each is exactly as stable as it needs to be:

- **Content ships with the CLI.** `scripts/generate-dor-skill.mjs` (prebuild,
  like the version metadata) inlines the markdown into the bundle as the
  gitignored `generated-skill.ts`, so `dor skill` prints text version-locked to
  the CLI that staged it and the staged package stays launchers + bundle. **The
  skill body must carry no environment detection:** if `dor skill` ran, `dor` is
  by definition available — detection lives only in the stub.
- **Bootstrap is a loud stub that barely drifts.** `dor skill --install`
  writes a marker-delimited block (`<!-- dor-skill:begin` …
  `dor-skill:end -->`) into the project's agent instructions file, resolved
  against the invoking shell's PWD like `dor ensure --cwd`. Its core is the
  detection rule — *if `DORMOUSE_SURFACE_ID` is set, run `dor skill` and
  follow it; otherwise ignore this section* — plus two loud, mandatory
  directives a pointer-only stub proved too soft to enforce (rationale): never
  background a long-running process (use `dor ensure`), never use a native
  browser tool (use `dor ab`). **Nothing else may join them:** both are
  foundational command names, the least likely `dor` facts to drift, which is
  what keeps the stub stale-proof. The env guard keeps it inert for
  collaborators who don't run Dormouse, and **committing it is the point** — the
  stub travels with the repo, so one teammate installing it covers every agent
  and every clone. `dor/skill.md` leads with the same two rules so an agent that
  does run `dor skill` meets them again up front.
- **File selection.** An existing block in `AGENTS.md` or `CLAUDE.md`
  (checked in that order) is rewritten in place; everything outside the
  markers is untouched, so re-running is idempotent. Otherwise: append to
  `AGENTS.md` when it exists; else to `CLAUDE.md` when it exists and does not
  already import `@AGENTS.md`; else create `AGENTS.md`. **A begin marker
  without a well-ordered end marker fails** (`malformed dor-skill block`)
  rather than guessing. Output reports the bare file name only
  (`created AGENTS.md` / `updated CLAUDE.md`), never an absolute path.

Source of truth: `dor/src/commands/skill.ts`, `scripts/generate-dor-skill.mjs`,
`dor/skill.md`; `dor skill` output is asserted byte-identical to `dor/skill.md`
in `dor/test/cli-output.test.mjs`.

## Future

- **Surface a dead control channel in the UI.** A lost bind currently leaves one
  `[dor-control]` line on the host's stderr, and the only thing a user sees is
  `dor` reporting "Dormouse control endpoint is not available in this terminal
  yet" — which reads like a startup race rather than a channel that will never
  come up (and, on Windows, possibly a name somebody else took). It wants a
  visible notice, but the two hosts have no shared place to put one, so the
  design question is where: the Baseboard carries the standalone update notice
  (`docs/specs/auto-update.md`) and has no VS Code counterpart. The plumbing that
  would feed it exists — both hosts already know the outcome at `ready` (see
  [Control-channel security](#control-channel-security)).

- **`dor skill` follow-ons** — skill-ecosystem publication (plugin
  marketplaces, npm) distributes the bootstrap stub, never a copy of the
  content. A user-level `--global` install variant waits until a story needs
  it.

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
