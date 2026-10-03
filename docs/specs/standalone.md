# Dormouse Standalone (Tauri) Integration Spec

> See `docs/specs/glossary.md` for Session / Surface / Pane / Door vocabulary.
> Owns the standalone-specific layer: the Tauri windows, the Rust ↔ sidecar bridge, the AppBar, persistence at the adapter boundary, shutdown ordering, logging, and the build/dev workflow.
> Defers the protocol it speaks — PTY lifecycle, message contracts, persisted-session types, adapter-agnostic invariants — to `docs/specs/transport.md`.
> Evidence and dead approaches: [standalone.rationale.md](standalone.rationale.md).

## Architecture

**Rust stays thin**: it spawns and supervises the sidecar, bridges the webview to
it, and owns the OS-integration edges (window events, menu, file drop, dock icon,
logging) plus the session file store. All real logic runs in the Node sidecar, on
the same `lib/src/host/` modules the VS Code host runs — `build-sidecar-proxy.mjs`
bundles them into the sidecar's `.cjs` copies, so the two hosts cannot drift.

## Boot sequence

Source of truth: `bootstrap` in `standalone/src/main.tsx`, whose comments carry
the step order. The ordering invariants:

1. **The window label is resolved first**: every window-keyed Rust command and
   `isMainWindow()` read it.
2. **`platform.updates` is set in `main` only**, before `setPlatform`
   (`docs/specs/auto-update.md`).
3. **`await platform.init()` precedes the restore and
   `installPeerSurfaceResponder()`**: init registers the listeners resume replay
   and the responder's seeding `status` answer arrive on, and hydrates the
   session cache (§Persistence; rationale).
4. Tauri only, the quit flow and the per-window close listener are installed.
5. **The shell store is seeded, awaited, before the restore and the Wall
   mount**, so the first restored pane spawns with the persisted shell
   (`docs/specs/layout.md`).
6. Tauri only, a tear-out boot is tried; otherwise, in both hosts,
   `restoreWindowOrFresh`. **`armWorkspaceMoves()` runs strictly after that
   restore**, since arming drains whatever was dropped on this window while it
   booted (§Arrival queue).
7. **`startUpdateCheck()` runs in `main` only** (§Windows); the app renders
   with `multiWorkspace` and `enableBurrow`, which gates only the Burrow UI
   chunk (§Burrow service).

**Must display fatal bootstrap errors with a reload action**, for both Tauri and
the browser harness, instead of leaving a blank window.

## Rust ↔ sidecar bridge

Source of truth: `standalone/src-tauri/src/lib.rs` (`SidecarState`, the
`#[tauri::command]` set) and `standalone/sidecar/main.js` (the dispatch table);
`TauriAdapter` in `standalone/src/tauri-adapter.ts`.

The sidecar speaks JSON-lines over stdio: commands in on stdin, events out on
stdout. **stdout is the protocol** — sidecar diagnostics go to stderr, which Rust
appends to the log file.

Webview → Rust is Tauri invokes, most of them thin sidecar forwarders. Two
carve-outs are handled in Rust: `load_session` / `save_session` (§Persistence)
and the Windows `clipboard` readers (`clipboard_win.rs`;
`docs/specs/mouse-and-clipboard.md` §8.6).

**Managed-voice audio is the one byte payload that rides the pipe**, as base64 in its `voice:result` line (rationale; `docs/specs/transport.md` → "Managed voice").

`OPEN_PORT_TIMEOUT_MS` and `OPEN_PORT_TIMEOUT_PER_ID_MS` in `lib.rs` mirror
`lib/src/lib/platform/types.ts` and `standalone/sidecar/pty-core.js`;
`lib/src/lib/mirrored-constants.test.ts` pins the copies together.

**A blocking command must be async** — `#[tauri::command(async)]` or a plain
`#[tauri::command]` over an `async fn`. Tauri runs a sync command on the main
thread, where waiting on the sidecar or the arrival-journal lock stops the webview painting for the whole
round trip (rationale). **The three clipboard readers included**: their
non-Windows branches round-trip through the sidecar. A source-scanning test in
`lib.rs` enforces it.

**`pty_graceful_kill` SIGTERMs the calling window's live PTYs** (§Routing) and
resolves one grace tick after the last exits, or at its timeout for
SIGTERM-ignoring programs. **Must forward final output during that grace
period**. Under ConPTY the SIGTERM is an immediate kill. **The sidecar
keeps each PTY's latest 200,000 UTF-16 code units for replay.** Pinned by `standalone/sidecar/pty-core.test.js`.

Sidecar events reach the webview, where `TauriAdapter` converts dor control
requests into the `dormouse:control-request` CustomEvent that `Wall` handles
(`docs/specs/dor-cli.md` → Host Plumbing, including the sidecar env).

### Burrow service

The Burrow — relay socket, enrollment, ACL, pairing ceremony, remote-api v1
— runs **in the sidecar**, never the webview (`docs/specs/relay.md` → "Burrow
side"): the same `BurrowService` the VS Code extension host runs, bundled to
`sidecar/burrow.cjs`. **Nothing the webview says can widen access** (`docs/specs/remote-security-model.md`).

**State.** Rust creates the app-data directory owner-only and passes it as
`DORMOUSE_STATE_DIR` (§Persistence); `FileBurrowStateStore` keeps enrollment and
ACL there as **one** `burrow.json`, so a write is one atomic rename (rationale),
with the network policy beside it (`docs/specs/remote-network.md` → "Policy").
`burrowToken` is a bearer credential and **never enters a webview realm**.
Against the shared store contract (`docs/specs/relay.md` → "Burrow side"):

- **Reads fail closed.** Only `ENOENT` and an unparseable file answer empty —
  but the network policy's unparseable file reads as Nothing
  (`docs/specs/remote-network.md` → "Policy"). Any other read error is neither
  answered nor memoized: the load rejects, taking the save behind it (rationale).
- **The in-memory view advances only after the rename succeeds.**
- **`persistent` is declared, never inferred.** With no state directory (Rust
  passes an empty value) the store holds both values in memory, warns once, and
  reports `persistent: false`. The browser harness is not this case: its
  per-run temp directory makes a dev enrollment live and die with the run.

**The direct path.** The sidecar answers a `direct-offer`
(`docs/specs/remote-api.md` → Transport → "Direct path") over
`node-datachannel`. **A sidecar package's transitive dependencies do not ship**
— the bundle copies `standalone/sidecar/node_modules` alone — so the addon, its
platform packages (`optionalDependencies`) and `detect-libc` are declared in
`standalone/sidecar/package.json` directly, and **every entry it declares stays
`external` to `burrow.cjs`**, since the addon resolves its `.node` beside its
own `__dirname`. Source of truth: `assertNothingInlined` in
`standalone/scripts/build-sidecar-proxy.mjs`.

**The bridge.** Webview → sidecar is one passthrough invoke,
`burrow_command(payload)`; sidecar → webview is `burrow:result`, `burrow:ask`
and `burrow:event`. **The correlation field is `burrowRequestId`, never
`requestId`**: Rust swallows any sidecar line whose `data.requestId` matches a
pending invoke (rationale).

**Asks and answers.** What the sidecar cannot know — a pane's name, its focus,
its xterm size — it asks over `burrow:ask`, and
`lib/src/remote/burrow/peer-surfaces.ts` answers naming the ask's
`burrowRequestId`.

- **An ask collects one answer per window** and concatenates them, **keyed by
  which window answered, never by how many have**: Rust stamps the sending
  window's label on every `burrow:command`, so a window answering twice
  contributes once.
- **Rust pushes the live window labels** (`burrow:windows`) at setup and on
  every window create and destroy; **dropping one settles the asks that window
  can no longer answer**. An ask in flight is only ever narrowed.
- **An ask naming a `surfaceId` goes to that Surface's owner alone** —
  `attach`, `resize` and `release` act on the pane they reach — and Rust names
  the window it delivered to (`burrow:askDelivered`) so the collector settles
  on that one answer. `ASK_BUDGET_MS` bounds the whole fan-out; whatever
  answered is the best available snapshot.
- A late answer: `docs/specs/remote-api.md` -> "Directory".

**The sidecar owns the parse**, standalone's only one
(`docs/specs/terminal-escapes.md` → Parsing location): a `pty-core` `data` event
reaches the webview as `pty:data`, `terminal:semanticEvents` and
`terminal:toolEvents`, never raw, and every attached Client and the
`AlertManager` read the same parse. **The webview pushes its resolved terminal
colours** (`pty_theme_colors` → `pty:themeColors`) because the sidecar has no
DOM; **null before the first push falls a colour query through to xterm.js**,
and **a malformed push is ignored, never half-applied.**

**A remote sink must never break the local pipe**: a throw in the tap is logged
and every `pty:*` event still goes out. **A spawn or an exit retires
that PTY generation's parser**, so a half-read sequence cannot splice onto the
next one.

Source of truth: `createSidecarHost` in `lib/src/host/remote/sidecar-entry.ts`;
`standalone/sidecar/main.js` (the tap); `burrow_command` / `burrow_state_dir` in
`standalone/src-tauri/src/lib.rs`.

### Alerts

The sidecar runs the alerts' host role (`docs/specs/alert.md`), the same
`createAlertHost` VS Code's extension host runs: one `AlertManager`, every
window a realm under its label (rationale).

- **Must offer every stdin line to `createSidecarHost`'s `handleCommand` before
  `main.js` dispatches it**: it owns the PTY commands the alerts must see, every
  alert, Burrow and managed-voice command, and the theme push.
- **Webview → sidecar is one passthrough, `alert_command(payload)`, and Rust
  stamps the invoking window's label on it as `window`**, over any the payload
  claimed. **An unstamped `alert:command` is ignored.** Human input rides
  `pty_write`'s `userInput` instead (`docs/specs/alert.md` → Engagement).
- **`hello` at adapter init ends the label's previous realm**, a reload keeping
  the label; **a label gone from `burrow:windows` ends its realm too.**
- **An await's answer carries `forWindow`**, the label that parked it — **never
  a Session `id`**, which would route it to that Session's owner, **nor a
  `requestId`**, which Rust swallows (rationale).
- **`alert:speak` carries its Session's `id`**, which Rust routes it by.
- **Must re-send each listed Session's `alert:state` behind the answer to
  `pty:requestInit`**: a reloaded window and an arriving Workspace learn their
  rings and TODOs nowhere else. **A `sync` re-sends only the Sessions its window
  names**, each to its owner, and both stores' snapshots **with `forWindow`**.
- **Rust passes a spawn's `options.alert` through opaque**; the sidecar seeds
  from it (`docs/specs/alert.md` → Public State) and strips it before `pty-core`.
- **`pty-core` is the one source of helper status**, reporting each spawn's
  validation and each successful promotion through `onHelper`.

Source of truth: `createSidecarHost` in `lib/src/host/remote/sidecar-entry.ts`;
`alert_command` / `forward_stamped` in `standalone/src-tauri/src/lib.rs`.

### Windows node subsystem

On Windows the app carries **two** subsystem variants of the same `node.exe`:

- **The sidecar must run under a GUI-subsystem node**, or Win11's DefTerm handoff
  flashes a stray Windows Terminal window behind Dormouse (rationale). `build.rs`
  patches the bundled `node.exe` (`force_windows_gui_subsystem`).
- **`dor` must run under a console-subsystem copy**, or it silently drops
  everything it prints inside a shell's ConPTY (rationale). `start_sidecar`
  derives the copy (`resolve_dor_node_path`) and points `DORMOUSE_NODE` at it.
- **Never leave the GUI node's directory on a pane's PATH**: a bare `node` in a
  dev pane would be console-less (rationale). `start_sidecar` passes it as
  `DORMOUSE_GUI_NODE_DIR`; the sidecar strips it from each pane's PATH.

The PE offsets live once, in `standalone/src-tauri/src/pe_subsystem.rs`, shared
with `build.rs`. Source of truth: `withoutGuiNodeDir` in
`standalone/sidecar/pty-core.js`.

## Sidecar lifecycle

Source of truth: `standalone/sidecar/main.js`. Browser cleanup is pinned by `standalone/sidecar/shutdown.test.js`.

**Shutdown** (`sidecar:shutdown`, stdin EOF, or SIGTERM) **is idempotent and
ordered**: browser-host cleanup first, awaited under one 1.5 s deadline that
must stay inside Rust's `shutdown_sidecar_and_wait` grace (~2.5 s) before it
kills the process group (`docs/specs/dor-browser.md` owns the teardown contract); then the dor control
socket; then `host.dispose()`, the alerts then the Burrow, settling every
outstanding ask; then every PTY; then exit.

**A parent-PID watchdog self-triggers shutdown if the Tauri process
disappears**: stdin EOF is not always delivered on a force-kill, and an orphaned
sidecar keeps `conpty.node`/`conpty.dll` loaded and blocks the NSIS installer
(`docs/specs/auto-update.md`, Sidecar teardown on Windows).

Every quit trigger is driven through the webview quit orchestrator (§Quit flow);
Tauri's `RunEvent::Exit` then runs `shutdown_sidecar_and_wait` as a final
backstop.

## AppBar

Source of truth: `standalone/src/AppBar.tsx`.

The AppBar is the draggable titlebar region: the **Workspace strip**, then —
Windows/Linux only, since macOS gets native traffic lights from
`titleBarStyle: "Overlay"` — the window controls. **Neither a theme picker nor a
shell picker belongs here**: both live in the Settings dialog
(`docs/specs/theme.md`). The strip's gestures and appearance are
`docs/specs/layout.md` → Workspace tabs; its indicators are
`docs/specs/alert.md` → Workspace union.

Picking a shell in the Settings dialog's **Shell** row
(`lib/src/components/ShellPicker.tsx`) persists it; what a changed pick spawns:
`docs/specs/layout.md` -> "Session lifecycle and terminal registry".

### Application menu

Source of truth: the `.menu(...)` builder in `standalone/src-tauri/src/lib.rs`.

The app replaces Tauri's default menu with macOS-only App and Edit submenus and
a Window submenu. **Must keep the macOS fullscreen item**: it and its
Ctrl+Cmd+F are the only exit from native fullscreen when AppKit does not reveal
the traffic lights.

- **Must keep the Edit submenu on macOS**, Tool iframes' only clipboard path
  (rationale).
- **Must cancel the keydown of any chord the page handles**, so the menu item
  skips it (rationale): `docs/specs/mouse-and-clipboard.md` §3.9, §8.2, §8.9.
- **Never add an Edit submenu on Windows or Linux** (rationale).

## Siri affordance

**Never show macOS's Siri affordance in a Dormouse webview** (rationale).
`install` answers NO to `allowsWritingToolsAffordance` on wry's `WKWebView`
subclass, never on `WKWebView` itself, once at `RunEvent::Ready`; the override
is class-wide, so it covers every window, text field, and browser pane.

Source of truth: `install` in `standalone/src-tauri/src/macos_siri_affordance.rs`.

## Windows

**Several windows, each with several Workspaces, over one sidecar**
(`docs/specs/glossary.md`). The sidecar has no window concept, so **Rust owns
the map from PTY to window** and every stdout line passes through it.

**The label is the window's persistence identity**: `main` for the first window
(fixed in `tauri.conf.json`), `ws-<n>` for every later one, numbered above every
live label, every `sessions/ws-*.json` on disk, and every retained
arrival-journal endpoint, so a new window cannot claim a saved or pending
identity. Journal-only labels reserve numbers without opening windows.

**Every new window is cloned from `app.windows[0]`**, so its window settings
and CSP carry across with no second copy.

**Never let a window's webview throttle or suspend in the background**:
`app.windows[0]` sets `"backgroundThrottling": "disabled"` (macOS 14+; a no-op
on Windows and Linux; rationale).

**Capabilities are split**: `default.json` covers `main` and the `ws-*` glob,
and `main-only.json` scopes `updater:default` and `core:app:allow-version` to
`main`, which structurally enforces that the install runs in the window the walk
tears down last (`docs/specs/auto-update.md`). `standalone/scripts/tauri-conf.test.mjs`
pins the label, the throttling, and both capabilities.

### Workspace registry

**Rust holds the union of every window's Workspaces**, since each webview's
store (`lib/src/lib/workspace-store.ts`) sees only its own. Each window reports
its list on every change, and the union is broadcast as `dormouse://workspaces`
with a monotonic `revision`; a webview drops a snapshot behind the one it holds.

- **Must mint numbered ids only in Rust**, `workspace-<n>` off one counter,
  handed to a webview in blocks (`workspace_reserve_ids`) so a create mints
  synchronously. The ref `workspace:<n>` is the id's number, so it never
  renumbers and never collides across windows.
- **Must allow boot and creation when reservation fails**, using opaque UUID
  ids, and **retain those ids and refs for their lifetime**, even after
  reservation recovers (`docs/specs/dor-cli.md` → "Handle Model").
- **Must seed the counter above every id named by a snapshot, a retained
  arrival-journal record, or a window's report**, and never below 2:
  `workspace-1` is a bare Wall's only Workspace.
- **A `dor` request naming a Workspace or Window routes to the window holding
  it** (§Routing). A target the registry cannot place — one no window reports,
  or a name two windows carry — falls through to the caller's window, which
  refuses a name duplicated there and otherwise resolves its own. **A target
  routes as a number only when it reads as `POSITIONAL_WORKSPACE_REF`**
  (`dor/src/protocol.ts`); `007` and `0` are names.
- **Must keep numbered and opaque refs consistent across Rust, the webview, and
  the browser harness**: `standalone/scripts/workspace-ref-cases.json` holds the
  shared cases.
- **`Destroyed` forgets the window's entries** and broadcasts.

Source of truth: `standalone/src-tauri/src/workspaces.rs`;
`installWorkspaceRegistry` in `standalone/src/workspace-registry.ts`.

### Routing

*Showing* an id is the source still consuming it until its transfer mark, otherwise its owner.

| Sidecar event | Key | Goes to |
|---|---|---|
| `pty:data`, `terminal:semanticEvents`, `terminal:toolEvents` | `data.id` | the window showing it; after the mark, dropped until its replay, which carries the bytes and from which the receiving window re-derives the events (rationale) |
| `pty:exit` | `data.id` | the window showing it, never suppressed |
| `pty:replay` | `data.forWindow`, then `data.id` | the requesting window, including exited buffers; without an address, its owner; never suppressed |
| `pty:marked` | `data.id` | the window showing it; the id then falls silent until its replay |
| `pty:list` | `data.forWindow` | the window that asked |
| `alert:*` | `data.forWindow`, then `data.id` | that window; else the window showing the Session; neither → every window |
| `dor:controlRequest` | `params.workspace`, `params.window`, `data.surfaceId` | in that precedence: the window holding the named Workspace (§Workspace registry), the named window, the caller's Surface's owner; none → the focused window |
| `dor:controlCancel` | `data.requestId` | the window its request went to; unknown → every window |
| `burrow:ask` | `data.params.surfaceId` | its owner; a Surface with no PTY here, or an ask naming none, → every window (§Burrow service) |
| `voice:result` | — | nowhere: only one that outlived its invoke gets here |
| everything else | — | every window |

- **Ownership is minted only in `pty_spawn`**, dropped by `pty_kill` or the
  window going away, and reassigned by a transfer. **Never dropped by an exit,
  nor does an exit end a transfer's marking phase** (rationale). Minting clears
  any suppression left under that id. `pty_kill` drops the owner before the
  sidecar removes the Session's alert entry, so the removal's state reaches no
  window.
- **A PTY event no window owns is dropped, and the shell is reaped** (rationale).
  `Destroyed` sends `pty:reap` for whatever the departing window still owned;
  the sidecar removes those Sessions' alert entries and SIGTERMs them. **The quit
  teardown's `pty:gracefulKill` removes no entry**: windows still show those PTYs.
- **A `dor` request naming a Surface no window owns is answered with an error**,
  never handed to a sibling.
- **`pty_request_init`, `pty_graceful_kill` and `capture_agent_recovery` target
  the invoking window's own PTYs and take no ids**: a window tearing down must
  never touch a sibling's terminals. Each also excludes what an arrival claims
  (§Arrival queue).
- **A `dor` cancel follows its request**: Rust remembers which window took each
  `requestId` and forgets it on the response.
- **Every webview listener names its own window**: Tauri delivers an `emit_to`
  event to any listener with the default `Any` target (rationale).
  `listenToWindow` in `standalone/src/window-label.ts` is the only caller of the
  event API, pinned by `standalone/scripts/window-listeners.test.mjs`.
- **The focus order is the fallback owner** for a `dor` request naming no
  Surface, and the drag hit test's stand-in for a z-order the OS does not expose.

Source of truth: `route` in `standalone/src-tauri/src/routing.rs`;
`dispatch_sidecar_event` in `standalone/src-tauri/src/lib.rs`.

### Boot and geometry

**Boot reopens every window `sessions/` names**, `main` first then each `ws-<n>`
in numeric order, capped at `MAX_RESTORED_WINDOWS` with the excess logged and
left on disk (rationale). **An unreadable snapshot still opens its window**,
booting fresh. **`main` is focused last**, so it comes up in front; **a session
naming no `main` relaunches with a fresh, empty one**.

**Geometry is a sibling of the snapshot**, `sessions/<label>.geometry.json`,
written through the same atomic writer, debounced, and re-applied at boot. No
`tauri-plugin-window-state` (rationale). The live box is cached from the
`Moved` / `Resized` events, which both the write and the cross-window drag hit
test read; the cache's lock rules are at `GeometryState` (rationale).

Source of truth: `note_geometry` / `restore_windows` in
`standalone/src-tauri/src/lib.rs`.

### What a window's `Destroyed` settles

**Must clear label-keyed ownership, registry, geometry, and close state in the
`Destroyed` arm**, when Tauri has removed the window from `webview_windows()`
(rationale), and send the remaining live labels to the sidecar.
**Must remove incoming arrivals from the reap before killing orphaned PTYs**;
the source still holds those Sessions. **Must defer every approved exit until
every hand-back worker has completed**, on every exit path, and **force it after
`QUIT_PHASE_TIMEOUT_MS`**, logging the timeout, so a stalled disk operation
cannot trap the app.

Source of truth: `CleanupGate` and `WindowEvent::Destroyed` in
`standalone/src-tauri/src/lib.rs`.

### Per-window close

**Closing a window with siblings alive ends that window alone**; only the last
window's close is the quit, and on macOS too. Rust prevents the close and emits
`dormouse://window-close-requested`; the webview acks (a watchdog closes the
window anyway if that listener is dead), asks about *its own* running work,
removes its snapshot, kills its PTYs, and calls back `close_window`.

- **Must attempt to remove the blob, geometry and temp sibling included, before
  killing this Window's PTYs** (`docs/specs/transport.md` → "The governing
  rule"). A removal failure is logged and the close proceeds.
- **It runs no agent-recovery capture**: nothing is coming back.
- **It confirms on a pending download as well as on running work**: the
  download lives in this webview, so nothing else can install it
  (`docs/specs/auto-update.md`).
- **Must refuse every later save for a closing label, geometry included, for the
  process lifetime.** Both the webview's `remove_window_session` and the
  ack-timeout path's `finish_window_close` set it; no label is reused within a
  process.
- **`close_window` is the one Rust half both endings share** — a deliberate close
  and a window whose last Workspace moved away (§Transfer).

**The ack and confirm gates are one shared flow with the quit**
(`createTeardownFlow` in `standalone/src/teardown-flow.ts`): a quit votes and
waits its turn in the walk, a close tears down at once.

**Arbitration.** **A second flow is never refused in silence**: an unsettled
context parks its flow and leaves its host waiting on a decision that cannot
come.

| Arriving | Holder | Outcome |
|---|---|---|
| quit | a close still on its dialog | the close is cancelled (`window_close_cancel`); the quit takes over |
| quit | any committed flow | the quit acks and **votes**, since this window is ending anyway |
| close | a quit, in any state | refused at once with `window_close_cancel`; the window stays |

**A quit cancelled elsewhere drops only a quit's dialog**, never this window's
own close question. Pinned by `standalone/src/teardown-arbiter.test.ts`.

Source of truth: `standalone/src/window-close.ts`; `request_window_close` /
`finish_window_close` in `standalone/src-tauri/src/lib.rs`.

### Transfer

Dirty Tool consent: `docs/specs/dor-tool.md` → Closing unsaved Tools.

**A Workspace moves between windows without ending anything.** No process is killed: a move is not a closure.

The protocol and every failure path are §Arrival queue; what a move *is*:

- **A window whose last Workspace left closes itself**, with no confirmation and no kill.
- **Must collapse the source only after `workspace-departed` confirms adoption, before committing its release and removing its tab or closing its Window.** `standalone/src/workspace-move.test.ts` pins this order. Presentation is `docs/specs/layout.md` → Workspace motion.
- **A pane's helper Session travels with it**, directly after its source, which
  lets the target's resume re-parent it; nothing else in the payload names it.
- **An arrival whose PTYs never answer is refused, never cold-restored**: those
  shells are still running (`docs/specs/transport.md` → "Reconnection").
- **A Workspace that comes back must mount from the record it brought**, never
  the plan it first booted with.

Source of truth: `prepareWorkspaceTransfer` in
`lib/src/components/wall/workspace-transfer.ts`, `standalone/src/workspace-move.ts`,
`transfer_workspace` in `standalone/src-tauri/src/lib.rs`.

Tool transfer follows `docs/specs/dor-tool.md` → Persistence and hosts.

Alert state and alarm delivery follow `docs/specs/alert.md` → Live Workspace transfer.

### Tear-out

**A tear-out opens the window positioned so the dragged tab lands under the
cursor**, at the source window's size. Its first flush writes
`sessions/ws-<n>.json`; everything else is the transfer above.

### Arrival queue

**An arrival is one transaction keyed by `workspaceId`**, carrying the source's
Workspace, its `terminalIds`, and `allIds` naming every member Surface, under
Rust's own `from` / `to`. Rust holds the record from the source's invoke until
the target adopts the Workspace or dies, and every step reads that record
rather than inferring it from the suppression map (rationale). The mark-and-replay
split is `docs/specs/transport.md` → "Transferring a Workspace".

1. **Source** prepares the Workspace, touching nothing, and invokes
   `transfer_workspace` / `open_workspace_window`. **Must return preparation
   refusals as `{ moved: false, reason }` without changing ownership.** On `Ok`
   it marks the Workspace **transferring**: still mounted, nothing released,
   omitted from `getWindowSnapshot`.
2. **Rust** journals the arrival, reassigns `terminalIds` to the target, keeps
   routing their output to the source until each id's `pty:marked`, and
   suppresses it from there until its replay reaches the target. The source
   submits each buffer serialized at its mark via `transfer_workspace_content`;
   only then does Rust nudge the target (`workspace-arriving`, carrying nothing)
   or build the torn-out window. **An arrival without content is not drainable.**
3. **Target** drains with `take_arrivals` and, per arrival, arms its collector
   *before* calling `adopt_ready(workspaceId)` (rationale). Rust answers
   `pty:requestInit` with **that arrival's ids and no others**, the collector's
   token echoed. The target resumes over them and mounts the Workspace at the
   payload's index, else the drop index. **It never spawns or kills**; the
   sidecar re-sends the Sessions' alert state (§Alerts).
4. **Target** invokes `adopt_done(workspaceId)`. Rust retires the record, clears
   marks and suppression, and emits `workspace-departed` for **that Workspace
   alone** to its source.
5. **Source** commits: releases every Session (never kills one), drops the
   helper, closes the Workspace, and closes the window if it was the last.

- **Nothing is released before the target has adopted it.**
- **A transferring Workspace is in no snapshot its source writes, and neither
  end's teardown kills or interrupts its shells**: the target's
  `pty_graceful_kill` and `capture_agent_recovery` exclude every id an arrival
  claims (`boot_list_ids`), and so does a boot's `pty_request_init`.
- **Must await `adopt_done` before installing a torn-out Window; refusal
  releases its resumed Sessions and boots fresh.** **A refused `adopt_done`
  unwinds the mount** from the received payload, releasing (never killing) and
  closing the Workspace, without preparing another move (rationale).
- **A refused arrival hands the shells back.** The target's `adopt_failed` and a
  target `Destroyed` with the arrival still queued both return `terminalIds` to
  the source, drop the record, and emit `workspace-arrival-failed`; the source
  clears **transferring**. With both ends gone the shells are reaped.
- **An arrival unadopted after `ARRIVAL_MAX` is handed back** by a watchdog armed
  at `begin_arrival`, retiring only the record it was armed for (`queued_at`).
- **A hand-back replays what the marked ids missed** (rationale):
  `hand_back_arrival` returns each marked id to the source suppressed and asks
  the sidecar for `outputSince(mark)`, whose replay lifts the suppression into
  the existing xterms; an id never stamped goes straight back, and the failure
  event carries the replay ids. **Must retain source cuts from `pty:marked`
  through target replay and natural exit until settlement, and discard them on
  explicit kill.** **Must apply a handed-back PTY's exit status after its
  replay**, leaving its pane dead with no running command.
- **`take_arrivals` does not consume**; the record settles at `adopt_done` and
  the webview dedupes by id (rationale).
- **`AWAITING_REPLAY_MAX` fails open only for suppressions no arrival claims**
  (rationale).
- **`begin_arrival` journals the arrival in `sessions/arrivals.json` before
  ownership moves**, never in either window's snapshot (rationale); **a failed
  write refuses the move with nothing changed**. **Must retain the record until
  both snapshots reflect the outcome** — marked settled at adoption, its durable
  destination reversed on hand-back — and **tombstone settled arrivals into a
  deliberately closed Window until both snapshots omit them**; failed settlement
  or hand-back writes are logged and block nothing live. A record left at boot
  is merged into its recorded destination before `restore_windows`, so the
  Workspace restores once, with fresh shells; **must retain failed records for
  retry, roll back the target if trimming the source fails, and preserve a
  settled arrival's newer target record.**

Source of truth: `Arrival` in `standalone/src-tauri/src/routing.rs`;
`begin_arrival` / `restore_arrivals` in `standalone/src-tauri/src/lib.rs`;
`standalone/src/workspace-move.ts`; `markWorkspaceTransferring` in
`lib/src/lib/window-session-aggregator.ts`.

### Dragging a Workspace between windows

**A pointer captured on a strip tab keeps delivering `pointermove` and
`pointerup` outside the window**, so the gesture stays the webview's and the
host is only asked where the cursor is (rationale). Past the strip edge a
throttled `window_at_cursor` probe lights a drop caret in whichever window is
under it; **the release transfers there, or tears out when the cursor is over no
window or over this window outside its own strip**.

**Among windows containing the cursor the most recently focused wins** — the OS
exposes no z-order. **The target decides the drop index.** **Never assume
in-range pointer coordinates**: a captured pointer reports them past the
window's edges and negative (rationale).

Source of truth: `window_at` in `standalone/src-tauri/src/routing.rs`;
`standalone/src/workspace-drag.ts`.

## Persistence

**One `PersistedWindow` per window, every Workspace in it**, restored on the
next launch (`docs/specs/transport.md` → "The governing rule" and "Persisted session
types"). Each Workspace's Wall publishes to the Window aggregator, whose one
debounced writer is `TauriAdapter.saveWindowState`; `getWindowState` is the boot
reader and **parses the blob once**. Source of truth: `windowStateSlot` in
`standalone/src/window-recovery.ts`.

**Boot restores per Workspace off one live-PTY list.** Reload and relaunch are
the same path: nothing wires `shutdown()` to `beforeunload`, so a reload's PTYs
partition by saved pane id, while a relaunch's list is empty and every Workspace
cold-restores at its saved cwds. **A live PTY no saved Workspace names goes to
the active Workspace**, except a helper, which goes to the Workspace holding its
source.

Source of truth: `restoreWindowOrFresh` in `standalone/src/window-restore.ts`.

**Every Workspace saving at the same moment costs one `pty_get_cwds`**: both
adapters fold the calls of one microtask into a single invoke
(`standalone/src/coalesce-cwds.ts`). A listing's one scan
(`docs/specs/dor-cli.md` -> "Current Implemented Commands") is one
`pty_get_open_ports_many`, which the sidecar answers from one process-table
read and one socket scan; its deadline is
`docs/specs/transport.md` -> "Port scan deadlines".

**Nothing is deleted at boot but orphaned session temp files and what the
arrival merge settles** (`docs/specs/transport.md` → "Retiring the transcripts already on disk").

**Never back the session blob with WebKit `localStorage`** — a WAL that grows
without bound (rationale). The blob rides the `SessionKeyValueStore` seam over
the Rust-backed `standalone/src/tauri-session-store.ts`. Theme selection still
persists on `localStorage` (`docs/specs/theme.md`).

**Rust file store.** `save_session` / `load_session` persist the blob as one
atomic file per Tauri window, `<state root>/sessions/<label>.json`:

- **The label is sanitized** so it cannot escape the directory.
- **Temp-then-rename**, the temp file fsynced first and, on unix, the directory
  after, best-effort (rationale). **The writer removes its own temp file on
  every error path**, so only a crash leaves one.
- **Window identity is implicit**: each command keys by the invoking window's
  label, so the frontend stays window-agnostic.
- Only §Per-window close and the boot merge (§Arrival queue) delete a snapshot.

**Must use `<app_data_dir>/dev` as the debug state root and `<app_data_dir>` for
release builds** (rationale), and **keep Burrow state directly under the
identifier's `app_data_dir`**. **Rust passes the sidecar its two directories by
environment**, each created owner-only first and empty when it could not be:
`DORMOUSE_STATE_DIR` (the Burrow store, `app_data_dir`) and
`DORMOUSE_RECOVERY_DIR` (the state root, so a dev run's record cannot reach the
installed app). The browser-dev harness sets both to its per-run temp directory.
Source of truth: `state_root_from` / `prepare_owner_only_dir` in
`standalone/src-tauri/src/lib.rs`.

**The session store is owner-only before any bytes are written**
(`docs/specs/security-local.md` -> "Persisted state"; rationale). **Must abort a
snapshot save if either permission change fails**, preserving the previous
snapshot. **Must withhold a state directory whose restriction fails**, logging a
`WARNING` naming the path; the Burrow store and recovery record then stay in
memory.

**`getState()` is synchronous; a Tauri `invoke` is not.** `TauriSessionStore`
keeps a write-through cache that `TauriAdapter.init()` hydrates from
`load_session` (§Boot sequence), read synchronously and forwarded to
`save_session` with at most one write in flight, latest value winning.
**Must skip an unchanged store write only when that value is queued or saved**,
so an idle failed write stays retryable; dirty tracking above it is
`docs/specs/layout.md` → Session persistence.

**Must await the store pipeline before exiting**, under the quit timeout
(§Quit flow; rationale): `drainSessionSaves` resolves when it goes idle, a
rejected write included. Drain is a completion barrier, not a guarantee of
successful persistence.

Source of truth: `TauriSessionStore` in `standalone/src/tauri-session-store.ts`.

### Agent recovery

**Must run shared capture and record ownership in the sidecar**, under `docs/compatible-agents.md`. **Must answer `capture_agent_recovery` and `take_recovery_commands` through `respondAsync`**, returning `{ error }` on throws rather than stranding the invoke.

- **Must store the record at `<state root>/recovery.json`.**
- **Must claim the saved Window's pane ids across all its Workspaces from `TauriAdapter.init()`**; boot awaits `recoveryReady` only on the branch that can cold-restore.
- **Must restrict capture to the closing Window's eligible PTYs** (§Teardown ordering, §Arrival queue).
- **Never capture in the browser-dev harness**; it claims records but reloads resume live PTYs.

Source of truth: `pty:captureRecovery` / `recovery:take` in `standalone/sidecar/main.js`.

## Quit flow

Tool close consent: `docs/specs/dor-tool.md` → Closing unsaved Tools.

Source of truth: `QuitMachine` in `standalone/src-tauri/src/quit_state.rs`;
`standalone/src/quit.ts` (the webview orchestrator).

**Must intercept every quit trigger in Rust** and run the webview teardown
before exiting (rationale).

**Every window votes before any window is torn down** (rationale): Rust asks
them all, and only once all agree walks them one teardown at a time.

| Phase | What happens |
|---|---|
| Voting | every window acks, asks about its own running work, and calls `quit_vote` — or `quit_cancel`, which tells every window and destroys nothing |
| Walking | the `dormouse://quit-teardown` event reaches one window at a time, **`main` last**; each hands on with `quit_window_done`, and the last one installs and calls `quit_proceed` |

- **A cancel is refused once the walk starts.**
- **A window that leaves outside the flow is forgotten**, its vote never waited
  on. **A flow that runs out of windows exits**, and so does a trigger that finds
  none.
- **A quit keeps every window's snapshot on disk** — the whole difference from a
  per-window close. A quit mid-transfer restores the Workspace at most once:
  from the target once it has published it, or from a source handed it back; a
  source torn down before its target adopts leaves it in no snapshot
  (§Arrival queue).

### Trigger interception

Every trigger funnels into `request_quit(app)`:

| Arm | Fired by | Guard |
|---|---|---|
| `WindowEvent::CloseRequested` | the window close button | `api.prevent_close()` unless approved; refused outright while the walk runs. Only the **last** window's close is a quit (§Per-window close) |
| `RunEvent::ExitRequested` | a window-level exit request | `api.prevent_exit()` unless approved and cleared by the cleanup gate (§What a window's `Destroyed` settles); its `code` is ignored |
| the app menu's Quit item | the menu and its `Cmd+Q` | a **custom** `MenuItem`, never `PredefinedMenuItem::quit` (macOS; rationale) |
| `applicationShouldTerminate:` | the Dock's Quit, `osascript`, logout, restart | spliced onto tao's live delegate class at `Ready`, answering `NSTerminateCancel` and starting the flow; a re-sent terminate after approval gets `NSTerminateNow` once the cleanup gate clears (macOS; rationale) |
| the `quit_restart` command | the update notice's "Restart now", `dor app restart` | `request_quit` with the restart intent (§Restart) |

Source of truth: `standalone/src-tauri/src/macos_terminate.rs`.

### Quit protocol

`request_quit` clears every window's `acked`, bumps `seq`, and broadcasts
`dormouse://quit-requested`; **it must leave a walk in flight alone and keep
every vote already cast**. Each window's orchestrator (`initQuitFlow`):

1. **always `quit_ack`s first**, even if it then dedupes the event out;
2. **`quit_vote`s** when ready — at once when all-idle, else after the user
   confirms; **a vote is not a teardown**;
3. `quit_progress`es when its own `quit-teardown` arrives and at the install
   phase boundary;
4. tears down (§Teardown ordering), then `quit_window_done`, or `quit_proceed`
   in the last window, which approves and calls `app.exit(0)`;
5. on a dialog cancel, calls `quit_cancel`, which bumps `seq` and drops every
   window's dialog. **Nothing else cancels.**

A **watchdog** thread keeps quit bounded against a dead or wedged webview:

| Phase | State | Budget |
|---|---|---|
| 1 — ack | some window has not acked | short; a listener is dead ⇒ log and `app.exit(0)` |
| 2 — voting | acked, no window walking yet | **none** — a window may be waiting on a human, who must never be force-quit; only approval or a `seq` bump ends it |
| 3 — walking | one window tearing down | `QUIT_PHASE_TIMEOUT_MS` (14 s) per phase, refreshed by `quit_progress` and by the walk advancing; no progress ⇒ log and exit |

**Phase 3's budget must exceed the webview's teardown ceiling and the install
phase's sidecar-kill cap** (`docs/specs/auto-update.md` → "Sidecar teardown on
Windows"); `lib/src/lib/mirrored-constants.test.ts` pins the ceiling, nothing
pins the install phase. Watchdog exits also pass the cleanup
gate. Each watchdog captures its `seq`, so a repeated trigger leaves the stale
one to exit without acting.

**Must use the Workspace typed-letter confirmation for window close and quit**,
naming every Workspace in the window, hidden ones included. It opens for running
Sessions; an all-idle quit proceeds without a prompt. **A quit's prompt says
supported agent sessions resume when Dormouse reopens** (§Agent recovery); a
window close's never does. The letter rule is `docs/specs/layout.md` →
Workspaces.

- **Must cancel an unconfirmed request if Workspace membership changes**;
  switching and reordering preserve it.
- **Must exclude transfers from host teardown.** An app quit queues while any
  arrival is pending, a native window close while that window is an arrival
  endpoint, and each retries through normal confirmation once the transfer
  settles; quit supersedes queued closes. **Must refuse new transfers while app
  quit or either endpoint's close is queued, confirming, or tearing down**, both
  decided under one lock (`ArrivalQueue`).

Source of truth: `openQuitConfirm` in `standalone/src/quit-confirm-store.ts`;
`WorkspaceTeardownModalHost` in `standalone/src/WorkspaceTeardownModal.tsx`.
Cross-window voting is pinned by `standalone/src/quit.test.ts`.

### Teardown ordering

**Every step of `runQuitTeardown` is individually bounded, and the whole sits
under a ceiling derived from the sum of those bounds, never a literal**,
counting Rust's round-trip margin for the two steps that reach the sidecar
(`QUIT_TEARDOWN_CEILING_MS` in `standalone/src/quit.ts`; pinned by
`lib/src/lib/mirrored-constants.test.ts`). The steps:

1. `captureAgentRecovery` — **first**, since an agent's resume invocation exists
   only between the interrupt and the kill (§Agent recovery; rationale). **A
   failed capture must not abort the steps behind it.**
2. `requestSessionFlush` — while PTYs are alive, so CWDs are fresh.
3. `gracefulKillPtys` — this window's PTYs (§Rust ↔ sidecar bridge).
4. `requestSessionFlush({ probeCwd: false })` — the post-exit state
   (`docs/specs/transport.md` → "Persisted session types"; rationale).
5. `flushWindowSession` — the one Window blob, bounded like the rest.
6. `drainSessionSaves` (§Persistence).
7. **In the last window only**, if an update is pending, a fresh
   `quit_progress` then `installPendingUpdate()`, strictly after the save
   (`docs/specs/auto-update.md`); the phase-3 watchdog backstops a hung
   installer.
8. **Always** `quit_window_done`, or `quit_proceed` in the last window, in
   `finally`.

### Restart

A restart is a quit that relaunches: the same vote, confirmation and teardown,
with only the exit changed.

- **The trigger that leaves `Idle` unapproved fixes the intent** — whether to
  relaunch, and the requesting Surface. A repeat trigger keeps it, a cancel
  clears it, and a quit queued behind a transfer carries it. `quit_restart`
  answers whether the quit it landed in relaunches — `false` when it joined a
  plain quit.
- **`dormouse://quit-requested` carries only `{ requester }`**: a restart asks
  exactly what a quit asks.
- **The requester never counts as running work in the restart's confirmation**
  (`quitRunningWork`); every other running Session still asks, and Workspace and
  window closes count everything.
- **Every approved exit stays `app.exit(0)`; the relaunch runs in
  `RunEvent::Exit`, after `shutdown_sidecar_and_wait`**, via
  `tauri::process::restart`, which on macOS re-reads `Info.plist`, so a bundle
  replaced in place starts as the new version. **Never
  `AppHandle::request_restart`** (rationale).
- **Must clear the restart intent when macOS re-sends an OS terminate after
  approval**, so logout never relaunches.
- **`quit_restart` refuses a debug build and an executable
  `tauri::process::current_binary` cannot resolve** (rationale).
- A Windows quit holding an update relaunches by its installer instead
  (`docs/specs/auto-update.md` → "Platform behavior at quit").

Source of truth: `quit_restart` in `standalone/src-tauri/src/lib.rs`;
`QuitIntent` in `standalone/src-tauri/src/quit_state.rs`.

## File drop

The `WindowEvent::DragDrop` handler emits the dropped paths as
`dormouse://files-dropped`, which `TauriAdapter` fans out to `onFilesDropped`.
The path is **inert today**: `tauri.conf.json` sets `dragDropEnabled: false`.
Behavior: `docs/specs/mouse-and-clipboard.md` (§8.7 Drag-to-Paste).

## Logging

Windows release builds use the GUI subsystem, so nothing streams to a launching
terminal. Rust appends sidecar stderr, malformed stdout, and its own diagnostics
to `%LOCALAPPDATA%\Dormouse Terminal\dormouse.log` on Windows,
`$TMPDIR/dormouse.log` elsewhere, overridable via `DORMOUSE_LOG_FILE`. The log
resets at app startup.

Source of truth: `init_log` / `read_update_log` in `standalone/src-tauri/src/lib.rs`.

## Objective-C exceptions

**Must let an Objective-C exception that AppKit raises beneath a tao callback,
such as the `sendEvent:` override, unwind to AppKit**, whose event loop reports
it and keeps running. Both halves are required (rationale):

- **Must build release with `panic = "unwind"`.**
- **Must take tao from the `diffplug/tao` fork** through `[patch.crates-io]`,
  whose Apple callbacks are `extern "C-unwind"`: one fork branch per patched
  release (`dormouse-0.35` is `tao-v0.35.2` plus that commit), `tao-macros`
  from the same rev. **Must rebase the commit onto the new
  release when tauri moves tao**, since an unused `[patch]` only warns; drop the
  patch once tauri depends on a tao carrying tauri-apps/tao#1354.

**Rust panics still abort** (`abort_on_panic`, installed first in `run`). **An
exception raised inside the Tauri event handler still aborts** (rationale).

Source of truth: `abort_on_panic` in `standalone/src-tauri/src/panic_policy.rs`;
`[patch.crates-io]` in `standalone/src-tauri/Cargo.toml`.
Pinned by `standalone/src-tauri/tests/objc_exception_unwinds.rs`.

## Build and development

Source of truth: `standalone/package.json`, `standalone/src-tauri/tauri.conf.json`,
and the root `package.json` for `dev:standalone` and `innerdogfood`;
`runDev` in `standalone/scripts/dev-standalone.mjs`.

- `stage` stages the dor CLI (`docs/specs/dor-cli.md`) and the sidecar's
  `lib/src/host/` bundles.
- **The sidecar bundle and the webview bake `DORMOUSE_RELAY_ORIGIN`**
  (`docs/specs/relay.md` → "Relay origin"); the webview CSP has no relay sources
  (`standalone/scripts/tauri-conf.test.mjs`).
- **A self-host `tauri build` overlays no updater endpoint and no updater
  artifacts**, so the binary cannot reach `dormouse.sh` and needs no signing
  key. Pinned by `standalone/scripts/dev-standalone.test.mjs`.
- The bundle ships the whole sidecar via the `../sidecar/**/*` resources glob,
  including node-pty's prebuilds + bundled ConPTY and the shell-integration
  scripts (`docs/specs/theme.md` -> "OSC color queries on Windows require the bundled ConPTY",
  `docs/specs/terminal-state.md` -> "Shell-integration injection").
- **Must start native dev with Vite on an OS-assigned loopback port and pass its
  bound URL to Tauri**; a direct `pnpm exec tauri dev` keeps `tauri.conf.json`'s
  defaults. Inherited browser-dev settings never enable browser mode.
- **May pin Vite with `DORMOUSE_BROWSER_DEV_VITE_PORT`; an occupied port must fail
  without stopping its owner.**
- **Must close Vite and the owned Tauri process tree on startup failure, exit,
  SIGINT, SIGTERM or SIGHUP.**
- **Must key the native dev Tauri identifier to the canonical worktree path**, so
  parallel worktrees and the installed app never share app data. The default
  log is `<worktree>/standalone/src-tauri/target/dormouse-dev.log`.
- **Must limit Windows pre-dev cleanup to sidecars executing from this
  worktree's default debug directory; never kill a listener by port.**
- **Must re-stage and restart after changing sidecar, staged CLI, or bundled host
  sources.** Frontend edits hot-reload; Tauri watches Rust.
- **May point a dev build at a local `pnpm dev:hosted`** — the origin it prints,
  with `DORMOUSE_RELAY_IS_HOSTED=1` — to speak managed voice through it; it
  answers no other `Host` (`docs/specs/security-local.md` -> "Persisted state").

### Standalone browser-dev harness

`pnpm innerdogfood` starts the standalone sidecar directly, a localhost-only HTTP bridge, and Vite with `VITE_DORMOUSE_BROWSER_DEV_HOST`, then opens the app in an `agent-browser` session; that env var selects `BrowserSidecarAdapter`. Inside Dormouse, `dor tool innerdogfood` starts and shows it.

- **Must bind OS-assigned ports for Vite and the HTTP bridge by default**, and **derive the default browser key from the canonical worktree path**, so parallel worktrees are isolated.
- **May pin ports with `DORMOUSE_BROWSER_DEV_VITE_PORT` / `DORMOUSE_BROWSER_DEV_HOST_PORT` and the session with `DORMOUSE_BROWSER_DEV_AB_SESSION`.** An occupied pinned port fails startup; `0` requests an OS-assigned port. Explicit overrides are the caller's isolation responsibility.
- **Must open through `dor agent-browser` when `DORMOUSE_SURFACE_ID` is set**, otherwise `agent-browser`, and print the app URL, the bridge token, the browser identity, and the command to drive it. **Must print a `--key` as a key, never as a session** (`docs/specs/dor-browser.md` → "Managed identity"). **Must leave the browser to the Tool when its own terminal is a Tool** and no session is pinned, printing the Tool's handle.
- **Must give its sidecar a private `AGENT_BROWSER_SOCKET_DIR`**, since the inner app names managed sessions as the installed app does; the harness's own browser keeps the caller's.
- **Must await Vite's own listener before opening the browser and use the actual ports for bridge authentication and CORS**, and **close the bridge and Vite and terminate owned children on startup failure or shutdown**. Pinned by `standalone/scripts/dev-agent-browser.test.mjs`.
- **Must keep logging the Burrow state directory in the form the pairing walkthrough parses**; pinned by `lib/src/lib/mirrored-constants.test.ts`.

The bridge is a transport shim over the same sidecar protocol, not a second PTY implementation: `POST /__dormouse_dev_host/send` and `/invoke`, host→webview events as SSE on `GET /__dormouse_dev_host/events`, and browser console output mirrored to `POST /__dormouse_dev_host/console`. The Burrow rides it too, against a per-run temp state directory.

**The bridge is authenticated**: its gates are `docs/specs/security-local.md` -> "Loopback Listeners". The token is per-run, attached by `BrowserSidecarHost.url()` alone, and **never the `dor` control-API `controlToken`** (rationale); **the CORS origin is never `*`** (rationale). **A CORS preflight is the one carve-out**: `OPTIONS` answers `204` with the CORS headers before the token check.

The harness **may omit** native-only desktop chrome but **must preserve** every `PlatformAdapter` contract the app uses, the sidecar's alerts included (stamped with the one label it simulates, `main`), so a rule that holds only across the host boundary is exercised. **`BrowserSidecarHost.init()` resolves on the SSE stream being open**, so a seed cannot precede the stream that carries its reply; **retryable connection failures reconnect within the open timeout**, and after a reconnect the adapter sends `sync`. It **must mirror** standalone's Session-persistence answer — one `PersistedWindow` per window in `localStorage`, and the same agent-recovery claim against a per-run temp state directory — and never captures (§Agent recovery). **Tauri APIs must not be required at static module-evaluation time** when `VITE_DORMOUSE_BROWSER_DEV_HOST` is set.

Source of truth: `standalone/scripts/dev-agent-browser.mjs`; `standalone/src/browser-sidecar-adapter.ts`.

## Future

- **A setting to allow the Siri affordance**, for users who want Siri in
  Dormouse. The override stays installed and `disallow` reads the setting,
  answering from `WKWebView`'s own implementation when it allows Siri: the
  runtime cannot remove a method, so toggling is a flag, not a second swap.
