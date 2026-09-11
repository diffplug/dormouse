# Dormouse Standalone (Tauri) Integration Spec

> See `docs/specs/glossary.md` for Session / Surface / Pane / Door vocabulary.
> Owns the standalone-specific layer: the Tauri windows, the Rust ↔ sidecar bridge, the AppBar, persistence at the adapter boundary, shutdown ordering, logging, and the build/dev workflow.
> Defers the protocol it speaks — PTY lifecycle, message contracts, persisted-session types, adapter-agnostic invariants — to `docs/specs/transport.md`.
> Evidence and dead approaches: [standalone.rationale.md](standalone.rationale.md).

## Code Map

Start at the runtime boundary involved, then follow its imports and dispatch:

| Entrypoint | Role |
|---|---|
| `standalone/src/main.tsx` | Webview bootstrap, adapter selection, and app composition. |
| `standalone/src/tauri-adapter.ts` | Shared frontend's Tauri command/event bridge. |
| `standalone/src-tauri/src/lib.rs` | Native app entry, sidecar supervision, and command registration. |
| `standalone/sidecar/main.js` | JSON-lines command dispatch into PTY and shared host modules. |
| `standalone/src/window-restore.ts` | Per-Workspace boot planning over one live-PTY list. |
| `standalone/src/quit.ts` | Webview quit orchestration and updater handoff. |
| `standalone/src-tauri/src/routing.rs` | Which window a sidecar event belongs to, and the label bookkeeping. |
| `standalone/src/workspace-move.ts` | Both halves of a Workspace moving between windows. |

## Architecture

**Rust stays thin**: it spawns and supervises the sidecar, bridges the webview to
it, and owns the OS-integration edges (window events, menu, file drop, dock icon,
logging) plus the session file store. All real logic runs in the Node sidecar, on
the same `lib/src/host/` modules the VS Code host runs — `build-sidecar-proxy.mjs`
bundles them into the sidecar's `.cjs` copies, so the two hosts cannot drift.

## Boot sequence

Source of truth: `standalone/src/main.tsx` (`bootstrap()`).

1. Pick the platform: `BrowserSidecarAdapter` when `VITE_DORMOUSE_BROWSER_DEV_HOST`
   is set (the browser-dev harness, `docs/specs/transport.md`), else `TauriAdapter`.
2. `setPlatform(platform)`, then `await platform.init()` **before** the restore —
   init registers the listeners resume replay arrives on and hydrates the session
   cache (§Persistence).
3. `installPeerSurfaceResponder()` **after `init()`, never before** (§Burrow
   service) — the responder seeds itself with a `status` command that the adapter
   must already have listeners for (rationale).
4. `getAvailableShells()` **without awaiting**, so its webview → Rust → sidecar
   round trip overlaps steps 5–6.
5. Tauri branch only: `initQuitFlow(platform)` and
   `setQuitConfirmGate(openQuitConfirm)` (§Quit flow).
6. `initAlertStateReceiver()`, `restoreActiveTheme()` (`docs/specs/theme.md`).
7. `seedShellStore` on the awaited shell list — restores the persisted selection
   (`dormouse:selected-shell`) and publishes it via `setDefaultShellOpts`, the
   default-shell slot for split/spawn/restore (`docs/specs/layout.md`).
   **Awaited**: seeding must finish before the Wall mounts, so the first restored
   pane already spawns with that shell.
8. `restoreWindowOrFresh(platform)` — the per-Workspace boot (§Persistence) over
   the priority-based recovery from `docs/specs/transport.md`.
9. `startUpdateCheck()` (`docs/specs/auto-update.md`), then render `AppBar` +
   `App` with `multiWorkspace` — one Wall per Workspace (`docs/specs/layout.md`
   → Workspaces) — and `enableBurrow`, the mount gate for the lazily-imported
   Burrow UI chunk (§Burrow service); the Burrow itself runs in the
   sidecar regardless. `<ConnectedUpdateBanner />` rides the `baseboardNotice`
   slot, `<QuitConfirmModalHost />` the `dialogHost` slot; both go to the
   visible Workspace's Wall.

## Rust ↔ sidecar bridge

Source of truth: `standalone/src-tauri/src/lib.rs` (`SidecarState`, the
`#[tauri::command]` set, `resolve_sidecar_path`) and
`standalone/sidecar/main.js` (the dispatch table).

The sidecar speaks JSON-lines over stdio: commands in on stdin, events out on
stdout. **stdout is the protocol** — sidecar diagnostics go to stderr, which Rust
appends to the log file.

Webview → Rust is Tauri invokes; the `#[tauri::command]` set and `TauriAdapter`
own the exact command list, most of them thin sidecar forwarders. Three carve-outs
are *not* forwarded:

| Not forwarded | Handled | Why |
|---|---|---|
| `load_session` / `save_session` | Rust | the per-window session file is Rust's store (§Persistence) |
| the `clipboard` readers (Windows only) | Rust (`clipboard_win.rs`) | native Win32 reads (`docs/specs/mouse-and-clipboard.md` §8.6) |
| `agent_browser_screenshot` | Rust reads the bytes from a sidecar-supplied temp-file *path* | images must never ride the JSON-lines pipe shared with PTY traffic (`docs/specs/dor-browser.md`) |

Request/response commands block on the sidecar's reply under a timeout.
`OPEN_PORT_TIMEOUT_MS` and `OPEN_PORT_TIMEOUT_PER_ID_MS` in `lib.rs` mirror the
constants in `lib/src/lib/platform/types.ts` (and `standalone/sidecar/pty-core.js`);
`lib/src/lib/mirrored-constants.test.ts` pins the copies together.

**Blocking commands must be `#[tauri::command(async)]`** — Tauri runs a *plain*
sync command on the main thread, where the `recv_timeout` inside
`request_from_sidecar` / `request_from_sidecar_timeout` stops the webview painting
for the whole round trip, up to `AGENT_BROWSER_TIMEOUT` (30s) (rationale). **The
three clipboard readers included**: their non-Windows branches round-trip through
the sidecar, and the attribute is per command, not per branch. A unit test in
`lib.rs` scans the source and fails on any command that reaches the blocking
helpers without it.

`pty_graceful_kill` (`TauriAdapter.gracefulKillPtys`) SIGTERMs the calling
window's live PTYs (§Windows) and awaits the sidecar's `gracefulKillDone` (echoing the request's
`requestId`; bounded at `timeout + 1.5s`). It resolves one 50 ms grace tick after
the last PTY exits — so ConPTY's late final flush still lands — or at the timeout
for SIGTERM-ignoring programs. **Must forward final output during that grace
period**; the sidecar retains no scrollback. The quit flow's graceful teardown
calls it (§Quit flow), pinned by `standalone/sidecar/pty-core.test.js`.

Sidecar events (`pty:*`, dor control requests, async results) are emitted to the
webview, where `TauriAdapter` converts dor control requests into the
`dormouse:control-request` CustomEvent that `Wall` handles
(`docs/specs/dor-cli.md`, Host Plumbing — including the sidecar env:
`DORMOUSE_NODE`, `DORMOUSE_CLI_*`, `DORMOUSE_CONTROL_*`).

`resolve_sidecar_path` strips Windows `\\?\` verbatim prefixes from
`resource_dir()` once at the boundary so every derived path is plain
(`docs/specs/dor-cli.md`, Bundling And PATH).

### Burrow service

The Burrow — relay socket, enrollment, ACL, pairing ceremony, remote-api v1
— runs **in the sidecar**, never the webview (`docs/specs/relay.md` → "Burrow
side", which owns that split and what the webview keeps): the same
`BurrowService` the VS Code extension host runs, bound by
`lib/src/host/remote/sidecar-entry.ts` and bundled to `sidecar/burrow.cjs`
with the relay-origin allowlist baked in (`docs/specs/relay.md`). **Nothing the
webview says can widen access** (`docs/specs/remote-security-model.md`).

**State.** Rust creates the app-data directory, locks it owner-only, and passes it
as `DORMOUSE_STATE_DIR` (§Persistence, "Rust file store"); `FileBurrowStateStore`
keeps enrollment and ACL there as **one** `burrow.json`, 0600 in a 0700
directory via temp-then-rename — one file, so a write is one atomic rename
(rationale). `burrowToken` is a bearer credential and **never enters a webview
realm**. Against the shared store contract (`docs/specs/relay.md` → "Burrow side"):

- **Reads fail closed.** Only `ENOENT` and a read-but-unparseable file answer
  empty; the parse failure warns. Any other read error is neither answered nor
  memoized — the load rejects and takes the save behind it with it (rationale). A
  later read recovers.
- **The in-memory view advances only after the rename succeeds.** Re-tightening a
  directory Rust already created is best-effort; failing the save over it would
  lose the Burrow instead.
- **`persistent` is declared, never inferred.** With no state directory — Rust
  passes an empty value when it cannot create one — the fallback store still
  *holds* both values in memory, warns once, and reports `persistent: false`. The
  browser dev harness is *not* this case: its per-run temp directory makes a dev
  enrollment live and die with the run.

**The bridge.** Webview → sidecar is one generic passthrough invoke,
`burrow_command(payload)`, writing `{"event":"burrow:command",
"data":payload}` to stdin for the dispatch table's `handleCommand`. Sidecar →
webview is three ordinary stdout events — `burrow:result`, `burrow:ask`,
`burrow:event` — forwarded by Rust's generic `handle.emit`. **The correlation
field is `burrowRequestId`, never `requestId`**: Rust swallows any sidecar line whose
`data.requestId` matches a pending invoke (rationale). Everything above those
shapes is the shared `link-client.ts` (`docs/specs/transport.md` → Message
protocol).

**Asks and answers.** What the sidecar cannot know — a pane's name, its focus, its
xterm size — it asks over `burrow:ask`, and
`lib/src/remote/burrow/peer-surfaces.ts` answers as an ordinary `answer` command
naming the ask's own `burrowRequestId`. **An ask collects one answer per window**
and concatenates them: each window sees only its own Workspaces, so a directory
built from the first answer would omit every other window's panes. **The
collector is keyed by which window answered, never by how many have** — Rust
stamps the sending window's label on every `burrow:command` it forwards — so a
window answering twice can settle nothing and contributes its panes once. **Rust
pushes the live window labels** (`burrow:windows`) at setup and on every window
create and destroy, and **dropping one settles the asks that window can no longer
answer**; an ask in flight is only ever *narrowed*, since a window that opened
after it never received it. **An ask naming a `surfaceId` goes to that Surface's
owner alone** — `attach` and `resize` mutate the pane they reach, and fanned out
they ask every other window to resize one it does not hold — and Rust names the
window it delivered to (`burrow:askDelivered`) so the collector settles on that
one answer instead of spending the budget on windows the ask never reached. `ASK_BUDGET_MS` (1s) still bounds the whole fan-out,
and whatever did answer is still the best available snapshot.

**An answer for an ask the bridge no longer holds invalidates the directory**
rather than being dropped (`docs/specs/remote-api.md` → Directory).

**The sidecar owns the parse**, standalone's only one
(`docs/specs/terminal-escapes.md` → Parsing location, which owns the rules): a
`pty-core` `data` event reaches the webview as the `pty:data`,
`terminal:semanticEvents` and `terminal:protocolEvents` the bridge emits, never
raw, and every attached Client reads the same parse. **The webview pushes its
resolved terminal colours** (`pty_theme_colors` → `pty:themeColors`) because this
process has no DOM; **null before the first push falls a colour query through to
xterm.js**, and **a malformed push is ignored, never half-applied.**

**A remote sink must never break the local pipe.** The tap sits inside
`pty-core`'s event callback in `main.js` and is wrapped: a throw is logged to
stderr and every non-`data` `pty:*` event goes out either way. Inside the parse,
**each sink is guarded, and so is the reply write ahead of them** — a PTY that
died since the read throws — so nothing can cost the webview its `pty:data`.
Exit codes are
retained so a stream installed after surface resolution can replay liveness
before attach acknowledgement, and **a spawn or an exit retires that PTY
generation's parser** so a half-read sequence cannot splice onto the next one.

Source of truth: `lib/src/host/remote/service.ts`,
`createSidecarSurfaceBridge` in `lib/src/host/remote/sidecar-entry.ts`,
`standalone/sidecar/main.js` (the tap and the `burrow:command` case),
`burrow_command` / `burrow_state_dir` / `pty_theme_colors` in
`standalone/src-tauri/src/lib.rs`.

### Windows node subsystem

On Windows the app carries **two** subsystem variants of the same `node.exe`,
because the sidecar and the `dor` CLI have opposite console requirements:

- **The sidecar must run under a GUI-subsystem node**, or Win11's DefTerm handoff
  flashes a stray Windows Terminal window behind Dormouse (rationale). `build.rs`
  patches the bundled `node.exe` at build time (`force_windows_gui_subsystem`),
  and the sidecar's explicit piped stdio works fine under it.
- **`dor` must run under a console-subsystem copy.** A GUI-subsystem node does not
  attach to an *inherited* console, so it silently drops everything `dor` prints
  inside a shell's ConPTY (rationale). `start_sidecar` derives the copy once
  (`resolve_dor_node_path` →
  `ensure_console_subsystem_node`, flipping the PE subsystem byte back, cached in
  app-local data and re-derived when the bundled node's size changes) and points
  `DORMOUSE_NODE` at it. `dor` always runs inside an existing pseudo-console, so
  that copy can never cause a stray window.

The byte-flip lives in `standalone/src-tauri/src/pe_subsystem.rs`, shared with
`build.rs`, so the load-bearing PE offsets are in one place; the mechanism is in
the comments at `force_windows_gui_subsystem` and `resolve_dor_node_path`.

## Sidecar lifecycle

Source of truth: `standalone/sidecar/main.js`.

Shutdown (`sidecar:shutdown` message, stdin EOF, or SIGTERM) is **idempotent and
ordered**:

1. `agentBrowser.closePoppedOut()` under a 1.5s race — quitting must not orphan a
   headed Chrome window, and a hung agent-browser must not wedge the exit (as in
   the VS Code host's `deactivate()`; `docs/specs/dor-browser.md`).
2. Close the dor control socket.
3. Dispose the Burrow service, dropping the relay socket and settling every
   outstanding ask so nothing waits on a webview that is going away.
4. `mgr.killAll()` (all PTYs), then `process.exit(0)`.

**A parent-PID watchdog polls every 2s** and self-triggers shutdown if the Tauri
process disappears: stdin EOF is not always delivered when the host is
force-killed, and an orphaned sidecar keeps `conpty.node`/`conpty.dll` loaded and
blocks the NSIS installer (`docs/specs/auto-update.md`, Sidecar teardown on
Windows).

Burrow-side ordering: every quit trigger is driven through the webview quit
orchestrator (§Quit flow, which owns the teardown/install/exit sequence); Tauri's
`RunEvent::Exit` then runs `shutdown_sidecar_and_wait` as a final backstop
(harmless post-teardown — the PTY map is already empty, so `killAll` no-ops).

## AppBar

Source of truth: `standalone/src/AppBar.tsx`.

The AppBar is the draggable titlebar region, carrying left to right the
**Workspace strip** and — Windows/Linux only, since macOS gets native traffic
lights from `titleBarStyle: "Overlay"` and left padding instead — the window
controls (minimize / maximize / close via `@tauri-apps/api/window`, dimmed by
window-focus tracking). **Neither a theme picker nor a shell picker belongs here**:
both live in the Settings dialog at the bottom-right of the window
(`docs/specs/theme.md`).

The strip is one tab per Workspace: click activates, double-click renames,
middle-click or the tab's `×` closes, `+` creates, and a drag past the shared
threshold reorders. Behavior is `docs/specs/layout.md` → Workspaces and its
indicators `docs/specs/alert.md` → Workspace union; tabs shrink to a floor and
then the strip scrolls, with no overflow arrows.

- **Never put `data-tauri-drag-region` on a tab or anything inside one.** Tauri
  matches that attribute on the event target alone, so a tab carrying it would
  drag the window instead of activating, renaming, or reordering. **A dedicated
  spacer after the strip carries it, with a minimum width**, so the window stays
  draggable at every tab count and the strip scrolls into what is left.
- `onDragOutsideWindow` / `onDropOnOtherWindow` carry the drag past the strip's
  own edge (§Tear-out, and dragging between windows); the browser-dev harness
  supplies neither, because it has no windows.

Source of truth: `WorkspaceStrip` in `lib/src/components/WorkspaceStrip.tsx`;
`createWorkspaceStripDrag` in `lib/src/components/workspace-strip-drag.ts`.

Shell selection lives in the Settings dialog's **Shell** row
(`lib/src/components/ShellPicker.tsx` over `lib/src/lib/shell-store.ts`), hidden
when fewer than two shells were detected or when the host owns shell selection
itself (`hostOwnsShells`, VS Code). Picking one persists the choice in
`localStorage` under the shell's full identity, publishes it via
`setDefaultShellOpts`, and dispatches `dormouse:new-terminal` with
`replaceUntouched: true, announce: true` (`docs/specs/layout.md` → "Session
lifecycle and terminal registry", Shell selection replacement) — after dismissing
the dialog, so the replacement takes keyboard focus on the next animation frame.
Edge cases:

- A legacy path-only selection restores the first matching entry and gains the
  full identity on the next choice.
- Re-picking the visible fallback records that explicit choice without spawning a
  redundant terminal.
- Re-seeding an unchanged detected list is a no-op: it preserves an interactive
  selection but also skips re-reading the persisted key (`seedShellStore`'s
  comment carries what that costs Storybook).

### Application menu

Source of truth: the `.menu(...)` builder in `standalone/src-tauri/src/lib.rs`.

The app replaces Tauri's default menu with a macOS-only App submenu (about /
services / hide / hide-others / quit) and a Window submenu (minimize / maximize /
close). **No Edit submenu** — its predefined Paste item binds Cmd+V natively and
would fire alongside the terminal's own DOM-level Cmd+V handling
(`docs/specs/mouse-and-clipboard.md` §8.2). macOS therefore delivers Cmd+C/X/V to
the webview as plain keydowns and WKWebView performs no native edit, in Dormouse's
own text fields too; JS supplies their clipboard
(`docs/specs/mouse-and-clipboard.md` §8.9). **A new menu item must not claim a
chord the webview already handles.**

## Windows

**Several windows, each with several Workspaces, over one sidecar**
(`docs/specs/glossary.md`). The sidecar has no window concept, so **Rust owns
the map from PTY to window** and every stdout line passes through it.

**The label is the window's persistence identity**: `main` for the first window
(fixed in `tauri.conf.json`), `ws-<n>` for every later one, seeded above every
live label *and* every `sessions/ws-*.json` on disk so a new window can never
claim a saved one's file. `standalone/scripts/tauri-conf.test.mjs` pins the
label.

**Every new window is cloned from `app.windows[0]`** (`WebviewWindowBuilder::from_config`),
so `titleBarStyle`, `hiddenTitle`, `dragDropEnabled` and the CSP carry across
with no second copy of any of them.

**Capabilities are split**: `default.json` covers `main` and the `ws-*` glob,
and `main-only.json` scopes `updater:default` and `core:app:allow-version` to `main`,
which structurally enforces that the install runs in the window the walk tears
down last (`docs/specs/auto-update.md`). Custom commands need no capability
entry. `standalone/scripts/tauri-conf.test.mjs` pins both.

### Workspace registry

**Rust holds the union of every window's Workspaces**, since each webview's
store (`lib/src/lib/workspace-store.ts`) sees only its own. Each window reports
its list on every change, coalesced per microtask, and the union is broadcast as
`dormouse://workspaces` with a monotonic `revision`; a webview drops a snapshot
behind the one it holds.

- **Must mint numbered ids only in Rust**, `workspace-<n>` off one counter, handed to a
  webview in blocks (`workspace_reserve_ids`) so a create mints synchronously.
  The ref `workspace:<n>` is the id's number, so it never renumbers and never
  collides across windows; an unused reservation is a gap, nothing more.
- **Must allow boot and creation when reservation fails**, using opaque UUID
  ids until the pool recovers; log the failure. Canonical refs follow
  `docs/specs/dor-cli.md` → "Handle Model" (`workspace-store.test.ts`).
- **The counter is seeded above every id any snapshot on disk names**, and
  above every id a window reports, so a fresh id never meets a restored one.
  Never below 2: `workspace-1` is a bare Wall's only Workspace.
- **A `dor` request naming a Workspace or Window routes to the window holding
  it** (§Routing precedence). A target the registry cannot place — one no
  window reports, or a name two windows carry — falls through to the caller's
  window, which refuses a name duplicated there and otherwise resolves its own,
  so a local Workspace wins. **A target routes as a number only when it reads
  as `POSITIONAL_WORKSPACE_REF`** (`dor/src/protocol.ts`); `007` and `0` are
  names (`a_number_with_a_leading_zero_is_a_name`).
- **`Destroyed` forgets the window's entries** and broadcasts.

Source of truth: `standalone/src-tauri/src/workspaces.rs`;
`workspace_reserve_ids` / `workspace_report` / `workspace_registry` in
`standalone/src-tauri/src/lib.rs`; `installWorkspaceRegistry` in
`standalone/src/workspace-registry.ts`; `installWorkspaceIdPool` /
`workspaceRefFor` in `lib/src/lib/workspace-store.ts`. Pinned by the tests in
`standalone/src-tauri/src/workspaces.rs` and
`an_explicit_target_routes_to_the_window_holding_it`.

### Routing

Source of truth: `route` in `standalone/src-tauri/src/routing.rs`,
`dispatch_sidecar_event` in `standalone/src-tauri/src/lib.rs`.

| Sidecar event | Key | Goes to |
|---|---|---|
| `pty:data` | `data.id` | its owner; dropped while the id is mid-transfer, its bytes being in the replay |
| `terminal:semanticEvents` | `data.id` | its owner; dropped while the id is mid-transfer — the target re-derives them from the raw replay, feeding both pane state and its `AlertManager` (rationale) |
| `terminal:protocolEvents` | `data.id` | its owner; **held** while the id is mid-transfer and delivered, in order, behind the replay, which rebuilds none of them; at most `HELD_EVENTS_MAX` (256) per id, overflow dropping the oldest (`held_events_come_back_in_order_and_bounded`) |
| `pty:exit`, `pty:replay` | `data.id` | its owner, never suppressed |
| `pty:list` | `data.forWindow` | the window that asked |
| `alert:*` carrying `data.id` | `data.id` | its owner |
| `dor:controlRequest` | `params.workspace`, `params.window`, `data.surfaceId` | in that precedence: the window holding the named Workspace (§Workspace registry), the named window, the caller's Surface's owner; none → the focused window |
| `dor:controlCancel` | `data.requestId` | the window its request went to; unknown → every window |
| `burrow:ask` | `data.params.surfaceId` | its owner; a Surface with no PTY here, or an ask naming none, → every window (§Burrow service) |
| everything else | — | every window |

- **Ownership is minted only in `pty_spawn`**, dropped by `pty_kill`, an exit,
  or the window going away, and reassigned by a transfer. Minting also clears any
  suppression left under that id: no replay is coming for a fresh PTY.
- **A PTY event no window owns is dropped, and the shell is reaped.** Every PTY
  is minted with an owner, so an unowned id is one whose window went away;
  broadcasting rang every sibling's AlertManager for a pane none of them shows.
  `Destroyed` SIGTERMs whatever the departing window still owned, which is what
  the close ack-timeout path never killed.
- **A `dor` request naming a Surface no window owns is answered with an error**,
  never handed to a sibling — acting on the wrong terminal is worse than failing
  (`docs/specs/dor-cli.md` → Standalone).
- **`pty_request_init`, `pty_graceful_kill` and `capture_agent_recovery` target
  the invoking window's own PTYs**, and take no ids at all: a window tearing down
  must not interrupt or kill a sibling's terminals, and a set it could name is a
  set it could name wrong. `pty_request_init` further excludes what an arrival
  claims (§Arrival queue).
- **A `dor` cancel follows its request**: only the window handling it holds the
  subscription, watch or completion claim the cancel releases. Rust remembers
  which window took each `requestId` and forgets it on the response.
- **Every webview listener names its own window.** Tauri delivers an `emit_to`
  event to any listener registered with the default `Any` target, so a bare
  `listen` would take every other window's traffic and make this whole table
  decoration (rationale). `listenToWindow` in
  `standalone/src/window-label.ts` is the only caller of the event API, pinned
  by `standalone/scripts/window-listeners.test.mjs`.
- **The focus order is the fallback owner** for a `dor` request naming no
  Surface, and the drag hit test's stand-in for a z-order the OS does not expose.

### Boot and geometry

**Boot reopens every window `sessions/` names**, `main` first (already up from
the config) then each `ws-<n>` in numeric order, capped at
`MAX_RESTORED_WINDOWS` (8) with the excess logged and left on disk. **An
unreadable snapshot still opens its window** — the webview boots fresh, which is
a window the user can use rather than one they lost. **`main` is focused last**,
so it comes up in front. **A session naming no `main` relaunches with a fresh,
empty `main`** — the config creates it unconditionally — focused last, in front
of the restored `ws-*` windows.

**Geometry is a sibling of the snapshot**, `sessions/<label>.geometry.json`,
written through the same `write_file_atomically` and debounced past the flood a
window drag produces; `main`'s box is re-applied to the window the config
created. No `tauri-plugin-window-state` (rationale).

**The live box is cached from the window events themselves** — `Moved` and
`Resized` carry it — and read from that cache by both the debounced write and
the cross-window drag hit test, which probes ~16 times a second. The platform is
asked only once per window at creation, and for the minimized and scale-factor
checks in the debounce flush.

- **Never ask the platform anything while holding the rect cache.** Off the main
  thread `scale_factor()` and `is_minimized()` park on the event loop, which the
  main thread may be driving while it waits inside `window_at_cursor` for that
  same lock. The flush reads both first and hands the scale to `refresh_rect`,
  whose signature takes no window at all.
- **The flush slot is released in the same step as the drain.** A `Moved` landing
  between the two was marked dirty with no thread left to write it — and that
  move is exactly a window's final position.

Source of truth: `CachedRect` / `GeometryState` / `note_geometry` /
`restore_windows` in `standalone/src-tauri/src/lib.rs`; the sequencing is pinned
by `the_geometry_flush_slot_is_released_with_the_drain`.

### What a window's `Destroyed` settles

**Everything keyed by a label is settled in the `Destroyed` arm, and only
there**: Tauri takes the label out of `webview_windows()` at that moment and not
before, so a `burrow:windows` push sent ahead of it names a window that can never
answer — and every ask then waits out its whole budget. The arm forgets the
window's PTY ownership and reaps what it still owned, hands back every arrival it
will never take (§Arrival queue), drops the save refusal (nothing can save under
a dead label), forgets its geometry, tells the quit machine (§Quit flow) and
pushes the live labels to the sidecar. **An arriving Workspace's shells are taken
out of the reap first**: they belong to its source again, which is still showing
those terminals.

### Per-window close

**Closing a window with siblings alive ends that window alone**; only the last
window's close is the quit. Rust prevents the close and emits
`dormouse://window-close-requested`; the webview acks (a ~2 s watchdog closes it
anyway if that listener is dead), asks about *its own* running work, archives
*its own* notes, removes its snapshot, kills the PTYs it owns, and calls back
`close_window`.

- **A close is deliberate, so it archives and it removes the blob** — geometry
  and temp sibling included — and the next launch does not reopen the window.
  A quit keeps every blob, which is the whole difference.
- **It runs no agent-recovery capture**: nothing is coming back.
- **A cancelled close retires its watchdog's token and never reuses it**: the
  next close on that window is a fresh seq, so a watchdog still sleeping on the
  cancelled one cannot destroy the window under the second dialog
  (`a_cleared_close_never_hands_its_seq_to_the_next_request`).
- **It confirms on a pending download as well as on running work.** An approved,
  downloaded update lives in this webview's memory, so closing the window throws
  it away and nothing else can install it (`docs/specs/auto-update.md`).
- **The snapshot is removed before the kill**, and Rust refuses every later save
  for that label, so a PTY exit's save cannot write it back. **Both close paths
  set that refusal** — the webview's own `remove_window_session`, and
  `finish_window_close` for the ack-timeout path, where the webview never ran at
  all. It is dropped when the webview is destroyed and can no longer save.
- **`close_window` is the one Rust half both endings share** — a deliberate close
  and a window whose last Workspace moved away (§Transfer) — because what
  separates them is entirely what the webview did before calling it.
- **macOS keeps its rule**: closing the last window quits.

**The ack, confirm and archive gates are one shared flow with the quit**
(`createTeardownFlow` in `standalone/src/teardown-flow.ts`); what differs is only
the step past them — a quit votes and waits its turn in the walk, a close tears
down at once.

**Arbitration.** They are two machines over one window, one dialog and one
human, and **a second flow is never refused in silence**: an unsettled context
parks its own flow and leaves its host waiting out a decision that cannot come.

| Arriving | Holder | Outcome |
|---|---|---|
| quit | a close still on its dialog | the close is cancelled (`window_close_cancel`); the quit takes over |
| quit | any committed flow | the quit acks and **votes** — this window is ending anyway, and a window that never votes holds the machine in `Voting` with no dialog to answer |
| close | a quit, in any state | refused at once with `window_close_cancel`; the window stays |

**A committed flow that retreats and is then cancelled re-drives the quit it
took the vote for.** `archive-failed` is a committed close asking a human about
notes it could not store, and declining there leaves the window standing with the
quit's own question never asked. **The re-drive gates the intent once**: it
re-enters the quit's `request` from inside the close's cancel, and the trigger
that caused it returns without gating again. **A quit cancelled elsewhere
forgets what it deferred**, so a later retreat cannot re-open a quit Rust has
abandoned.

**A quit cancelled elsewhere drops only a quit's dialog**, never this window's
own close question. The confirm store cancels any context it cannot open, as the
backstop. Both orderings are pinned by
`standalone/src/teardown-arbiter.test.ts`.

Source of truth: `standalone/src/window-close.ts`; `request_window_close` /
`finish_window_close` in `standalone/src-tauri/src/lib.rs`.

### Transfer

**A Workspace moves between windows without ending anything.** Nothing is
archived and no process is killed: a move is not a closure.

The protocol and every failure path are §Arrival queue; what a move *is*:

- **A window whose last Workspace left closes itself**, with no confirmation, no
  archive and no kill: nothing ended.
- **A pane's helper Session travels with it.** A helper is not a member Surface,
  so nothing else in the payload names it, and one left behind is a leaked shell
  plus a stray pane on the source's next reload. It rides directly after its
  source, which is what lets the target's resume re-parent it.
- **An arrival whose PTYs never answer is refused, never cold-restored.** A
  timed-out collection is not a collection that found nothing: those shells are
  still running, and restoring from the record would start a second set over
  them (`docs/specs/transport.md` → "Reconnection").
- **A Workspace that comes back must mount from the record it brought**, never
  the plan it first booted with, or a fresh pane lands over the Sessions that
  just arrived.

Source of truth: `prepareWorkspaceTransfer` in
`lib/src/components/wall/workspace-transfer.ts`, `standalone/src/workspace-move.ts`,
`transfer_workspace` in `standalone/src-tauri/src/lib.rs`.

### Tear-out

**A tear-out opens the window positioned so the dragged tab lands under the
cursor**, at the source window's size. Its first flush writes
`sessions/ws-<n>.json`, and from there it is an ordinary restorable window.
Everything else is the transfer above.

### Arrival queue

**An arrival is one transaction keyed by `workspaceId`**, carrying
`{ from, to, workspace, notepad, terminalIds }`. Rust holds the record from the
source's invoke until the target adopts the Workspace or dies, and every step
below reads that record rather than inferring itself from the suppression map.

1. **Source** prepares the Workspace, touching nothing, and invokes
   `transfer_workspace` / `open_workspace_window`. On `Ok` it marks the Workspace
   **transferring**: the Wall stays mounted and the notes stay put, nothing is
   released, and `getWindowSnapshot` omits it.
2. **Rust** reassigns `terminalIds` to the target and suppresses their output
   until each one's replay has been emitted there; the sidecar buffers a chunk
   before it emits and Rust's reader is one ordered thread, so a chunk in the gap
   is dropped once and replayed once (rationale). It queues the record and nudges
   the target with `workspace-arriving` carrying nothing — a new window has no
   listener, so its payload is pulled at boot instead.
3. **Target** drains with `take_arrivals` and, per arrival, arms its collector
   *before* calling `adopt_ready(workspaceId)` — the hop that removes the whole
   "arrived before armed" class of bug (rationale). Rust answers
   `pty:requestInit` with **that arrival's ids and no others**; `pty:list` and
   each `pty:replay` echo the collector's token. The target resumes over them,
   hydrates the notes and mounts the Workspace at the drop index.
   **Must seed persisted alerts before requesting replay**, so the older state
   cannot erase WATCHING rebuilt by replay (`standalone/src/workspace-move.test.ts`).
4. **Target adopted** invokes `adopt_done(workspaceId)`. Rust retires the record,
   clears what is left of the suppression, and emits `workspace-departed` for
   **that Workspace alone** to its own source.
5. **Source** commits on `workspace-departed`: releases every Session (never
   kills one), drops the notes and the helper, closes the Workspace, and closes
   the window if it was the last one (§Transfer).

- **Nothing is released before the target has adopted it.** The target can refuse
  the arrival or close before taking it, and a Workspace released at the invoke
  had no Sessions and no window that owned them.
- **A transferring Workspace is in no snapshot its source writes, and neither
  end's teardown kills or interrupts its shells.** They belong to the target by
  ownership from the invoke, and the target's `pty_graceful_kill` and
  `capture_agent_recovery` exclude every id an arrival claims (`boot_list_ids`),
  since the source is still showing them. A quit or a close in the gap would
  otherwise persist the same Workspace in two windows, or kill it under the
  source.
- **Must await `adopt_done` before installing a torn-out Window; refusal releases
  its resumed Sessions and notes and boots fresh.**
- **A refused `adopt_done` unwinds the mount.** The `ARRIVAL_MAX` watchdog has
  already handed the shells back and the source kept the Workspace, so the
  target releases its Sessions (never kills them), drops the notes, and closes
  the Workspace rather than leaving it live and persisted in two windows.
- **A refused arrival hands the shells back.** The target's `adopt_failed`
  (a `planArrival` timeout, a missing list, a mount error) and a target
  `Destroyed` with the arrival still queued both return `terminalIds` to the
  source unsuppressed, drop the record, and emit `workspace-arrival-failed`; the
  source clears **transferring** and the Workspace is simply still there. With
  both ends gone the shells are reaped rather than left owned by a dead label.
  **The gap is lost on a hand-back**: suppressed from the invoke with no replay
  to follow, it is the one path nothing recovers.
- **`planArrival` never throws into `bootstrap()`.** A refused sole arrival on
  the boot path renders a fresh one-pane Workspace, never a blank window.
- **`take_arrivals` does not consume.** The record settles at `adopt_done`, so a
  webview that drains at boot and again when its listener is installed cannot
  lose a Workspace to a drain that happened too early; the webview dedupes by id.
- **A window with a snapshot boots as itself**, mounting whatever was dropped on
  it mid-boot over the restore rather than instead of it.
- **`AWAITING_REPLAY_MAX` fails open only for suppressions no arrival claims.** A
  cold boot slower than it would otherwise have a real arrival's shells
  unsilenced into a window that has not resumed them yet.
- **A boot's `pty_request_init` excludes every id an arrival claims.** Ownership
  moves at the invoke, so those shells would otherwise be listed as top-level
  panes beside the Workspace about to mount them.
- **`begin_arrival` records the arrival in `sessions/arrivals.json`** — a JSON
  array of `{ workspaceId, from, to, workspace }`, never an entry in either
  window's snapshot (rationale). **Must retain an adopted record until target
  and source snapshots both reflect the move**, marking it settled at
  `adopt_done` and checking after each `save_session` or source-window close
  (`adoption_keeps_the_journal_until_both_snapshots_are_durable`). Every hand-back path
  (`adopt_failed`, the target's `Destroyed`, the watchdog, a failed
  `build_window`) drop the record; a record left at boot is merged into its
  target's snapshot before `restore_windows` — a tear-out target gets a file
  holding just it, active; a source snapshot still naming the id loses it, an
  emptied one is removed — so the Workspace restores once, with fresh shells,
  and successful records are deleted; **must retain failed records for retry
  and roll back the target if trimming the source fails**. **Must preserve a
  settled arrival’s newer target record during boot recovery**
  (`an_arrival_record_round_trips_until_it_is_forgotten`,
  `a_leftover_arrival_boots_into_an_existing_target_snapshot`,
  `a_leftover_arrival_boots_into_a_tear_out_targets_new_snapshot`,
  `a_leftover_arrival_leaves_a_source_snapshot_that_still_names_it`,
  `the_arrivals_file_is_gone_after_the_boot_merge`).
- **An arrival unadopted after `ARRIVAL_MAX` is handed back** by a watchdog armed
  at `begin_arrival`, retiring only the record it was armed for (`queued_at`):
  a target alive but wedged never reaches `adopt_failed` or `Destroyed`, and the
  source would otherwise stay transferring with its shells silent for good
  (`an_expiry_retires_only_the_record_it_was_armed_for`).

Source of truth: `Arrival` / `sweep_awaiting` / `expire_arrival` / `boot_list_ids` in
`standalone/src-tauri/src/routing.rs`; `begin_arrival` / `adopt_ready` /
`adopt_done` / `adopt_failed` / `hand_back_arrival` / `record_arrival_on_disk` /
`forget_arrival_on_disk` / `restore_arrivals` in
`standalone/src-tauri/src/lib.rs`; `standalone/src/workspace-move.ts`;
`markWorkspaceTransferring` in `lib/src/lib/window-session-aggregator.ts`.
Pinned by `standalone/src/workspace-move.test.ts`, the disk tests in
`standalone/src-tauri/src/lib.rs`, and the arrival tests in
`standalone/src-tauri/src/routing.rs`.

### Dragging a Workspace between windows

**A pointer captured on a strip tab keeps delivering `pointermove` and
`pointerup` outside the window**, so the gesture stays the webview's and the
host is only asked where the cursor is (rationale). Past the strip edge the host
throttles a `window_at_cursor` probe (~60 ms) and lights a drop caret in
whichever window is under it; **the release transfers there, or tears out when
the cursor is over no window or over this window outside its own strip**.

**Among windows containing the cursor the most recently focused wins** — the OS
exposes no z-order — and the caret is what makes a wrong guess visible before
the release. **The target decides the drop index**: it alone knows its own tabs.

- **The throttle probes the trailing edge too**: the leading one never sees where
  the pointer came to rest, which is the position the drop uses.
- **A probe answering after the gesture is ignored**, or it re-lights a caret in
  a window the drag has already left, where it would burn until the next one.
- **The caret clears when the pointer comes back over its own strip**, where the
  live reorder takes the gesture back.

Source of truth: `window_at` in `standalone/src-tauri/src/routing.rs`;
`standalone/src/workspace-drag.ts`; `standalone/src/workspace-drop-caret.ts`.

## Persistence

**Standalone persists one `PersistedWindow` per window** and restores every
Workspace in it on the next launch (`docs/specs/transport.md` → "The governing
rule"). The webview owns the composition: each Workspace's Wall publishes its
`PersistedSession` to the Window aggregator, whose one debounced writer is
`TauriAdapter.saveWindowState` (`docs/specs/transport.md` → "Persisted session
types"). `getWindowState` is the boot reader, and it **parses the blob once** —
the store behind it is a boot-seeded cache and every later write comes through
`saveWindowState`. The bare-Session `saveState` / `getState` pair answers nothing
on either standalone adapter, because the stored blob is a Window and every
shared reader of `getState` wants a Session. Source of truth: `windowStateSlot` in
`standalone/src/window-recovery.ts`.

**Boot restores per Workspace off one live-PTY list.** `restoreWindowOrFresh`
seeds the aggregator, installs the Workspaces and the
writer, then runs one `collectLivePtys` and plans each Workspace from its own saved
record. Reload and relaunch are the same path with a different list: nothing wires
`shutdown()` to `beforeunload`, so a reload's PTYs are still there and partition by
saved pane id, while a relaunch's list is empty and every Workspace cold-restores
into fresh shells at its saved cwds.

- **A live PTY no saved Workspace names goes to the active Workspace**, which is
  the only one that can hold it — **except a helper**, which is never a persisted
  pane and so is always unnamed. **A helper is routed to the Workspace holding its
  source**, resolving parents across the whole live list before any slicing; one
  landing anywhere else is resumed as an ordinary pane and its stray id voids that
  Workspace's whole saved layout.
- **A restore that throws degrades to a fresh Window and overwrites the blob.**
  Installing the Workspaces is the step that can reject a stored blob outright, and
  a throw at boot would leave nothing rendered, on this launch and every later one.
- **A fresh Window mints its first Workspace's id**, rather than taking the lib's
  `DEFAULT_WORKSPACE_ID`, which every window would otherwise start on: a second
  window opened after the first one closed would write a blob naming a Workspace
  id already live in another window's blob, and the next launch would meet the
  same id twice and refuse the whole restore. A bare Wall — one Window's whole
  application — keeps the default id (`standalone/src/window-restore.test.ts`).

Source of truth: `restoreWindowOrFresh` / `routeUnownedPtys` in
`standalone/src/window-restore.ts`.

**Every Workspace saving at the same moment costs one `pty_get_cwds`.** A flush
fans out to every Wall at once, so both adapters put their cwd probe behind
`coalesceCwds` (`standalone/src/coalesce-cwds.ts`), which folds the calls arriving
in one microtask into a single invoke — the same batching `getCwdsForPids` already
does one layer down, extended across the callers.

**A listing that spans terminals costs one `pty_get_open_ports_many`.** Both
adapters carry it, and the sidecar answers every id from one process-table read
and one socket scan (`getOpenPortsForPids`) — the scans are synchronous on its
only event loop, so a `dor list --ports` across Workspaces must not multiply them
by its row count (`docs/specs/dor-cli.md` → "Current Implemented Commands").
**Must follow `docs/specs/transport.md` → "Port scan deadlines" for both port commands.**
The macOS socket scan runs under
`OPEN_PORT_TIMEOUT_MS + OPEN_PORT_TIMEOUT_PER_ID_MS × ids`, and the command waits
that plus the process-table read's `OPEN_PORT_TIMEOUT_MS` and IPC margin — one terminal's cap
never bounds the whole Window (`open_ports_many_timeout` in
`standalone/src-tauri/src/lib.rs`). **A macOS socket scan keeps the rows `lsof`
printed before a non-zero exit** — a pid gone mid-batch would otherwise empty
every terminal's answer, as `getCwdsForPids` already guards.

**Nothing is deleted at boot but orphaned session temp files**
(`docs/specs/transport.md` → "Retiring the transcripts already on disk"). **The
harness mirrors this answer** (`docs/specs/transport.md` → Standalone browser-dev
harness), in `localStorage` and a per-run temp state directory.

**Never back the session blob with WebKit `localStorage`** — a WAL that grows
without bound (rationale). The blob rides the `SessionKeyValueStore` seam instead,
over the Rust-backed `standalone/src/tauri-session-store.ts`. Theme selection
still persists on `localStorage` (`docs/specs/theme.md`) — tiny and rarely
written.

**Rust file store.** `save_session(window, state)` / `load_session(window)`
(`lib.rs`) persist the blob as one atomic file per Tauri window,
`<state root>/sessions/<label>.json`:

- **The label is sanitized** so it cannot escape the directory.
- **Temp-then-rename**, so a crash cannot truncate the previous snapshot. The temp
  file is fsynced before the rename and, on unix only, the sessions directory
  *after* it (rationale).
- **Window identity is implicit**: each command keys by the invoking
  `tauri::Window`'s `label()`, so the frontend stays window-agnostic and every
  window (`ws-2`, …) persists to its own file rather than rewriting a sibling's.
- No WAL to grow, and rewriting the same path bounds the on-disk size to one
  blob (rationale).
- **The writer removes its own temp file on every error path**, so only a crash
  can leave one behind.
- **A per-window close removes the blob, its temp sibling and its geometry**
  (§Per-window close); nothing else deletes a snapshot but the boot merge
  (§Arrival queue).
- **`sweep_orphan_session_temps` runs once in `setup()`** and deletes every
  `<label>.json.tmp` — the legacy and hard-crash migration, given the rule above.
  `SESSION_TEMP_SUFFIX` is pinned against the writer by
  `session_temp_suffix_matches_what_the_writer_leaves`, so the two cannot drift.
  It **never touches a live snapshot**.

**The state root is `<app_data_dir>`, or `<app_data_dir>/dev` under
`cfg(debug_assertions)`.** `app_data_dir()` is keyed by the Tauri identifier, so a
`pnpm dev:standalone` run and the installed app resolve to the same directory:
without the split a dev launch would restore the installed app's Workspaces and the
two would clobber one snapshot. **The notepad archive and the Burrow state directory
stay under `app_data_dir` itself** — machine-local stores, not this build's copy of
the user's window. `state_root_from` in `standalone/src-tauri/src/lib.rs`.

**Rust passes the sidecar its two directories by environment**, each created
owner-only first and each an empty string when it could not be:
`DORMOUSE_STATE_DIR` (the Burrow store, `app_data_dir`) and
`DORMOUSE_RECOVERY_DIR` (the recovery record, the state root — so a dev run's
record cannot reach the installed app). The browser-dev harness sets both to its
own per-run temp directory. Source of truth: `recovery_state_dir` in
`standalone/src-tauri/src/lib.rs`.

### Agent recovery

**The sidecar owns the capture and the record** (`docs/specs/transport.md` →
"Consuming it"): it holds the replay buffers the detection reads, and its lifetime is
exactly one activation, so read-and-unlink has one home. Rust only bridges —
`capture_agent_recovery` and `take_recovery_commands`, both
`#[tauri::command(async)]` like every command reaching the blocking sidecar helper.
**Every sidecar answer rides `respondAsync`**, so a throw comes back as `{ error }`
rather than stranding the Rust invoke to its timeout.

- **The record is `<state root>/recovery.json`**, owner-only, temp-then-rename,
  written on every detection rather than once at the end, because the quit budget
  can end the capture at any instant.
- **`beginCapture` clears the previous record once per sidecar process and merges
  after**, so a teardown that captures nothing cannot carry a stale record forward
  and a second window's capture cannot wipe the first's.
- **`take` is claimed once**, started by `TauriAdapter.init()` for every pane id
  across the saved Window's Workspaces. `init()` does not await it: the boot
  awaits `recoveryReady` before planning, and only on the branch that can
  cold-restore, so the round trip overlaps the rest of boot.
- **Without a state directory the store is memory-only**, warning once.

Both the detection (`lib/src/host/recovery-capture.ts`) and the record store
(`lib/src/host/recovery-store.ts`) are shared with the VS Code extension host
(`docs/specs/vscode.md` → "Capturing agent recovery"); the primitives the detection
runs on — `liveIds`, `receivedChars`, `outputSince` — are
`standalone/sidecar/pty-core.js`'s. **The browser-dev harness claims but never
captures**: a reload there is a live resume over PTYs that survive it, so pressing
`^C` would interrupt work that is still running. Source of truth:
`pty:captureRecovery` / `recovery:take` in `standalone/sidecar/main.js`.

**The notepad archive is outside `sessions/`, and outside the state root** —
`<app_data_dir>/notepad-archive-v1.json`, its own compare-and-swap commands and
its own lifetime, so the session sweep never reaches it
(`docs/specs/notepad.md` -> "Standalone quit"). Both stores write through the one
`write_file_atomically`.

**Must restrict the session store to the owner before any bytes are written**
(`docs/specs/security-local.md` -> "Persisted state"; rationale).
`restrict_to_owner` sets `0700` on the directory and `0600` on the temp file
*first*, since the rename preserves its mode; on Windows, where a unix mode is a
silent no-op, it applies a protected single-entry DACL instead (mechanism in its
doc comment). `burrow_state_dir` locks the sidecar's state directory with the
same call and relies on it reaching a file that already *existed*, which
`restrict_to_owner_leaves_one_owner_only_ace` pins (rationale). **Must abort a snapshot save if either permission change fails**, preserving the previous snapshot. The state-directory call remains nonfatal and logs a `WARNING` naming the path. Pinned by `session_permission_failures_preserve_previous_snapshot_without_writing_bytes` and `session_write_tightens_directory_and_existing_temp_file`.

**Boot + the synchronous-read constraint.** `getState()` is synchronous —
cold-start restore reads it before React mounts — but a Tauri `invoke` is async, so
`TauriSessionStore` keeps an in-memory write-through cache: `TauriAdapter.init()`
`hydrate`s it from `load_session` (§Boot sequence), `getItem` reads it
synchronously, `setItem` updates it and forwards to `save_session` asynchronously,
coalescing bursts to at most one in-flight write (latest value wins). Mirrors the
VS Code adapter's host-injected seed (`docs/specs/vscode.md`).

Dirty tracking is shared frontend behavior (`docs/specs/layout.md` → Session persistence).
**Must skip an unchanged store write only when that value is queued or saved.**
An idle failed write remains retryable even though the read cache already holds
its value; pinned by `tauri-session-store.test.ts`.

Source of truth: `TauriSessionStore.setItem` in `standalone/src/tauri-session-store.ts`.

**Must await the store pipeline before exiting**, under the quit timeout
(§Quit flow; rationale). `drainSessionSaves` awaits `TauriSessionStore.drain()`,
which resolves when the write pipeline goes idle, including after a rejected
write; failed writes are logged. With Session persistence disabled, the pipeline
is already idle. Drain is a completion barrier, not a guarantee of successful
disk persistence.

## Quit flow

Source of truth: `standalone/src-tauri/src/lib.rs` (`QuitState`, `request_quit`,
the `quit_ack` / `quit_progress` / `quit_cancel` / `quit_proceed` commands, the `CloseRequested` /
`ExitRequested` arms) and `standalone/src/quit.ts` (the webview orchestrator).

**Must intercept every quit trigger in Rust** and run the webview teardown
before exiting (rationale).

**Every window votes before any window is torn down.** A cancel in the last
window could otherwise not put back the windows already destroyed
(rationale). Rust asks them all, and only once they all agree walks them one
teardown at a time. Source of truth: `QuitMachine` in
`standalone/src-tauri/src/quit_state.rs`.

| Phase | What happens |
|---|---|
| Voting | every window acks, archives its own notes, asks about its own running work, and calls `quit_vote` — or `quit_cancel`, which tells every window and destroys nothing |
| Walking | `quit_teardown` reaches one window at a time, **`main` last**; each hands on with `quit_window_done`, and the last one installs and calls `quit_proceed` |

- **A cancel is refused once the walk starts**: the first window is already gone.
- **A window that leaves outside the flow is forgotten**, so its vote is never
  waited on and the walk advances past it. **A flow that runs out of windows
  exits** rather than leaving a process with none, and so does a trigger that
  finds none: parked in `Voting` it would have no window to vote and refuse
  every later exit.
- **A quit keeps every window's snapshot on disk** — that is what a relaunch
  restores from, and the whole difference from a per-window close. **A Workspace
  in transfer is in no snapshot until its target publishes it, and neither end's
  teardown kills its shells** (§Arrival queue). A quit mid-transfer restores it
  at most once: from the target once it has published it, or from a source
  handed it back because the target was destroyed first; a source torn down
  before its target adopts leaves it in no snapshot.

### Trigger interception

Every trigger funnels into `request_quit(app)`:

| Arm | Fired by | Guard |
|---|---|---|
| `WindowEvent::CloseRequested` | the window close button | `api.prevent_close()` unless the quit is approved. Refused outright while the walk is running: a window taken out from under its own teardown leaves the walk emitting to a dead label. Only the **last** window's close is a quit; every other one is a per-window close (§Windows) |
| `RunEvent::ExitRequested` | a window-level exit request | `api.prevent_exit()` unless approved. The event's `code` is ignored: the `approved` gate alone is what lets the flow's own terminating `app.exit(0)` through without re-catching it |
| the app menu's Quit item | the menu, and its `Cmd+Q` accelerator | a **custom** `MenuItem`, never `PredefinedMenuItem::quit`, whose event calls `request_quit`; muda wires the predefined one straight to AppKit's `terminate:` (macOS; rationale) |
| `applicationShouldTerminate:` | the Dock's Quit, `osascript`, logout, restart | spliced onto tao's live delegate class at `Ready`, answering `NSTerminateCancel` and starting the flow, then `NSTerminateNow` once the flow's own `app.exit(0)` comes back through it (macOS; rationale) |

Source of truth: `standalone/src-tauri/src/macos_terminate.rs`.

**The ack / vote / progress / proceed / cancel protocol.** `request_quit` clears
every window's `acked`, bumps `seq`, and broadcasts `dormouse://quit-requested`
carrying the window count. It **must leave a walk in flight alone** — a repeat
trigger fired mid-teardown must not send the machine back to voting, or the fresh
watchdog drops into the unbounded vote wait and stops bounding the teardown that
is running. It **must keep every vote already cast**: a committed window answers
the repeat with an ack alone, so clearing its vote would hold the machine in
voting with no dialog left to answer (`a_repeat_trigger_while_voting_keeps_the_votes_already_cast`).
Each window's orchestrator (registered by `initQuitFlow`, Tauri-only) responds:

1. **Always `quit_ack`** first (fire-and-catch), so phase 1 stands down even if
   the orchestrator then dedupes the event out.
2. **Archive the notepads**, bounded at 3 s, *before* the first `quit_progress` —
   the last point at which a failure may still ask a question, since teardown may
   not (`docs/specs/notepad.md` -> "Standalone quit"). Failure or timeout leaves
   the quit **pending**: its dialog is another human decision, which phase 2 is
   unbounded for.
3. **`quit_vote`** when this window is ready — immediately on an all-idle quit,
   or after the user confirms and the archive gate passes. **A vote is not a
   teardown**: nothing anywhere may be destroyed until every window has agreed.
4. **`quit_progress`** when its own `quit-teardown` arrives, bumping a
   `progress` counter. Sent again at the install phase boundary.
5. The teardown (below), then **`quit_window_done`** — or **`quit_proceed`** in
   the last window, which sets `approved` and calls `app.exit(0)`.
6. A confirmation-dialog cancel (below), or a **Cancel** on the archive-failure
   dialog, calls **`quit_cancel`** — bumps `seq`, invalidating the live watchdog,
   tells every window to drop its dialog, and leaves the app running. **Nothing
   else cancels**: a Quit anyway must reach teardown with the watchdog still armed.

A cloned-`AppHandle` **watchdog** thread keeps quit bounded against a dead or
wedged webview, in three phases:

| Phase | State | Budget |
|---|---|---|
| 1 — ack | some window has not acked | ~2 s; a listener is dead ⇒ log and `app.exit(0)` |
| 2 — voting | acked, no window walking yet | **none** — a window may be parked on its confirmation dialog waiting on a human, who must never be force-quit out from under it. Only `quit_proceed` (`approved`) or `quit_cancel`/repeat-trigger (`seq` bump) ends the wait |
| 3 — walking | one window tearing down | **per phase**, ~14 s, refreshed by its `quit_progress` bumps *and* by the walk advancing to the next window, so each phase and each window gets its own budget; no progress for the budget ⇒ log and exit |

Phase 3's budget comfortably exceeds the webview's own teardown ceiling. Each
watchdog captures the `seq` it was spawned for, so a **repeated quit trigger** —
which bumps `seq`, spawns a fresh watchdog and re-emits — leaves the stale one to
exit without acting: the user's escape hatch if the webview acked then wedged.

**Confirmation dialog.** One dialog per window, shared with the per-window close,
which asks about closing rather than quitting. **A window names itself by its
visible Workspace only while more than one window is open.** The registry and the
notepad store are per webview, so the count and the notes a dialog speaks for are
already its own window's. `handleQuitRequested` hands the decision to the installed
gate when it finds **≥1 running session**; with no running work (or no gate) it
falls straight through to the teardown, so an all-idle quit never prompts. **A
close asks on a pending download too** (§Per-window close), which a quit never
does — it installs it. A
session counts as running iff its latest activity is a live command
(`activity.kind === 'running'`); `countRunningSessions`
(`lib/src/lib/terminal-state-store.ts`) is both the gate's predicate and the
dialog's live count. `main.tsx` wires the gate on the Tauri branch
(`setQuitConfirmGate(openQuitConfirm)`); order relative to `initQuitFlow` is
irrelevant — the gate is read only at quit time.

- **Live count.** `useSyncExternalStore(subscribeToTerminalPaneState, …)` tracks
  commands finishing while the dialog is up. **A count dropping to 0 leaves the
  dialog open** — auto-quitting out from under the user would surprise — showing
  "No commands are still running." with the same buttons.
- **Cancel / Escape** (the Cancel button takes initial focus as the safe default)
  close the dialog and call `ctx.cancel()` → `quit_cancel`: the app and every
  terminal are left untouched and a later quit starts fresh.
- **Confirm** calls `ctx.confirm()`, which runs the normal teardown; the dialog goes
  non-interactive ("Quitting…", both buttons disabled, Escape inert) until the
  process exits. The store nulls its context the instant a decision is made, so a
  redundant confirm/cancel is a no-op; with the orchestrator's `quitPhase` dedupe, a
  repeated quit trigger while the dialog is open neither re-opens nor stacks it.
- **Mount.** `<QuitConfirmModalHost>` rides Wall's `dialogHost` prop (`main.tsx` →
  `App` → `Wall`), rendered unconditionally inside Wall's `DialogKeyboardContext`
  provider, which the host toggles while visible so command-mode dispatch is
  suppressed under the modal. Focus-trapped `ModalFrame` (`layer="critical"`,
  `backdrop="strong"`), like ExternalLinkModal (`docs/specs/terminal-escapes.md` → "OSC 8 hyperlinks").

Source of truth: `standalone/src/quit-confirm-store.ts` (the module store + gate),
`standalone/src/QuitConfirmModal.tsx` (the modal).

**Teardown ordering (`runQuitTeardown`), and why.** **Every step is individually
bounded** so a stall cannot wedge quit, and the whole is wrapped in a ceiling
**derived from the sum of those bounds, never a literal** — one below the sum
aborts the final save of a slow teardown instead of guarding a wedged one. The two
steps that reach the sidecar cost their own budget *plus* Rust's round-trip margin,
so both terms count (`QUIT_TEARDOWN_CEILING_MS` in `standalone/src/quit.ts`; pinned by
`lib/src/lib/mirrored-constants.test.ts`). The notepad
archive is **not** a step here: it runs ahead of `quit_progress` precisely because
teardown's rule below holds — no failing step prevents exit — and archiving must be
able to stop the quit (`docs/specs/notepad.md` -> "Standalone quit"):

1. `captureAgentRecovery` — **this window's PTYs**, and **first**, because an agent's resume invocation exists
   only between the interrupt and the kill and is the one thing here that cannot be
   reconstructed afterwards (§Agent recovery). **A failed capture must not abort the
   steps behind it.**
2. `requestSessionFlush` — save while PTYs are alive, so CWDs are fresh.
3. `gracefulKillPtys` — SIGTERM **this window's** PTYs, resolving early once all exit and
   their final output has had a grace tick to reach the webview (§Rust ↔ sidecar
   bridge).
4. `requestSessionFlush({ probeCwd: false })` — flush the post-exit Session state.
   **Must skip the cwd probe and retain the previously persisted CWD**: every
   probe against a dead PTY answers null and is discarded for that value anyway
   (`docs/specs/transport.md` → "Persisted session types").
5. `flushWindowSession` — the Workspaces' records become one Window blob
   (`docs/specs/transport.md` → "Persisted session types"); a debounce timer still
   pending at exit would otherwise lose the final save. **Bounded like the rest,
   its term in the ceiling**, though both writers are synchronous today.
6. `drainSessionSaves` — await the store pipeline becoming idle or its timeout
   (§Persistence).
7. **In the last window only**, if an update is pending, a fresh `quit_progress`
   then `installPendingUpdate()` — strictly *after* the completed save
   (`docs/specs/auto-update.md`); Rust's phase-3 watchdog backstops a hung
   installer.
8. **Always** `quit_window_done`, or `quit_proceed` in the last window (in
   `finally`, even on throw/timeout).

**Windows note.** node-pty's `kill('SIGTERM')` is an immediate kill under ConPTY,
so step 2 terminates promptly there, retaining the same final-output grace tick.

**Dev-mode note.** The browser-dev harness has no Rust quit interception, and the
flow never initializes there (§Boot sequence, step 5).

## File drop

The `WindowEvent::DragDrop` handler in `lib.rs` emits the dropped paths as
`dormouse://files-dropped`; `TauriAdapter` fans that out to `onFilesDropped` for
the Wall. The whole path is **inert today**: `tauri.conf.json` sets
`dragDropEnabled: false` to keep in-webview HTML5 drag-and-drop working, so the
native handler never fires. Behavior and status:
`docs/specs/mouse-and-clipboard.md` (§8.7 Drag-to-Paste).

## Logging

Windows release builds use the GUI subsystem, so nothing streams to a launching
terminal. The Rust backend appends sidecar stderr, malformed stdout diagnostics,
and its own diagnostics to a log file: `%LOCALAPPDATA%\Dormouse Terminal\dormouse.log` on
Windows, `$TMPDIR/dormouse.log` elsewhere, overridable via `DORMOUSE_LOG_FILE`.

**Must bound updater debug-log reads to the final 10,000 bytes**, dropping a
leading partial UTF-8 character. `read_update_log` runs off the main thread. The
log resets at app startup and grows during the run.

Source of truth: `init_log` / `read_update_log` in `standalone/src-tauri/src/lib.rs`;
`read_utf8_tail` in `standalone/src-tauri/src/log_tail.rs`, pinned by
`reads_only_the_budget_even_when_the_log_grows`.

## Build and development

Source of truth: `standalone/package.json` (package scripts),
`standalone/src-tauri/tauri.conf.json` (`build`, `bundle.resources`), and the root
`package.json` for the `dev:standalone` and `innerdogfood` orchestration;
`runDev` in `standalone/scripts/dev-standalone.mjs`;
`standalone/scripts/clean-dev-sidecar.mjs`.

- `stage` = `stage:dor-cli` (build + stage the dor CLI, `docs/specs/dor-cli.md`)
  plus `stage:sidecar-proxy` (`build-sidecar-proxy.mjs` bundles the
  `lib/src/host/` sources into the sidecar `.cjs` files).
- The `tauri` script stages, then runs `standalone/scripts/tauri.mjs`, which
  delegates to the Tauri CLI — except `dev`, which it routes through `runDev`
  below. `build-sidecar-proxy.mjs` bakes `DORMOUSE_REMOTE_CONNECT_SRC` into the
  sidecar's Burrow bundle. The webview CSP contains no relay sources, pinned by
  `standalone/scripts/tauri-conf.test.mjs` (`docs/specs/relay.md`, "Where a Burrow
  may reach a Relay").
- The Tauri bundle ships the whole sidecar via the `../sidecar/**/*` resources
  glob — including node-pty's prebuilds + bundled ConPTY and the
  shell-integration scripts (`docs/specs/terminal-escapes.md`).
- **Must start native dev with Vite on an OS-assigned loopback port and pass its
  bound URL to Tauri**, with `beforeDevCommand` disabled in a per-run overlay.
  Direct `pnpm exec tauri dev` keeps
  `tauri.conf.json`'s defaults. HMR shares Vite's listener, including when
  `TAURI_DEV_HOST` is inherited; inherited browser-dev settings never enable
  browser mode.
- **May pin Vite with `DORMOUSE_BROWSER_DEV_VITE_PORT`; an occupied port must fail
  without stopping its owner.**
- **Must close Vite and the owned Tauri process tree on startup failure, exit,
  SIGINT, SIGTERM or SIGHUP.**
  POSIX shutdown escalates to SIGKILL after three seconds; Windows terminates
  the owned tree with `taskkill /T /F`.
- **Must key the native dev Tauri identifier to the canonical worktree path**, so
  parallel worktrees and the installed app never share app data. The default log is
  `<worktree>/standalone/src-tauri/target/dormouse-dev.log`, overridden by
  `DORMOUSE_LOG_FILE`. Pinned by `standalone/scripts/dev-standalone.test.mjs`.
- **Must limit Windows pre-dev cleanup to sidecars executing from this worktree's
  default debug directory; never kill a listener by port.**
- **Must re-stage and restart after changing sidecar, staged CLI, or bundled host
  sources.** Frontend edits hot-reload; Tauri watches Rust.
- `pnpm innerdogfood` runs the sidecar + webview in a normal browser via the
  browser-dev harness instead of the Tauri WebView (`docs/specs/transport.md`,
  Standalone browser-dev harness).

## Terminal context host operations

The adapter forwards every `TerminalContextRequest` to the PTY host as a correlated request (`docs/specs/transport.md` → Auxiliary helper metadata); directory opening follows `docs/specs/security-local.md` → Terminal context directory actions, and inspection failure follows `docs/specs/terminal-context.md` → Helper lifecycle.

Source of truth: `terminalContext` in `standalone/src/tauri-adapter.ts`; `pty_context` in `standalone/src-tauri/src/lib.rs`; `context` in `standalone/sidecar/pty-core.js`.
