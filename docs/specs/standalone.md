# Dormouse Standalone (Tauri) Integration Spec

> See `docs/specs/glossary.md` for Session / Surface / Pane / Door vocabulary. See `docs/specs/transport.md` for the PTY lifecycle, message protocol, persisted-session types, and adapter-agnostic invariants the standalone app shares with the VS Code and fake adapters. This spec covers the standalone-specific layer: the Tauri window, the Rust ↔ sidecar bridge, the AppBar, persistence at the adapter boundary, shutdown ordering, logging, and the build/dev workflow.

## Architecture

```
Tauri app process (Rust — standalone/src-tauri/src/lib.rs)
├── WebView (Vite frontend — standalone/src/)
│   ├── main.tsx           — bootstrap: platform init, theme restore, resumeOrRestore, updater
│   ├── AppBar.tsx         — draggable titlebar: New workspace placeholder, window controls
│   ├── tauri-adapter.ts   — TauriAdapter (PlatformAdapter over Tauri invoke/events)
│   ├── tauri-session-store.ts — Rust-backed session store (§Persistence)
│   ├── quit.ts + quit-confirm-store.ts + QuitConfirmModal.tsx — quit orchestrator (§Quit flow)
│   ├── updater.ts         — auto-update state machine (docs/specs/auto-update.md)
│   └── browser-sidecar-{host,adapter}.ts — browser-dev harness (docs/specs/transport.md)
└── Node sidecar (standalone/sidecar/main.js — spawned by Rust at setup)
    ├── pty-core.js            — shared PTY manager (docs/specs/transport.md; also used by the VS Code pty-host)
    ├── dor-control-server.js  — dor CLI control socket (docs/specs/dor-cli.md)
    ├── iframe-proxy.cjs       — bundled from lib/src/host/iframe-proxy.ts (docs/specs/dor-browser.md)
    ├── agent-browser-host.cjs — bundled from lib/src/host/agent-browser-host.ts (docs/specs/dor-browser.md)
    ├── remote-host.cjs        — bundled from lib/src/host/remote/sidecar-entry.ts: the remote Host service (§Remote Host service)
    ├── clipboard-ops.js       — OS clipboard: paste-read tiers for macOS/Linux (Windows reads go native in Rust); agent-browser clipboard writes on all platforms (docs/specs/mouse-and-clipboard.md §8.6, docs/specs/dor-browser.md)
    └── shell-integration/     — injected shell hook scripts (docs/specs/terminal-escapes.md)
```

The Rust layer is deliberately thin: it spawns and supervises the sidecar,
bridges the webview to it, and owns the OS-integration edges (window events,
menu, file drop, dock icon, logging) plus the session file store. Everything
with real logic runs in the Node sidecar, sharing the same modules the VS Code
host runs — `build-sidecar-proxy.mjs` bundles the `lib/src/host/` sources into
the sidecar's `.cjs` copies, so the two hosts cannot drift.

## Boot sequence

Source of truth: `standalone/src/main.tsx` (`bootstrap()`).

1. Pick the platform: `BrowserSidecarAdapter` when `VITE_DORMOUSE_BROWSER_DEV_HOST`
   is set (the browser-dev harness, `docs/specs/transport.md`), otherwise
   `TauriAdapter`.
2. `setPlatform(platform)` then `await platform.init()` **before**
   `resumeOrRestore` — init registers the event listeners that resume replay
   arrives on, and hydrates the session cache (§Persistence).
3. `installPeerSurfaceResponder()`, so the sidecar's Host can ask this webview
   what its panes are called and how big their xterms are (§Remote Host
   service). **After `init()`, not before:** the responder seeds itself with a
   `status` command, and nothing could carry the answer back until the adapter
   has its listeners.
4. Start `getAvailableShells()` *without* awaiting it — a webview → Rust →
   sidecar round trip, so it overlaps steps 5–6.
5. Tauri branch only: `initQuitFlow(platform)` and
   `setQuitConfirmGate(openQuitConfirm)` (§Quit flow).
6. `initAlertStateReceiver()`, `restoreActiveTheme()` (`docs/specs/theme.md`).
7. `seedShellStore` on the awaited shell list (`lib/src/lib/shell-store.ts`),
   which restores the persisted selection (`dormouse:selected-shell`) and
   publishes it via `setDefaultShellOpts` (the default-shell slot used by
   split/spawn/restore paths, `docs/specs/layout.md`). Awaited here because
   seeding must complete before the Wall mounts, so the first restored pane
   already spawns with that shell.
8. `resumeOrRestore(platform)` runs the priority-based recovery from
   `docs/specs/transport.md`.
9. `startUpdateCheck()` (`docs/specs/auto-update.md`), then render `AppBar` +
   `App` with `enableRemoteHost` — the mount gate for the lazily-imported
   remote-Host UI chunk (pairing modal, console hook, ring detection for push,
   `docs/specs/server.md` Host side); the Host itself is already running in the
   sidecar, independent of this. `<ConnectedUpdateBanner />` is threaded through
   the `baseboardNotice` slot and `<QuitConfirmModalHost />` through `dialogHost`.

## Rust ↔ sidecar bridge

Source of truth: `standalone/src-tauri/src/lib.rs` (`SidecarState`, the
`#[tauri::command]` set, `resolve_sidecar_path`) and
`standalone/sidecar/main.js` (the dispatch table).

The sidecar speaks JSON-lines over stdio: commands in on stdin, events out on
stdout (stdout is reserved for the protocol — sidecar diagnostics go to
stderr, which Rust appends to the log file). Webview → Rust is the Tauri
`invoke` command set — `pty_spawn` / `pty_write` / `pty_resize` / `pty_kill` /
`pty_request_init` / `pty_get_cwd` / `pty_get_open_ports` /
`pty_get_scrollback` / `pty_graceful_kill_all` / `get_available_shells`,
`dor_control_response`, `iframe_create_proxy_url`, the `agent_browser_*` family,
the `clipboard` readers, `read_update_log`, `remote_host_command`
(§Remote Host service), and `kill_sidecar_now` — each a thin
forwarder to the corresponding sidecar message. `load_session` / `save_session` /
`clear_session` are the exception that is *not* forwarded: they read, write, and
delete the per-window session file directly in Rust (§Persistence). Two further carve-outs: on Windows the
clipboard readers skip the sidecar and read the Win32 clipboard natively
(`clipboard_win.rs`; behavior in `docs/specs/mouse-and-clipboard.md` §8.6),
and `agent_browser_screenshot` receives a temp-file *path* from the sidecar
and reads the bytes in Rust so images never ride the JSON-lines pipe shared
with PTY traffic (`docs/specs/dor-browser.md`). Request/response commands block on the
sidecar's reply with a timeout; `OPEN_PORT_TIMEOUT_MS` in `lib.rs` mirrors the
constant in `lib/src/lib/platform/types.ts` and the two must stay in sync.

**Blocking commands must be `#[tauri::command(async)]`.** `request_from_sidecar`
and `request_from_sidecar_timeout` block the calling thread on a `recv_timeout`,
and Tauri runs a *plain* sync command on the main thread — where that block stops
the webview from painting for the whole round trip (up to `AGENT_BROWSER_TIMEOUT`
= 30s for a hung agent-browser; a cold `agent-browser open` froze the UI ~3s,
long enough that a pane created instantly before it looked like it never
appeared). `(async)` runs the same blocking body on a runtime worker instead.
That includes the three clipboard readers, whose non-Windows branches round-trip
through the sidecar and would otherwise freeze the webview during a paste — the
Windows branches read Win32 directly, but the attribute applies to the whole
command either way. A unit test in `lib.rs` scans the source and fails on any
command that reaches the blocking helpers without it.

`pty_graceful_kill_all` (`TauriAdapter.gracefulKillAllPtys`) SIGTERMs every live
PTY and awaits the sidecar's `gracefulKillDone` (echoing the request's
`requestId`; bounded at `timeout + 1.5s`). It fires early once every PTY has
exited — one 50 ms grace tick after the last exit, so ConPTY's late final flush
still lands — or at the timeout for SIGTERM-ignoring programs. Unlike the hard
`pty_kill` path it preserves scrollback, so final output stays readable via
`pty_get_scrollback`; it is the hook the quit flow's graceful teardown calls
(§Quit flow).

Sidecar events (`pty:*`, dor control requests, async results) are emitted to
the webview, where `TauriAdapter` converts dor control requests into the
`dormouse:control-request` CustomEvent that `Wall` handles
(`docs/specs/dor-cli.md`, Host Plumbing — including the sidecar env:
`DORMOUSE_NODE`, `DORMOUSE_CLI_*`, `DORMOUSE_CONTROL_*`).

`resolve_sidecar_path` strips Windows `\\?\` verbatim prefixes from
`resource_dir()` once at the boundary so every derived path is plain — the
reasons live in `docs/specs/dor-cli.md` (Bundling And PATH).

### Remote Host service

The remote Host — the relay socket, the enrollment, the ACL, the pairing
ceremony, remote-api v1 — runs **in the sidecar**, the process that owns the
PTYs. It is the same `RemoteHostService` the VS Code extension host runs
(`lib/src/host/remote/service.ts`, bound here by
`lib/src/host/remote/sidecar-entry.ts` and bundled to `sidecar/remote-host.cjs`
by `build-sidecar-proxy.mjs`, which bakes the relay-origin allowlist into it —
`docs/specs/server.md`). The webview keeps only what a webview is for: the
pairing modal, the console hook, ring detection for push, and answering for its
own panes. Nothing it says can widen access
(`docs/specs/remote-security-model.md`).

**State.** Rust creates the app-data directory, locks it owner-only, and passes
it as `DORMOUSE_STATE_DIR` (§Persistence, "Rust file store"); the sidecar's
`FileHostStateStore` keeps enrollment and ACL there as one `remote-host.json`,
0600 in a 0700 directory via temp-then-rename. One file rather than one per
value, so a write is one atomic rename and the enrollment can never end up
describing a different Host than the records approved under it. `hostToken` is a
bearer credential and never enters a webview realm. Three invariants — this
store's application of the shared store contract (`docs/specs/server.md` →
"Host side"):

- **Reads fail closed.** Only `ENOENT` — nothing written yet — and a file that
  was read but cannot be parsed answer empty; the parse failure warns, because
  an empty ACL silently de-pairs every device. Any other read error (EACCES,
  EIO, a held handle on Windows) says nothing about what the file holds, so it
  is neither answered nor memoized: the load rejects and, because every change
  is a read-modify-write of the whole file, takes the save behind it with it
  rather than overwriting unseen state with nothing. A later read still recovers.
- **The in-memory view advances only after the rename succeeds**, so a failed
  save cannot be mistaken for durable state by a later adoption. (Re-tightening
  a directory Rust already created is best-effort: failing the save over the
  directory would lose the Host instead.)
- **Every `HostStateStore` states `persistent` outright.** With no state
  directory — Rust passes an empty value when it cannot create one — the sidecar
  falls back to a store that still *holds* both values in memory rather than
  dropping the writes: reads that answered empty would de-pair each device the
  moment it was approved, since the ACL a Host authorizes against is the one it
  just wrote. Nothing survives the process, it warns once, and it reports
  `persistent: false`, which `adopt` relays so the webview keeps its own copy of
  the Host rather than clearing the only one that outlives the run — a store
  that omitted the flag would read as durable and cost the webview that copy.
  The browser dev harness is *not* this case: it passes a per-run temp
  directory, so a dev enrollment lives and dies with that run.

**The bridge.** Webview → sidecar is one generic passthrough invoke,
`remote_host_command(payload)`, which writes `{"event":"remoteHost:command",
"data":payload}` to stdin; the sidecar's dispatch table hands it to
`handleCommand`. Sidecar → webview is three ordinary stdout events —
`remoteHost:result`, `remoteHost:ask`, `remoteHost:event` — forwarded by Rust's
generic `handle.emit`. **The correlation field is `rhId`, never `requestId`:**
Rust swallows any sidecar line whose `data.requestId` matches a pending invoke
in order to resolve it, so a `requestId` here would make results vanish at
random. The contract is shared by both ends
(`lib/src/host/remote/service-protocol.ts`), and the webview half of it — the
pending-command table, the 15s timeout, the always-answer rule for asks — is
`lib/src/host/remote/link-client.ts`, shared with VS Code and the browser dev
harness so no host settles a command differently.

**Asks and answers.** What the sidecar cannot know — what a pane is called,
whether it is focused, how big its xterm is — it asks over `remoteHost:ask`, and
the responder in `lib/src/remote/host/peer-surfaces.ts` answers as an ordinary
`answer` command naming the ask's own `rhId`. The **first answer settles** the
ask: standalone ships one window, so there is exactly one answerer. That is the
seam where a multi-window standalone would instead collect until the budget
(`ASK_BUDGET_MS`, 1s), which otherwise only bounds a webview that is reloading —
an attach must not hang on one.

An answer for an ask the bridge no longer holds **invalidates the directory**
rather than being dropped: the ask settled empty, so the snapshot the Host
already rendered is missing whatever that answer names (an empty picker on a
machine that does have terminals), and nothing re-opens a settled ask, so the
next collect is the only repair — and an idle machine has no other reason to run
one. VS Code's in-window fan-out does the same (`docs/specs/vscode.md`).

**Stripping.** Unlike VS Code's extension host, the sidecar hands the webview
*raw* PTY bytes and the webview's own parser strips them for its xterm, so the
phone would otherwise see a stream the laptop's xterm never renders. The service
therefore runs its own strip-only `TerminalProtocolParser` over each PTY it
streams, discarding every event it produces (responses included) and built with
a constant colour provider so an OSC 10/11/12 `?` query is *consumed* rather
than declined — full rationale in `docs/specs/terminal-escapes.md`. One parser
**per PTY, not per attachment**: what an incomplete escape sequence leaves
behind belongs to that PTY's byte boundaries, and a late joiner inheriting that
state beats a fresh parser starting mid-sequence.

The tap is inside `pty-core`'s event callback in `main.js`, ahead of the send to
the webview, and is wrapped: **a remote listener must never break the local
pipe**, so a throw is logged to stderr and the webview's `pty:*` event is sent
either way. With nothing attached, data still returns after cheap id/map checks;
exit codes are retained so a stream installed after surface resolution can
replay liveness before attach acknowledgement.

Source of truth: `standalone/sidecar/main.js` (the tap and the
`remoteHost:command` case), `remote_host_command` / `remote_host_state_dir` in
`standalone/src-tauri/src/lib.rs`, `lib/src/host/remote/sidecar-entry.ts`, and
`lib/src/host/remote/pty-strip.ts`.

### Windows node subsystem

On Windows the app carries **two** subsystem variants of the same `node.exe`,
because the sidecar and the `dor` CLI have opposite console requirements. Each
layer below is a workaround for the one above it:

1. **The app is a GUI process that spawns a Node sidecar.** Spawning a
   *console-subsystem* process from a GUI app triggers Win11's DefTerm handoff:
   Windows launches Windows Terminal to host it, flashing a stray WT window
   behind Dormouse. `CREATE_NO_WINDOW` / `DETACHED_PROCESS` do not opt out of
   that handoff (tested) — only a non-console subsystem does.
2. **So `build.rs` patches the bundled `node.exe` to the GUI subsystem**
   (`force_windows_gui_subsystem`). The sidecar runs under that GUI node and
   talks to Rust over explicit piped stdio, which it serves fine.
3. **But a GUI-subsystem node does not attach to an *inherited* console**, and
   `dor` runs inside a shell's ConPTY where stdout/stderr are console handles
   (not pipes) — so a GUI node silently drops everything `dor` prints. Hence
   `start_sidecar` derives a **console-subsystem** copy once
   (`resolve_dor_node_path` → `ensure_console_subsystem_node`, flipping the PE
   subsystem byte back, cached in app-local data and re-derived when the bundled
   node's size changes) and points `DORMOUSE_NODE` at it, while the sidecar
   keeps the GUI node. `dor` always runs inside an existing pseudo-console, so
   the console copy can never cause a stray window.

The byte-flip is shared with `build.rs` via
`standalone/src-tauri/src/pe_subsystem.rs` so the load-bearing PE offsets live
in one place.

**Reconsider if the stray window can be suppressed another way.** Layers 2–3
exist solely to work around layer 1, on the single load-bearing assumption that
no spawn-time option suppresses the DefTerm handoff. If a `CREATE_NO_WINDOW` /
`STARTUPINFO` + `SW_HIDE` / job-object approach is ever shown to suppress it on
current Win11, delete both layers and ship the stock console node under
`DORMOUSE_NODE`. Re-verify the assumption before extending any of this.

## Sidecar lifecycle

Source of truth: `standalone/sidecar/main.js`.

Shutdown (`sidecar:shutdown` message, stdin EOF, or SIGTERM) is idempotent and
ordered:

1. `agentBrowser.closePoppedOut()` bounded by a 1.5s race, so quitting never
   orphans a headed Chrome window and a hung agent-browser cannot wedge the
   exit (mirrors the VS Code host's `deactivate()`; `docs/specs/dor-browser.md`).
2. Close the dor control socket.
3. Dispose the remote Host service (drops the relay socket and settles every
   outstanding ask, so nothing is left waiting on a webview that is going away).
4. `mgr.killAll()` (all PTYs), then `process.exit(0)`.

A parent-PID watchdog polls every 2s and self-triggers shutdown if the Tauri
process disappears: stdin EOF is not always delivered when the host is
force-killed (especially on Windows), and an orphaned sidecar would hold
`conpty.node`/`conpty.dll` open and block the NSIS installer
(`docs/specs/auto-update.md`, Sidecar teardown on Windows).

Host-side ordering: every quit trigger is driven through the webview quit
orchestrator (§Quit flow, which owns the teardown/install/exit sequence);
Tauri's `RunEvent::Exit` then runs `shutdown_sidecar_and_wait` as a final
backstop (harmless post-teardown — the PTY map is already empty, so the sidecar
`killAll` no-ops).

## AppBar

Source of truth: `standalone/src/AppBar.tsx`.

The AppBar is the draggable titlebar region and carries, left to right: a
`[New workspace]` button and — on Windows/Linux only, since macOS gets native
traffic lights from `titleBarStyle: "Overlay"` and left padding instead — the
window controls (minimize / maximize / close via `@tauri-apps/api/window`, with
window-focus tracking dimming the bar). It carries neither a theme picker nor a
shell picker: both live in the Settings dialog at the bottom-right of the window
(`docs/specs/theme.md`).

`[New workspace]` is a placeholder holding the spot the workspace strip will
take. It creates nothing — it calls `openExternal` on
https://github.com/diffplug/dormouse/issues/406, the tracking issue. The strip
lands here when the workspaces rollout reaches stage 3 —
`docs/specs/layout.md` `## Future` (workspaces-rollout).

Shell selection lives in the Settings dialog's **Shell** row
(`lib/src/components/ShellPicker.tsx` over `lib/src/lib/shell-store.ts`),
hidden when fewer than two shells were detected or when the host owns shell
selection itself (`hostOwnsShells`, VS Code). Picking a shell persists the
choice in `localStorage`, keyed by executable path plus ordered arguments (WSL
distributions and Windows Developer shells can share a path), publishes it via
`setDefaultShellOpts`, and dispatches `dormouse:new-terminal` with
`replaceUntouched: true, announce: true`, so an untouched selected terminal is
replaced in place (`docs/specs/layout.md`, Shell selection replacement) — after
dismissing the Settings dialog, so the replacement takes keyboard focus on the
next animation frame. Edge cases: legacy path-only selections restore the first
matching entry and gain the full identity on the next choice; re-picking the
visible fallback records that explicit choice without spawning a redundant
terminal; re-seeding an unchanged detected list is a no-op, which preserves an
interactive selection without notifying subscribers during render but also
skips re-reading the persisted key, so clearing that key alone does not reset a
same-list Storybook story.

### Application menu

Source of truth: the `.menu(...)` builder in `standalone/src-tauri/src/lib.rs`.

The app replaces Tauri's default menu with a macOS-only App submenu (about /
services / hide / hide-others / quit) and a Window submenu (minimize / maximize
/ close) — deliberately **no Edit submenu**, because its predefined Paste item
binds Cmd+V natively and would fire alongside the terminal's own DOM-level
Cmd+V handling (`docs/specs/mouse-and-clipboard.md` §8.2).

The consequence is that macOS delivers Cmd+C/X/V to the webview as plain
keydowns and WKWebView performs no native edit, in Dormouse's own text fields
too (pane rename, the browser URL editor, dialogs); those get their clipboard
from the wall's keyboard chain instead (`docs/specs/mouse-and-clipboard.md`
§8.9). Any future menu item must not claim a chord the webview already handles.

## Persistence

`TauriAdapter.saveState` / `getState` route the session blob through
`lib/src/lib/window-persistence.ts` (`loadSessionState` / `saveSessionState`)
— the standalone adapter boundary where the `PersistedWindow` wrapping lives,
identity-passthrough while the workspaces flag is off
(`docs/specs/transport.md`, Workspace/Window containers). The backing store is
**not** WebKit `localStorage`: `window-persistence.ts` reads/writes through the
`SessionKeyValueStore` seam, and the standalone adapter supplies a Rust-backed
implementation (`standalone/src/tauri-session-store.ts`). Theme selection still
persists through the theme store on `localStorage` (`docs/specs/theme.md`); it
is tiny and rarely written, so it does not stress the WebKit store.

**Why not `localStorage`.** WKWebView stores `localStorage` as SQLite in WAL
mode. Dormouse rewrites the multi-MB scrollback-bearing session blob on every
save, and WebKit pins its own WAL with a long-lived reader that never advances
during a running session — so the WAL is never checkpointed and grows unbounded
(observed ~1 GB after a few hours; an external checkpoint is blocked by the same
reader). A days-long session made this pathological.

**Rust file store.** `save_session(window, state)` / `load_session(window)` /
`clear_session(window)` (`lib.rs`) persist the blob as one atomic file per Tauri
window — `<app_data_dir>/sessions/<label>.json` (the label sanitized so it
cannot escape the directory), written temp-then-rename so a crash cannot
truncate the previous snapshot. The temp file is fsynced before the rename, and
on unix the sessions directory is fsynced *after* it, because a directory-entry
fsync is what makes the rename itself durable (Windows has no equivalent
concept, so that step is unix-only). There is no WAL to grow, and overwriting in
place bounds the on-disk size to one blob. **Window identity is implicit**: each
command keys by the invoking `tauri::Window`'s `label()`, so the frontend stays
window-agnostic and a second window (`win-2`, …) persists to its own file
without ever rewriting the first window's blob — the store is multi-window even
though the app ships a single window today.

**Owner-only on disk.** The blob carries terminal transcripts, so under the bare
umask it landed `0644` in a `0755` directory and any other local account could
read the user's scrollback (`SECURITY.md` -> Remote Control, Credentials at
rest). `restrict_to_owner` sets `0700` on the directory and `0600` on the temp
file *before any bytes are written*, since the rename preserves its mode. A unix
mode is a silent no-op on Windows, so there the same function instead applies a
DACL protected from inheritance carrying exactly one entry, for the user the
process runs as; without it the directory keeps whatever `%LOCALAPPDATA%` hands
down, which is never owner-only.
`restrict_to_owner_leaves_one_owner_only_ace` asserts all four properties, the
fourth being that the entry reached a file that already *existed* when the lock
ran. That fourth leg is what `remote_host_state_dir` relies on: it locks the
sidecar's state directory with the same call, and on an upgrade the Host
enrollment file is already there, so propagation rather than create-time
inheritance is what tightens it (`FileHostStateStore`'s own `0700`/`0600` cannot
help — Node has no ACL API). Neither call is fatal, since a filesystem without
the permission model it wants must not fail a save; but the state-dir one logs a
`WARNING` naming the path rather than failing silently, because on Windows it is
the only thing restricting `hostToken`.

**Boot + the synchronous-read constraint.** `getState()` is synchronous because
cold-start restore reads it before React mounts, but a Tauri `invoke` is async.
`TauriSessionStore` resolves this with an in-memory write-through cache:
`TauriAdapter.init()` (awaited by `bootstrap()` before `resumeOrRestore`)
`hydrate`s the cache from `load_session`, `getItem` returns the cache
synchronously, and `setItem` updates the cache and forwards to `save_session`
asynchronously, coalescing bursts to at most one in-flight write (latest value
wins). This mirrors how the VS Code adapter reads a host-injected seed
(`docs/specs/vscode.md`).

**Dirty-gated writes.** An idle app must not rewrite the multi-MB blob. The save
cadence is shared frontend code, so every adapter benefits: a generation-counter
dirty tracker gates the periodic heartbeat, fed by two trigger classes.
**Structural** Lath store commits (layout change, pane add/remove, active pane)
*schedule* a 500 ms-debounced save. **Content** inputs that change the persisted
blob with no Lath commit — `onPtyData` (scrollback, OSC CWD, title candidates),
`subscribeToActivity`, `subscribeToTerminalPaneState`, and door-state changes —
only *mark dirty*, never schedule, or a busy terminal would rewrite every
500 ms. The 30 s heartbeat then persists only when the tracker is dirty, so an
idle session issues zero writes. The tracker is conservative under races: a save
captures its target generation before serializing and clears dirty only on a
fulfilled write, so a change arriving mid-save costs at most one redundant save
and is never lost. Flush paths — PTY exit, `onRequestSessionFlush`, `pagehide`,
unmount — stay **unconditional**: they are the correctness net for any
dirty-trigger hole (a program calling `chdir()` emits no event, so its persisted
CWD may go stale until the next output — accepted). As a store-level backstop,
`TauriSessionStore.setItem` short-circuits when the new blob byte-equals the
cached one; the cache is boot-seeded from disk, so the compare is valid from the
first write. Source of truth: `lib/src/lib/session-dirty.ts`,
`lib/src/components/wall/use-session-persistence.ts`,
`standalone/src/tauri-session-store.ts`.

**Durability on quit.** `saveState` returns after updating the cache and merely
*firing* `save_session`, so the quit orchestrator (§Quit flow) awaits the
pipeline all the way to disk: `requestSessionFlush` drives the frontend's
debounced/heartbeat save through `saveState`, then `drainSessionSaves` awaits
`TauriSessionStore.drain()` (resolves when the write pipeline goes idle) under a
bounded timeout, and each `save_session` is itself durable through the
temp-then-rename + dir fsync. The final debounce/heartbeat window is therefore
not lost, which the old WebKit-flush-on-teardown `localStorage` path did lose.

**Standalone persists no Session state.** Quitting the app is a deliberate ending
and a crash captured nothing, so every launch starts fresh
(`docs/specs/transport.md` → "The governing rule"). One `PERSIST_SESSION` gate
drives all of it: `TauriAdapter.getState` returns null, `saveState` is a no-op, and
the adapter reports `persistsSession: false` so `saveSession` skips building a
record at all. That last part is why the gate is not merely cosmetic — otherwise
every debounced save, every 30s heartbeat, and both quit-time flushes would still
spend a `getCwd` round trip per terminal pane (a synchronous `lsof` in the sidecar
on macOS) to produce a blob that is then dropped. `init()` also **deletes** any
pre-upgrade snapshot via `clear_session`, unconditionally and including an
orphaned `<label>.json.tmp` (`docs/specs/transport.md` → "Retiring the
transcripts already on disk"). Deleting rather than blanking: a `''` write would
leave the bytes on disk until some later save and force every reader to treat
empty as a third state alongside present and absent. The store beneath the gate
is intact and still needed by the
workspaces-rollout scope (`docs/specs/layout.md` → `## Future`); restoring
VS Code-style recovery here later is flipping that gate plus adding capture to the
quit teardown, which already has the right ordering (flush → kill → flush → drain).

The browser-dev harness carries the same gate, for the same reason plus one of its
own: `BrowserSidecarAdapter.PERSIST_SESSION` is `false`, so `saveState` is a no-op,
`getState` returns null, and `persistsSession` is `false`. Its `init()` also
**deletes** the `dormouse.browser-sidecar.session` key rather than ignoring it —
snapshots carry transcripts, and `localStorage` is keyed by browser profile rather
than by the per-run temp state directory the harness gives every other slot
(`standalone/scripts/dev-agent-browser.mjs`), so a blob written before the gate
existed would otherwise outlive every run. Flip both `PERSIST_SESSION` flags
together; a harness that restored panes across a reload would be debugging a
save/restore path the shipped app does not take.

What the gate costs on reload is the *layout*, not the Sessions. Nothing wires
`shutdown()` to `beforeunload`, so the sidecar and its PTYs outlive a page reload
and `lib/src/lib/reconnect.ts` still resumes over them — but it reads `getState()`
for the saved resume plan, and with the gate on there is none, so every live PTY
lands in one tab group with doors and saved titles dropped. Real standalone has
always behaved this way across a WebView reload and the harness now matches it;
the cost is just more visible here, since enabling `abDebugLogs` means reloading
(`.claude/skills/debug-standalone-agent-browser/SKILL.md`).

## Quit flow

Source of truth: `standalone/src-tauri/src/lib.rs` (`QuitState`, `request_quit`,
the `quit_ack` / `quit_progress` / `quit_cancel` / `quit_proceed` commands, the `CloseRequested` /
`ExitRequested` arms) and `standalone/src/quit.ts` (the webview orchestrator).

Quitting ends every terminal. Rust intercepts **every** quit trigger so the
webview can tear terminals down gracefully and durably write the freshest
session first — historically to capture final scrollback, and now to keep the
ordering the workspaces-rollout scope will reuse.

**Trigger interception.** Two Rust arms funnel into `request_quit(app)`:

- `WindowEvent::CloseRequested` (the window close button) — `api.prevent_close()`
  unless the quit is already approved. *Multi-window seam*: one window ships
  today, so a per-window close is the whole-app quit; a multi-window build would
  give each `CloseRequested` a per-window teardown and only quit on the last.
- `RunEvent::ExitRequested` (Cmd+Q / app-menu Quit / dock quit / interceptable OS
  logout) — `api.prevent_exit()` unless approved. The event's `code` is
  deliberately ignored: the `approved` gate alone is what lets the flow's own
  terminating `app.exit(0)` through without re-catching it.

**The ack / progress / proceed / cancel protocol.** `request_quit` clears
`acked`, bumps `seq`, and emits `dormouse://quit-requested` to the webview. It
deliberately does **not** clear `tearing_down`: a cancel happens before
teardown, so it is already false for a genuinely fresh quit, and a repeat
trigger fired mid-teardown must keep it set or the fresh watchdog would drop
into the unbounded phase-2 wait and stop bounding the in-flight teardown. The
webview's orchestrator (registered by `initQuitFlow`, Tauri-only) responds:

1. **Always `quit_ack`** first (fire-and-catch), so Rust's phase-1 watchdog
   stands down even if the orchestrator then dedupes the event out.
2. When teardown actually begins (immediately on an all-idle quit, or after the
   user confirms), **`quit_progress`** — sets `tearing_down` and bumps a
   `progress` counter. It is sent again at the install phase boundary so each
   phase gets its own watchdog budget.
3. Runs the teardown (below), then **`quit_proceed`** — which sets `approved` and
   calls `app.exit(0)`. That re-enters `ExitRequested` with `approved` true and
   the app exits.
4. A confirmation-dialog cancel (below) calls **`quit_cancel`** — bumps `seq`
   (invalidating the live watchdog) and leaves the app running.

A cloned-`AppHandle` **watchdog** thread keeps quit bounded against a dead or
wedged webview, in three phases:

- **Phase 1 — ack (~2 s).** No `quit_ack` within the window ⇒ the listener is
  dead; log and `app.exit(0)`.
- **Phase 2 — awaiting teardown (unbounded).** Acked but `tearing_down` not yet
  set: the webview may be parked on the confirmation dialog **waiting on a
  human**, so the watchdog holds with *no deadline* — only `quit_proceed`
  (`approved`) or `quit_cancel`/repeat-trigger (`seq` bump) ends the wait. A slow
  user is never force-quit out from under the dialog.
- **Phase 3 — teardown running (per-phase ~12 s).** Once `tearing_down` is set,
  poll under a **per-phase** budget that each `quit_progress` bump refreshes, so
  a long teardown and a long update install get separate budgets instead of
  sharing one total; a phase that makes no progress for the budget ⇒ log and
  exit. The ~12 s comfortably exceeds the webview's own 8 s teardown ceiling.

Each watchdog captures the `seq` it was spawned for; a **repeated quit trigger**
bumps `seq` (spawning a fresh watchdog and re-emitting), so the stale watchdog
exits without acting — this is the user's escape hatch if the webview acked then
wedged.

**Confirmation dialog.** Source of truth: `standalone/src/quit-confirm-store.ts`
(the module store + gate) and `standalone/src/QuitConfirmModal.tsx` (the modal);
`main.tsx` wires the gate on the Tauri branch (`setQuitConfirmGate(openQuitConfirm)`;
order relative to `initQuitFlow` is irrelevant — the gate is read only at quit
time). When `handleQuitRequested` finds **≥1 running session** it hands the
decision to the installed gate instead of tearing down; with no running work (or
no gate) it falls straight through to the teardown, so an all-idle quit never
prompts. A session counts as running iff its latest activity is a live command
(`activity.kind === 'running'`); `countRunningSessions`
(`lib/src/lib/terminal-state-store.ts`) is both the gate's predicate and the
dialog's live count.

- **Live count.** The body reads `countRunningSessions` through
  `useSyncExternalStore(subscribeToTerminalPaneState, …)`, so it tracks commands
  finishing while the dialog is up. **If the count drops to 0 the dialog stays
  open** — auto-quitting out from under the user would surprise — and the copy
  just shows "No commands are still running." with the same buttons.
- **Cancel / Escape** (the Cancel button takes initial focus as the safe
  default) close the dialog and call `ctx.cancel()` → `quit_cancel`: the app and
  every terminal are left untouched and a later quit starts fresh.
- **Confirm** calls `ctx.confirm()`, which runs the normal teardown; the dialog
  switches to a non-interactive "Quitting…" state (both buttons disabled, Escape
  inert) until the process exits. The store nulls its context the instant a
  decision is made, so a redundant confirm/cancel is a no-op; combined with the
  orchestrator's `quitPhase` dedupe, a repeated quit trigger while the dialog is
  open neither re-opens nor stacks it.
- **Mount.** `<QuitConfirmModalHost>` rides Wall's `dialogHost` prop (`main.tsx`
  → `App` → `Wall`), rendered unconditionally beside the built-in modal hosts
  inside Wall's `DialogKeyboardContext` provider, which the host toggles while
  visible so command-mode keyboard dispatch is suppressed under the modal. The
  modal is a focus-trapped `ModalFrame` (`layer="critical"`,
  `backdrop="strong"`), matching the ExternalLinkModal pattern
  (`docs/specs/layout.md`).

**Teardown ordering (`runQuitTeardown`), and why.** Wrapped in an 8 s ceiling;
every step is individually bounded so a stall can't wedge quit:

1. `requestSessionFlush` — save while PTYs are alive, so CWDs are fresh.
2. `gracefulKillAllPtys` — SIGTERM every PTY (§Rust ↔ sidecar bridge); resolves
   early once all exit. This **precedes** capture on purpose: a PTY's scrollback
   buffer survives its exit and is only cleared by the *hard* `pty_kill` / sidecar
   `killAll`, so graceful termination leaves the final output intact.
3. `requestSessionFlush` — capture that now-final scrollback of the dead PTYs.
   `getCwd` returns null for a dead PTY, and session-save falls back to the
   previously persisted CWD.
4. `drainSessionSaves` — await the last `save_session` reaching disk. This is
   where the clean-quit **durability guarantee** is met (§Persistence, "Durability
   on quit"): the process does not exit until this write lands.
5. If an update is pending, a fresh `quit_progress` (giving install its own
   watchdog budget, not the teardown remainder) then `installPendingUpdate()` —
   strictly *after* the completed save (`docs/specs/auto-update.md`); Rust's
   phase-3 watchdog backstops a hung installer.
6. **Always** `quit_proceed` (in `finally`, even on throw/timeout).

**Windows note.** node-pty's `kill('SIGTERM')` is an immediate kill under ConPTY
(no graceful-signal delivery), so step 2 terminates promptly there — but the
scrollback buffer still survives the exit, so step 3 captures the final output
just as it does elsewhere.

**Dev-mode note.** The browser-dev harness (`VITE_DORMOUSE_BROWSER_DEV_HOST`) has
no Rust quit interception; `bootstrap()` only calls `initQuitFlow` on the real
Tauri branch, so the flow never initializes there.

## File drop

The `WindowEvent::DragDrop` handler in `lib.rs` emits the dropped paths as
`dormouse://files-dropped`; `TauriAdapter` fans that out to
`onFilesDropped`, and the Wall pastes them into the selected pane as escaped,
space-joined input. The whole path is **inert today**: `tauri.conf.json` sets
`dragDropEnabled: false` so HTML5 drag-and-drop inside the webview keeps working
(tauri-apps/tauri#14373, dormouse#38). Behavior and status are specified in
`docs/specs/mouse-and-clipboard.md` (§8.7 Drag-to-Paste).

## Logging

Windows release builds use the GUI subsystem, so nothing streams to a
launching terminal. The Rust backend appends sidecar stdout/stderr lines and
its own diagnostics to a log file: `%LOCALAPPDATA%\Dormouse Terminal\dormouse.log`
on Windows, `$TMPDIR/dormouse.log` elsewhere, overridable via
`DORMOUSE_LOG_FILE` (`docs/specs/deploy.md`, Packaged app logging). The
updater debug modal reads it back through `read_update_log`.

## Build and development

Source of truth: `standalone/package.json` (package scripts),
`standalone/src-tauri/tauri.conf.json` (`build`, `bundle.resources`), and the
root `package.json` for the `dev:standalone*` orchestration.

- `stage` = `stage:dor-cli` (build + stage the dor CLI, `docs/specs/dor-cli.md`)
  plus `stage:sidecar-proxy` (`build-sidecar-proxy.mjs` bundles the
  `lib/src/host/` sources into the sidecar `.cjs` files).
- The `tauri` script stages, then runs `standalone/scripts/tauri.mjs`, which
  delegates to the Tauri CLI. The `DORMOUSE_REMOTE_CONNECT_SRC` build-time
  override for self-host relay origins is baked into the sidecar's remote-host
  bundle by `build-sidecar-proxy.mjs` — the Host runs in the sidecar, so the
  webview CSP has no relay sources at all, which
  `standalone/scripts/tauri-conf.test.mjs` asserts against `tauri.conf.json`
  (`docs/specs/server.md`, "Where a Host may reach a relay server").
- The Tauri bundle ships the whole sidecar via the `../sidecar/**/*` resources
  glob — including node-pty's prebuilds + bundled ConPTY and the
  shell-integration scripts (`docs/specs/terminal-escapes.md`).
- **Dev caveat:** `tauri.conf.json`'s `beforeDevCommand` is `pnpm dev` (Vite
  only). Frontend edits hot-reload, but changes to the sidecar, the staged dor
  CLI, or the bundled `lib/src/host/` sources need a manual re-stage and app
  restart — the dev loop does not watch them.
- `pnpm dev:standalone:ab` runs the sidecar + webview in a normal browser via
  the browser-dev harness instead of the Tauri WebView
  (`docs/specs/transport.md`, Standalone browser-dev harness).

## Files

| File | Role |
|------|------|
| `standalone/src-tauri/src/lib.rs` | Rust backend: sidecar spawn/supervision, invoke commands, event forwarding, per-window session file store (`save_session` / `load_session`), quit interception (`QuitState`, `request_quit`, `quit_ack` / `quit_progress` / `quit_cancel` / `quit_proceed`, §Quit flow), file drop, logging, dock icon, exit teardown |
| `standalone/src-tauri/src/clipboard_win.rs` | Native Win32 clipboard reads on Windows (owned by `docs/specs/mouse-and-clipboard.md`) |
| `standalone/src-tauri/src/pe_subsystem.rs` | Shared PE-subsystem byte-flip (offset lookup + read/set) used by `build.rs` (GUI-patch the bundled sidecar node) and `lib.rs` (derive the console-subsystem `dor` node) — §Windows node subsystem |
| `standalone/scripts/tauri.mjs` | Tauri CLI wrapper (`pnpm tauri` runs `stage` first, so the relay allowlist is already baked into the sidecar bundle, not into the webview CSP) |
| `standalone/src-tauri/tauri.conf.json` | Window config, dev/build commands, sidecar resources glob, updater config |
| `standalone/src/main.tsx` | Webview bootstrap (boot sequence above); initializes the quit orchestrator and installs the confirmation gate on the Tauri branch, mounts `<QuitConfirmModalHost>` via Wall's `dialogHost` prop |
| `standalone/src/quit.ts` | Quit orchestrator: listens for `dormouse://quit-requested`, runs the graceful teardown, calls `quit_ack` / `quit_progress` / `quit_proceed` / `quit_cancel` (§Quit flow) |
| `standalone/src/quit-confirm-store.ts`, `QuitConfirmModal.tsx` | Quit-confirmation dialog: the running-work gate + module store, and the modal mounted via Wall's `dialogHost` prop (§Quit flow, "Confirmation dialog") |
| `standalone/src/AppBar.tsx` | Titlebar: New workspace placeholder, window controls |
| `standalone/src/tauri-adapter.ts` | `TauriAdapter`: PlatformAdapter over Tauri invoke/events, session persistence via the Rust store, control-request dispatch |
| `standalone/src/tauri-session-store.ts` | `TauriSessionStore`: Rust-backed `SessionKeyValueStore` — boot-seeded write-through cache over `load_session` / `save_session` (§Persistence) |
| `standalone/src/updater.ts`, `UpdateBanner.tsx`, `UpdateDebugModal.tsx` | Auto-update (owned by `docs/specs/auto-update.md`) |
| `standalone/src/browser-sidecar-host.ts`, `browser-sidecar-adapter.ts` | Browser-dev harness (owned by `docs/specs/transport.md`) |
| `standalone/sidecar/main.js` | Sidecar entry: stdio JSON-lines dispatch, shutdown ordering, parent-PID watchdog |
| `standalone/sidecar/pty-core.js` | Shared PTY manager (owned by `docs/specs/transport.md`) |
| `standalone/sidecar/dor-control-server.js` | dor CLI control socket (owned by `docs/specs/dor-cli.md`) |
| `standalone/sidecar/clipboard-ops.js` | OS clipboard tiers (owned by `docs/specs/mouse-and-clipboard.md`) |
| `lib/src/host/remote/sidecar-entry.ts` | Sidecar binding of the remote Host service, bundled to `sidecar/remote-host.cjs` (§Remote Host service; protocol owned by `docs/specs/remote-api.md`) |
| `standalone/scripts/build-sidecar-proxy.mjs` | Bundles `lib/src/host/` into the sidecar `.cjs` copies |
| `standalone/scripts/dev-agent-browser.mjs` | `dev:standalone:ab` entry (owned by `docs/specs/transport.md`) |
