# Dormouse Standalone (Tauri) Integration Spec

> See `docs/specs/glossary.md` for Session / Surface / Pane / Door vocabulary.
> Owns the standalone-specific layer: the Tauri window, the Rust ↔ sidecar bridge, the AppBar, persistence at the adapter boundary, shutdown ordering, logging, and the build/dev workflow.
> Defers the protocol it speaks — PTY lifecycle, message contracts, persisted-session types, adapter-agnostic invariants — to `docs/specs/transport.md`.
> Evidence and dead approaches: [standalone.rationale.md](standalone.rationale.md).

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
2. `setPlatform(platform)`, then `await platform.init()` **before**
   `resumeOrRestore` — init registers the listeners resume replay arrives on and
   hydrates the session cache (§Persistence).
3. `installPeerSurfaceResponder()` **after `init()`, never before** (§Remote Host
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
8. `resumeOrRestore(platform)` — the priority-based recovery from
   `docs/specs/transport.md`.
9. `startUpdateCheck()` (`docs/specs/auto-update.md`), then render `AppBar` +
   `App` with `enableRemoteHost` — the mount gate for the lazily-imported
   remote-Host UI chunk (§Remote Host service); the Host itself runs in the
   sidecar regardless. `<ConnectedUpdateBanner />` rides the `baseboardNotice`
   slot, `<QuitConfirmModalHost />` the `dialogHost` slot.

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
| `load_session` / `save_session` / `clear_session` | Rust | the per-window session file is Rust's store (§Persistence) |
| the `clipboard` readers (Windows only) | Rust (`clipboard_win.rs`) | native Win32 reads (`docs/specs/mouse-and-clipboard.md` §8.6) |
| `agent_browser_screenshot` | Rust reads the bytes from a sidecar-supplied temp-file *path* | images must never ride the JSON-lines pipe shared with PTY traffic (`docs/specs/dor-browser.md`) |

Request/response commands block on the sidecar's reply under a timeout.
`OPEN_PORT_TIMEOUT_MS` in `lib.rs` mirrors the constant in
`lib/src/lib/platform/types.ts` (and `standalone/sidecar/pty-core.js`);
`lib/src/lib/mirrored-constants.test.ts` pins the copies together.

**Blocking commands must be `#[tauri::command(async)]`** — Tauri runs a *plain*
sync command on the main thread, where the `recv_timeout` inside
`request_from_sidecar` / `request_from_sidecar_timeout` stops the webview painting
for the whole round trip, up to `AGENT_BROWSER_TIMEOUT` (30s) (rationale). **The
three clipboard readers included**: their non-Windows branches round-trip through
the sidecar, and the attribute is per command, not per branch. A unit test in
`lib.rs` scans the source and fails on any command that reaches the blocking
helpers without it.

`pty_graceful_kill_all` (`TauriAdapter.gracefulKillAllPtys`) SIGTERMs every live
PTY and awaits the sidecar's `gracefulKillDone` (echoing the request's
`requestId`; bounded at `timeout + 1.5s`). It resolves one 50 ms grace tick after
the last PTY exits — so ConPTY's late final flush still lands — or at the timeout
for SIGTERM-ignoring programs. Unlike the hard `pty_kill` path it **preserves
scrollback**, readable afterwards via `pty_get_scrollback`; the quit flow's
graceful teardown calls it (§Quit flow).

Sidecar events (`pty:*`, dor control requests, async results) are emitted to the
webview, where `TauriAdapter` converts dor control requests into the
`dormouse:control-request` CustomEvent that `Wall` handles
(`docs/specs/dor-cli.md`, Host Plumbing — including the sidecar env:
`DORMOUSE_NODE`, `DORMOUSE_CLI_*`, `DORMOUSE_CONTROL_*`).

`resolve_sidecar_path` strips Windows `\\?\` verbatim prefixes from
`resource_dir()` once at the boundary so every derived path is plain
(`docs/specs/dor-cli.md`, Bundling And PATH).

### Remote Host service

The remote Host — relay socket, enrollment, ACL, pairing ceremony, remote-api v1
— runs **in the sidecar**, never the webview (`docs/specs/server.md` → "Host
side", which owns that split and what the webview keeps): the same
`RemoteHostService` the VS Code extension host runs, bound by
`lib/src/host/remote/sidecar-entry.ts` and bundled to `sidecar/remote-host.cjs`
with the relay-origin allowlist baked in (`docs/specs/server.md`). **Nothing the
webview says can widen access** (`docs/specs/remote-security-model.md`).

**State.** Rust creates the app-data directory, locks it owner-only, and passes it
as `DORMOUSE_STATE_DIR` (§Persistence, "Rust file store"); `FileHostStateStore`
keeps enrollment and ACL there as **one** `remote-host.json`, 0600 in a 0700
directory via temp-then-rename — one file, so a write is one atomic rename
(rationale). `hostToken` is a bearer credential and **never enters a webview
realm**. Against the shared store contract (`docs/specs/server.md` → "Host side"):

- **Reads fail closed.** Only `ENOENT` and a read-but-unparseable file answer
  empty; the parse failure warns. Any other read error is neither answered nor
  memoized — the load rejects and takes the save behind it with it (rationale). A
  later read recovers.
- **The in-memory view advances only after the rename succeeds.** Re-tightening a
  directory Rust already created is best-effort; failing the save over it would
  lose the Host instead.
- **`persistent` is declared, never inferred.** With no state directory — Rust
  passes an empty value when it cannot create one — the fallback store still
  *holds* both values in memory, warns once, and reports `persistent: false`. The
  browser dev harness is *not* this case: its per-run temp directory makes a dev
  enrollment live and die with the run.

**The bridge.** Webview → sidecar is one generic passthrough invoke,
`remote_host_command(payload)`, writing `{"event":"remoteHost:command",
"data":payload}` to stdin for the dispatch table's `handleCommand`. Sidecar →
webview is three ordinary stdout events — `remoteHost:result`, `remoteHost:ask`,
`remoteHost:event` — forwarded by Rust's generic `handle.emit`. **The correlation
field is `rhId`, never `requestId`**: Rust swallows any sidecar line whose
`data.requestId` matches a pending invoke (rationale). Everything above those
shapes is the shared `link-client.ts` (`docs/specs/transport.md` → Message
protocol).

**Asks and answers.** What the sidecar cannot know — a pane's name, its focus, its
xterm size — it asks over `remoteHost:ask`, and
`lib/src/remote/host/peer-surfaces.ts` answers as an ordinary `answer` command
naming the ask's own `rhId`. **The first answer settles the ask**: standalone ships
one window, so there is exactly one answerer. *Multi-window seam*: a second window
would instead collect until `ASK_BUDGET_MS` (1s), which otherwise only bounds a
reloading webview — an attach must not hang on one.

**An answer for an ask the bridge no longer holds invalidates the directory**
rather than being dropped (`docs/specs/remote-api.md` → Directory).

**Stripping.** The sidecar hands the webview *raw* PTY bytes, so the service runs
its own strip-only `TerminalProtocolParser` over each PTY it streams (rationale),
supplying a constant colour provider for the OSC 10/11/12 case. Its rules —
discard every event, consume rather than decline a colour query, one parser per
PTY — are `docs/specs/terminal-escapes.md` → Parsing location.

**A remote listener must never break the local pipe.** The tap sits inside
`pty-core`'s event callback in `main.js`, ahead of the send to the webview, and is
wrapped: a throw is logged to stderr and the `pty:*` event goes out either way.
Exit codes are retained so a stream installed after surface resolution can replay
liveness before attach acknowledgement.

Source of truth: `lib/src/host/remote/service.ts`,
`lib/src/host/remote/sidecar-entry.ts`, `lib/src/host/remote/pty-strip.ts`,
`standalone/sidecar/main.js` (the tap and the `remoteHost:command` case),
`remote_host_command` / `remote_host_state_dir` in
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
3. Dispose the remote Host service, dropping the relay socket and settling every
   outstanding ask so nothing waits on a webview that is going away.
4. `mgr.killAll()` (all PTYs), then `process.exit(0)`.

**A parent-PID watchdog polls every 2s** and self-triggers shutdown if the Tauri
process disappears: stdin EOF is not always delivered when the host is
force-killed, and an orphaned sidecar keeps `conpty.node`/`conpty.dll` loaded and
blocks the NSIS installer (`docs/specs/auto-update.md`, Sidecar teardown on
Windows).

Host-side ordering: every quit trigger is driven through the webview quit
orchestrator (§Quit flow, which owns the teardown/install/exit sequence); Tauri's
`RunEvent::Exit` then runs `shutdown_sidecar_and_wait` as a final backstop
(harmless post-teardown — the PTY map is already empty, so `killAll` no-ops).

## AppBar

Source of truth: `standalone/src/AppBar.tsx`.

The AppBar is the draggable titlebar region, carrying left to right a
`[New workspace]` button and — Windows/Linux only, since macOS gets native traffic
lights from `titleBarStyle: "Overlay"` and left padding instead — the window
controls (minimize / maximize / close via `@tauri-apps/api/window`, dimmed by
window-focus tracking). **Neither a theme picker nor a shell picker belongs here**:
both live in the Settings dialog at the bottom-right of the window
(`docs/specs/theme.md`).

`[New workspace]` is a placeholder holding the spot the workspace strip will take.
It creates nothing — it calls `openExternal` on
https://github.com/diffplug/dormouse/issues/406, the tracking issue. The strip
lands here at stage 3 of the rollout (`docs/specs/layout.md` `## Future`,
workspaces-rollout).

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

## Persistence

`TauriAdapter.saveState` / `getState` route the session blob through
`lib/src/lib/window-persistence.ts` (`loadSessionState` / `saveSessionState`) —
the standalone adapter boundary where the `PersistedWindow` wrapping lives
(`docs/specs/transport.md`, Workspace/Window containers).

**Never back the session blob with WebKit `localStorage`** — a WAL that grows
without bound (rationale). The blob rides the `SessionKeyValueStore` seam instead,
over the Rust-backed `standalone/src/tauri-session-store.ts`. Theme selection
still persists on `localStorage` (`docs/specs/theme.md`) — tiny and rarely
written.

**Rust file store.** `save_session(window, state)` / `load_session(window)` /
`clear_session(window)` (`lib.rs`) persist the blob as one atomic file per Tauri
window, `<app_data_dir>/sessions/<label>.json`:

- **The label is sanitized** so it cannot escape the directory.
- **Temp-then-rename**, so a crash cannot truncate the previous snapshot. The temp
  file is fsynced before the rename and, on unix only, the sessions directory
  *after* it (rationale).
- **Window identity is implicit**: each command keys by the invoking
  `tauri::Window`'s `label()`, so the frontend stays window-agnostic and a second
  window (`win-2`, …) persists to its own file rather than rewriting the first
  window's. The store is multi-window even though the app ships one window today.
- No WAL to grow, and rewriting the same path bounds the on-disk size to one
  blob (rationale).

**Owner-only on disk, before any bytes are written** — the blob carries terminal
transcripts (`SECURITY.md` -> Remote Control, Credentials at rest).
`restrict_to_owner` sets `0700` on the directory and `0600` on the temp file
*first*, since the rename preserves its mode; on Windows, where a unix mode is a
silent no-op, it applies a protected single-entry DACL instead (mechanism in its
doc comment). `remote_host_state_dir` locks the sidecar's state directory with the
same call and relies on it reaching a file that already *existed*, which
`restrict_to_owner_leaves_one_owner_only_ace` pins (rationale). **Neither call is
fatal**, but the state-dir one logs a `WARNING` naming the path rather than
failing silently, because on Windows it is the only thing restricting `hostToken`.

**Boot + the synchronous-read constraint.** `getState()` is synchronous —
cold-start restore reads it before React mounts — but a Tauri `invoke` is async, so
`TauriSessionStore` keeps an in-memory write-through cache: `TauriAdapter.init()`
`hydrate`s it from `load_session` (§Boot sequence), `getItem` reads it
synchronously, `setItem` updates it and forwards to `save_session` asynchronously,
coalescing bursts to at most one in-flight write (latest value wins). Mirrors the
VS Code adapter's host-injected seed (`docs/specs/vscode.md`).

**Dirty-gated writes.** An idle app must not rewrite the multi-MB blob. A
generation-counter dirty tracker gates the periodic heartbeat; the trigger
taxonomy above it is shared frontend code, so every adapter gets it
(`docs/specs/layout.md` → Session persistence).

- **Races resolve conservatively**: a save captures its target generation before
  serializing and clears dirty only on a fulfilled write, so a change arriving
  mid-save costs one redundant save at worst and is never lost.
- **Store-level backstop**: `TauriSessionStore.setItem` short-circuits on a blob
  byte-equal to the cached one, valid from the first write because the cache is
  boot-seeded from disk.

Source of truth: `lib/src/lib/session-dirty.ts`,
`lib/src/components/wall/use-session-persistence.ts`,
`standalone/src/tauri-session-store.ts`.

**Durability on quit.** `saveState` returns after updating the cache and merely
*firing* `save_session`, so the quit orchestrator (§Quit flow) awaits the pipeline
all the way to disk: `requestSessionFlush` drives the debounced/heartbeat save
through `saveState`, then `drainSessionSaves` awaits `TauriSessionStore.drain()`,
which resolves when the write pipeline goes idle, under a bounded timeout. **The
final debounce/heartbeat window is therefore never lost** (rationale).

**Standalone persists no Session state**: every launch starts fresh
(`docs/specs/transport.md` → "The governing rule"). One `PERSIST_SESSION` gate
drives all of it — `TauriAdapter.getState` returns null, `saveState` is a no-op,
and the adapter reports `persistsSession: false` so `saveSession` skips building a
record at all. **That last part is what keeps the gate from being cosmetic**,
since the record build costs a `getCwd` round trip per terminal pane regardless
(rationale). `init()` also **deletes** any pre-upgrade snapshot via
`clear_session`, unconditionally and including an orphaned
`<label>.json.tmp` (`docs/specs/transport.md` → "Retiring the transcripts already
on disk"), deleting rather than blanking (rationale). The store beneath the gate
is intact and still needed by the workspaces-rollout scope
(`docs/specs/layout.md` → `## Future`); re-enabling recovery is flipping the gate
plus adding capture to the quit teardown, whose ordering already fits (flush →
kill → flush → drain).

**Flip both `PERSIST_SESSION` flags together** — a harness that restored panes
across a reload would be debugging a path the shipped app never takes; the rest
of the mirroring rule is `docs/specs/transport.md` → Standalone browser-dev
harness. `BrowserSidecarAdapter` **deletes** the
`dormouse.browser-sidecar.session` key on `init()` rather than ignoring it
(rationale).

**What the gate costs on reload is the *layout*, not the Sessions.** Nothing wires
`shutdown()` to `beforeunload`, so the sidecar's PTYs outlive a page reload and
`lib/src/lib/reconnect.ts` resumes over them — but with no `getState()` resume plan
every live PTY lands in one tab group, doors and saved titles dropped. Real
standalone has always done this across a WebView reload (rationale).

## Quit flow

Source of truth: `standalone/src-tauri/src/lib.rs` (`QuitState`, `request_quit`,
the `quit_ack` / `quit_progress` / `quit_cancel` / `quit_proceed` commands, the `CloseRequested` /
`ExitRequested` arms) and `standalone/src/quit.ts` (the webview orchestrator).

**Rust intercepts every quit trigger** — quitting ends every terminal, so the
webview tears them down gracefully and durably writes the freshest session first
(rationale).

**Trigger interception.** Two Rust arms funnel into `request_quit(app)`:

| Arm | Fired by | Guard |
|---|---|---|
| `WindowEvent::CloseRequested` | the window close button | `api.prevent_close()` unless the quit is already approved |
| `RunEvent::ExitRequested` | Cmd+Q / app-menu Quit / dock quit / interceptable OS logout | `api.prevent_exit()` unless approved. The event's `code` is ignored: the `approved` gate alone is what lets the flow's own terminating `app.exit(0)` through without re-catching it |

*Multi-window seam*: one window ships today, so a per-window close is the whole-app
quit; a multi-window build would give each `CloseRequested` a per-window teardown
and only quit on the last.

**The ack / progress / proceed / cancel protocol.** `request_quit` clears `acked`,
bumps `seq`, and emits `dormouse://quit-requested` to the webview. It **must not
clear `tearing_down`** — a repeat trigger fired mid-teardown must keep it set, or
the fresh watchdog drops into the unbounded phase-2 wait and stops bounding the
teardown in flight. The webview's orchestrator (registered by `initQuitFlow`,
Tauri-only) responds:

1. **Always `quit_ack`** first (fire-and-catch), so phase 1 stands down even if
   the orchestrator then dedupes the event out.
2. **`quit_progress`** when teardown begins — immediately on an all-idle quit, or
   after the user confirms — setting `tearing_down` and bumping a `progress`
   counter. Sent again at the install phase boundary.
3. The teardown (below), then **`quit_proceed`** — sets `approved` and calls
   `app.exit(0)`.
4. A confirmation-dialog cancel (below) calls **`quit_cancel`** — bumps `seq`,
   invalidating the live watchdog, and leaves the app running.

A cloned-`AppHandle` **watchdog** thread keeps quit bounded against a dead or
wedged webview, in three phases:

| Phase | State | Budget |
|---|---|---|
| 1 — ack | no `quit_ack` yet | ~2 s; the listener is dead ⇒ log and `app.exit(0)` |
| 2 — awaiting teardown | acked, `tearing_down` unset | **none** — the webview may be parked on the confirmation dialog waiting on a human, who must never be force-quit out from under it. Only `quit_proceed` (`approved`) or `quit_cancel`/repeat-trigger (`seq` bump) ends the wait |
| 3 — teardown running | `tearing_down` set | **per phase**, ~12 s, refreshed by every `quit_progress` bump, so teardown and update install get separate budgets rather than one total; a phase making no progress for the budget ⇒ log and exit |

Phase 3's budget comfortably exceeds the webview's own 8 s teardown ceiling. Each
watchdog captures the `seq` it was spawned for, so a **repeated quit trigger** —
which bumps `seq`, spawns a fresh watchdog and re-emits — leaves the stale one to
exit without acting: the user's escape hatch if the webview acked then wedged.

**Confirmation dialog.** `handleQuitRequested` hands the decision to the installed
gate when it finds **≥1 running session**; with no running work (or no gate) it
falls straight through to the teardown, so an all-idle quit never prompts. A
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

**Teardown ordering (`runQuitTeardown`), and why.** Wrapped in an 8 s ceiling, with
**every step individually bounded** so a stall cannot wedge quit:

1. `requestSessionFlush` — save while PTYs are alive, so CWDs are fresh.
2. `gracefulKillAllPtys` — SIGTERM every PTY, resolving early once all exit. It
   **precedes** capture on purpose: only the hard `pty_kill` / sidecar `killAll`
   clears the scrollback buffer (§Rust ↔ sidecar bridge).
3. `requestSessionFlush` — capture that now-final scrollback of the dead PTYs.
   `getCwd` returns null for a dead PTY, and session-save falls back to the
   previously persisted CWD.
4. `drainSessionSaves` — await the last `save_session` reaching disk; the process
   does not exit until it lands (§Persistence, "Durability on quit").
5. If an update is pending, a fresh `quit_progress` then `installPendingUpdate()`
   — strictly *after* the completed save (`docs/specs/auto-update.md`); Rust's
   phase-3 watchdog backstops a hung installer.
6. **Always** `quit_proceed` (in `finally`, even on throw/timeout).

**Windows note.** node-pty's `kill('SIGTERM')` is an immediate kill under ConPTY,
so step 2 terminates promptly there; the scrollback buffer still survives the
exit, so step 3 captures the final output as elsewhere.

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
terminal. The Rust backend appends sidecar stdout/stderr lines and its own
diagnostics to a log file: `%LOCALAPPDATA%\Dormouse Terminal\dormouse.log` on
Windows, `$TMPDIR/dormouse.log` elsewhere, overridable via `DORMOUSE_LOG_FILE`
(`docs/specs/deploy.md`, Packaged app logging). The updater debug modal reads it
back through `read_update_log`.

## Build and development

Source of truth: `standalone/package.json` (package scripts),
`standalone/src-tauri/tauri.conf.json` (`build`, `bundle.resources`), and the root
`package.json` for the `dev:standalone*` orchestration.

- `stage` = `stage:dor-cli` (build + stage the dor CLI, `docs/specs/dor-cli.md`)
  plus `stage:sidecar-proxy` (`build-sidecar-proxy.mjs` bundles the
  `lib/src/host/` sources into the sidecar `.cjs` files).
- The `tauri` script stages, then runs `standalone/scripts/tauri.mjs`, which
  delegates to the Tauri CLI. The `DORMOUSE_REMOTE_CONNECT_SRC` build-time override
  for self-host relay origins is baked into the sidecar's remote-host bundle by
  `build-sidecar-proxy.mjs` — the Host runs in the sidecar, so the webview CSP has
  no relay sources at all, which `standalone/scripts/tauri-conf.test.mjs` asserts
  against `tauri.conf.json` (`docs/specs/server.md`, "Where a Host may reach a
  relay server").
- The Tauri bundle ships the whole sidecar via the `../sidecar/**/*` resources
  glob — including node-pty's prebuilds + bundled ConPTY and the
  shell-integration scripts (`docs/specs/terminal-escapes.md`).
- **Dev caveat:** `tauri.conf.json`'s `beforeDevCommand` is `pnpm dev` (Vite only).
  Frontend edits hot-reload, but changes to the sidecar, the staged dor CLI, or the
  bundled `lib/src/host/` sources need a manual re-stage and app restart — the dev
  loop does not watch them.
- `pnpm dev:standalone:ab` runs the sidecar + webview in a normal browser via the
  browser-dev harness instead of the Tauri WebView (`docs/specs/transport.md`,
  Standalone browser-dev harness).
