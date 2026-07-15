# Dormouse Standalone (Tauri) Integration Spec

> See `docs/specs/glossary.md` for Session / Surface / Pane / Door vocabulary. See `docs/specs/transport.md` for the PTY lifecycle, message protocol, persisted-session types, and adapter-agnostic invariants the standalone app shares with the VS Code and fake adapters. This spec covers the standalone-specific layer: the Tauri window, the Rust ↔ sidecar bridge, the AppBar, persistence at the adapter boundary, shutdown ordering, logging, and the build/dev workflow.

## Architecture

```
Tauri app process (Rust — standalone/src-tauri/src/lib.rs)
├── WebView (Vite frontend — standalone/src/)
│   ├── main.tsx           — bootstrap: platform init, theme restore, resumeOrRestore, updater
│   ├── AppBar.tsx         — draggable titlebar: shell dropdown, theme picker, window controls
│   ├── tauri-adapter.ts   — TauriAdapter (PlatformAdapter over Tauri invoke/events)
│   ├── updater.ts         — auto-update state machine (docs/specs/auto-update.md)
│   └── browser-sidecar-{host,adapter}.ts — browser-dev harness (docs/specs/transport.md)
└── Node sidecar (standalone/sidecar/main.js — spawned by Rust at setup)
    ├── pty-core.js            — shared PTY manager (docs/specs/transport.md; also used by the VS Code pty-host)
    ├── dor-control-server.js  — dor CLI control socket (docs/specs/dor-cli.md)
    ├── iframe-proxy.cjs       — bundled from lib/src/host/iframe-proxy.ts (docs/specs/dor-browser.md)
    ├── agent-browser-host.cjs — bundled from lib/src/host/agent-browser-host.ts (docs/specs/dor-browser.md)
    ├── clipboard-ops.js       — OS clipboard: paste-read tiers for macOS/Linux (Windows reads go native in Rust); agent-browser clipboard writes on all platforms (docs/specs/mouse-and-clipboard.md §8.6, docs/specs/dor-browser.md)
    └── shell-integration/     — injected shell hook scripts (docs/specs/terminal-escapes.md)
```

The Rust layer is deliberately thin: it spawns and supervises the sidecar,
bridges the webview to it, and owns the OS-integration edges (window events,
file drop, dock icon, logging). Everything with real logic — PTYs, the dor
control server, the iframe proxy, the agent-browser host — runs in the Node
sidecar, sharing the same modules the VS Code host runs
(`build-sidecar-proxy.mjs` bundles the `lib/src/host/` sources into the
sidecar's `.cjs` copies, so the two hosts cannot drift).

## Boot sequence

Source of truth: `standalone/src/main.tsx` (`bootstrap()`).

1. Pick the platform: `BrowserSidecarAdapter` when `VITE_DORMOUSE_BROWSER_DEV_HOST`
   is set (the browser-dev harness, `docs/specs/transport.md`), otherwise
   `TauriAdapter`.
2. `setPlatform(platform)` then `await platform.init()` **before**
   `resumeOrRestore` — init registers the event listeners that resume replay
   arrives on.
3. `initAlertStateReceiver()`, `restoreActiveTheme()` (`docs/specs/theme.md`).
4. `getAvailableShells()` seeds the AppBar dropdown and
   `setDefaultShellOpts` (the default-shell slot used by split/spawn/restore
   paths, `docs/specs/layout.md`).
5. `resumeOrRestore(platform)` runs the priority-based recovery from
   `docs/specs/transport.md`.
6. `startUpdateCheck()` (`docs/specs/auto-update.md`), then render `AppBar` +
   `App` with `enableRemoteHost` (activating the remote Host module —
   enrollment, pairing modal, relay socket; `docs/specs/server.md` Host side),
   threading `<ConnectedUpdateBanner />` through the `baseboardNotice` slot.

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
the `clipboard` readers, `read_update_log`, and `kill_sidecar_now` — each a thin
forwarder to the corresponding sidecar message. `load_session` / `save_session` are the
exception that is *not* forwarded: they read/write the per-window session file
directly in Rust (§Persistence). Two further carve-outs: on Windows the
clipboard readers skip the sidecar and read the Win32 clipboard natively
(`clipboard_win.rs`; behavior in `docs/specs/mouse-and-clipboard.md` §8.6),
and `agent_browser_screenshot` receives a temp-file *path* from the sidecar
and reads the bytes in Rust so images never ride the JSON-lines pipe shared
with PTY traffic (`docs/specs/dor-browser.md`). Request/response commands block on the
sidecar's reply with a timeout; `OPEN_PORT_TIMEOUT_MS` in `lib.rs` mirrors the
constant in `lib/src/lib/platform/types.ts` and the two must stay in sync.
`pty_graceful_kill_all` (`TauriAdapter.gracefulKillAllPtys`) SIGTERMs every live
PTY and awaits the sidecar's `gracefulKillDone` (echoing the request's
`requestId`; bounded at `timeout + 1.5s`). `gracefulKillDone` fires early once
every PTY has exited — one 50 ms grace tick after the last exit, so ConPTY's
late final flush still lands — or at the timeout for SIGTERM-ignoring programs.
Unlike the hard `pty_kill` path it preserves scrollback, so final output stays
readable via `pty_get_scrollback`; it is the hook the quit flow's graceful
teardown calls (§Quit flow).
Sidecar events (`pty:*`, dor control requests, async results) are emitted to
the webview, where `TauriAdapter` converts dor control requests into the
`dormouse:control-request` CustomEvent that `Wall` handles
(`docs/specs/dor-cli.md`, Host Plumbing — including the sidecar env:
`DORMOUSE_NODE`, `DORMOUSE_CLI_*`, `DORMOUSE_CONTROL_*`).

`resolve_sidecar_path` strips Windows `\\?\` verbatim prefixes from
`resource_dir()` once at the boundary so every derived path is plain — the
reasons live in `docs/specs/dor-cli.md` (Bundling And PATH).

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
   talks to Rust over explicit piped stdio, which a GUI-subsystem node serves
   fine.
3. **But a GUI-subsystem node does not attach to an *inherited* console**, and
   `dor` runs inside a shell's ConPTY where stdout/stderr are console handles
   (not pipes) — so a GUI node silently drops everything `dor` prints (every
   command appears to produce no output). So `start_sidecar` derives a
   **console-subsystem** copy once (`resolve_dor_node_path` →
   `ensure_console_subsystem_node`, flipping the PE subsystem byte back to
   console, cached in app-local data) and points `DORMOUSE_NODE` at it, while
   the sidecar itself keeps the GUI node. `dor` always runs inside an existing
   pseudo-console, so the console copy can never cause a stray window.

The PE subsystem byte-flip is shared with `build.rs` via
`standalone/src-tauri/src/pe_subsystem.rs` so the load-bearing PE offsets live
in one place.

**Reconsider if the stray window can be suppressed another way.** This entire
two-variant mechanism (layers 2–3: the GUI patch *and* the console-node
derivation) exists solely to work around the layer-1 stray window. Its one
load-bearing assumption is that no spawn-time option suppresses the DefTerm
handoff. If a `CREATE_NO_WINDOW` / `STARTUPINFO` + `SW_HIDE` / job-object
approach is ever shown to suppress it on current Win11, delete layers 2–3 and
ship the stock console node under `DORMOUSE_NODE` — `dor` output then works with
no patching. Re-verify that assumption before extending any of this.

## Sidecar lifecycle

Source of truth: `standalone/sidecar/main.js`.

Shutdown (`sidecar:shutdown` message, stdin EOF, or SIGTERM) is idempotent and
ordered:

1. `agentBrowser.closePoppedOut()` bounded by a 1.5s race, so quitting never
   orphans a headed Chrome window and a hung agent-browser cannot wedge the
   exit (mirrors the VS Code host's `deactivate()`; `docs/specs/dor-browser.md`).
2. Close the dor control socket.
3. `mgr.killAll()` (all PTYs), then `process.exit(0)`.

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

The AppBar is the draggable titlebar region and carries, left to right: the
shell controls, the theme picker (`docs/specs/theme.md`), and the window
controls (minimize / maximize / close via `@tauri-apps/api/window`, with
window-focus tracking dimming the bar). The shell controls are:

- **`[+]`** — spawns a new terminal with the currently selected shell, selects it,
  and enters passthrough immediately
  (dispatches the `dormouse:new-terminal` CustomEvent that `Wall` listens
  for; the VS Code equivalent is the `dormouse:newTerminal` postMessage in
  `docs/specs/transport.md`).
- **Shell dropdown** — lists `getAvailableShells()`; picking a different
  shell updates `setDefaultShellOpts` and dispatches `dormouse:new-terminal`
  with `replaceUntouched: true, announce: true`, so an untouched selected
  terminal is replaced in place (`docs/specs/layout.md`, Shell selection
  replacement).

The workspace strip lands here when the workspaces rollout reaches stage 3 —
`docs/specs/layout.md` `## Future` (workspaces-rollout).

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

**Rust file store.** `save_session(window, state)` / `load_session(window)`
(`lib.rs`) persist the blob as one atomic file per Tauri window —
`<app_data_dir>/sessions/<label>.json`, written temp-then-rename so a crash
cannot truncate the previous snapshot. The temp file is fsynced before the
rename, and on unix the sessions directory is fsynced *after* the rename (a
directory-entry fsync is what makes the rename itself durable; Windows has no
equivalent concept, so that step is unix-only). There is no WAL to grow, and
overwriting in place bounds the on-disk size to one blob. **Window identity is implicit**:
each command keys by the invoking `tauri::Window`'s `label()`, so the frontend
stays window-agnostic and a second window (`win-2`, …) persists to its own file
without ever rewriting the first window's blob — the store is multi-window even
though the app ships a single window today.

**Boot + the synchronous-read constraint.** `getState()` is synchronous because
cold-start restore reads it before React mounts, but a Tauri `invoke` is async.
`TauriSessionStore` resolves this with an in-memory write-through cache: `init()`
(awaited by `bootstrap()` before `resumeOrRestore`) hydrates the cache from
`load_session`, `getItem` returns the cache synchronously, and `setItem` updates
the cache and forwards to `save_session` asynchronously, coalescing bursts to at
most one in-flight write (latest value wins). This mirrors how the VS Code
adapter reads a host-injected seed (`docs/specs/vscode.md`).

**Dirty-gated writes.** An idle app must not rewrite the multi-MB blob. The save
cadence is shared frontend code (`lib/src/components/wall/use-session-persistence.ts`),
so every adapter benefits: a generation-counter dirty tracker
(`lib/src/lib/session-dirty.ts`) gates the periodic heartbeat. Two distinct
trigger classes feed it. **Structural** Lath store commits (layout change, pane
add/remove) keep their existing 500 ms-debounced *schedule* — the cadence is
byte-identical to before. **Content** inputs that change the persisted blob with
no Lath commit — terminal output (`onPtyData`: scrollback, OSC CWD, title
candidates), Activity/TODO transitions (`subscribeToActivity`), pane
title/rename/command state (`subscribeToTerminalPaneState`), active-pane focus
(`onDidActivePanelChange`), and door-state changes — only *mark dirty*, never
schedule. (If PTY output scheduled saves, a busy terminal would rewrite every
500 ms — a regression versus today's heartbeat-only capture.) The 30 s heartbeat
then persists only when the tracker is dirty, so an idle session issues zero
writes. The tracker is conservative under races: a save captures its target
generation before serializing and clears dirty only on a fulfilled write, so a
change arriving mid-save costs at most one redundant save and is never lost.
Flush paths — PTY exit, `onRequestSessionFlush`, `pagehide`, and unmount — stay
**unconditional**: they are the correctness net for any dirty-trigger hole (e.g.
a program calling `chdir()` emits no event, so its persisted CWD may go stale
until the next output — accepted). As a store-level backstop under all of the
above, `TauriSessionStore.setItem` short-circuits when the new blob byte-equals
the cached one, suppressing any redundant `save_session` round-trip an upstream
trigger missed; the cache is boot-seeded from disk in `hydrate`, so the compare
is valid from the first write. Source of truth: `session-dirty.ts`,
`use-session-persistence.ts`, `standalone/src/tauri-session-store.ts`.

**Durability on quit.** A clean quit durably writes the latest state before the
process exits. `saveState` still returns after updating the cache and *firing*
`save_session`, but the quit orchestrator (§Quit flow) now awaits the pipeline to
disk: `requestSessionFlush` drives the frontend's debounced/heartbeat save
through `saveState`, then `drainSessionSaves` awaits `TauriSessionStore.drain()`
(resolves when the write pipeline goes idle) under a bounded timeout, and each
`save_session` is itself durable through the temp-then-rename (dir fsync). So the
final debounce/heartbeat window is no longer lost — the regression from the old
WebKit-flush-on-teardown `localStorage` path is closed. Unclean exits (crash,
force-kill) stay best-effort.

## Quit flow

Source of truth: `standalone/src-tauri/src/lib.rs` (`QuitState`, `request_quit`,
the `quit_ack` / `quit_progress` / `quit_cancel` / `quit_proceed` commands, the `CloseRequested` /
`ExitRequested` arms) and `standalone/src/quit.ts` (the webview orchestrator).

Quitting ends every terminal. Rust intercepts **every** quit trigger so the
webview can tear terminals down gracefully — capturing their final scrollback —
and durably write the freshest session before the process exits.

**Trigger interception.** Two Rust arms funnel into `request_quit(app)`:

- `WindowEvent::CloseRequested` (the window close button) — `api.prevent_close()`
  unless the quit is already approved. *Multi-window seam*: one window ships
  today, so a per-window close is the whole-app quit; a multi-window build would
  give each `CloseRequested` a per-window teardown and only quit on the last.
- `RunEvent::ExitRequested` (Cmd+Q / app-menu Quit / dock quit / interceptable OS
  logout) — `api.prevent_exit()` unless approved. Its `code` is `None` for a
  user-initiated exit and `Some` for the programmatic `app.exit(0)` that *ends*
  the flow; the `approved` gate lets that final exit through without re-catching
  it.

**The ack / progress / proceed / cancel protocol.** `request_quit` clears
`acked` and `tearing_down`, bumps `seq`, and emits `dormouse://quit-requested`
to the webview. The webview's orchestrator (registered by `initQuitFlow`,
Tauri-only) responds:

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
(`lib/src/lib/terminal-state-store.ts`) is the count, the same predicate the
gate check reads.

- **Live count.** The body reads `countRunningSessions` through
  `useSyncExternalStore(subscribeToTerminalPaneState, …)`, so it tracks commands
  finishing while the dialog is up. **If the count drops to 0 the dialog stays
  open** — auto-quitting out from under the user would surprise — and the copy
  just shows "No commands are still running." with the same buttons.
- **Cancel / Escape** (Escape and the Cancel button, which takes initial focus as
  the safe default) close the dialog and call `ctx.cancel()` → `quit_cancel`: the
  app and every terminal are left untouched and a later quit starts fresh.
- **Confirm** calls `ctx.confirm()`, which runs the normal teardown; the dialog
  switches to a non-interactive "Quitting…" state (both buttons disabled, Escape
  inert) until the process exits, so it can't be double-confirmed. The store nulls
  its context the instant a decision is made, so a redundant confirm/cancel is a
  no-op; combined with the orchestrator's `quitPhase` dedupe, a repeated quit
  trigger while the dialog is open neither re-opens nor stacks it.
- **Mount.** `<QuitConfirmModalHost>` is passed as Wall's `dialogHost` prop
  (`main.tsx` → `App` → `Wall`), which renders it beside the built-in modal
  hosts inside Wall's `DialogKeyboardContext` provider — unconditionally, unlike
  the Baseboard's `baseboardNotice` slot; the host toggles that context while
  visible so command-mode keyboard dispatch is suppressed under the modal. The
  modal itself is a `ModalFrame` (`layer="critical"`, `backdrop="strong"`,
  focus-trapped), matching the ExternalLinkModal pattern and the in-pane
  kill-confirmation aesthetic (`docs/specs/layout.md`).

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

The `WindowEvent::DragDrop` handler in `lib.rs` routes dropped paths to the
focused pane as escaped, space-joined paste input — but it is **inert
today**: `tauri.conf.json` sets `dragDropEnabled: false` so HTML5
drag-and-drop inside the webview keeps working
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
- The `tauri` script runs `standalone/scripts/tauri.mjs`, which rewrites the
  webview CSP via `standalone/scripts/csp.mjs` when the
  `DORMOUSE_REMOTE_CONNECT_SRC` build-time override for self-host relay
  origins is set (`docs/specs/server.md`, Host webview CSP), then delegates
  to the Tauri CLI.
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
| `standalone/scripts/tauri.mjs`, `csp.mjs` | Tauri CLI wrapper assembling the webview CSP (`DORMOUSE_REMOTE_CONNECT_SRC`) |
| `standalone/src-tauri/tauri.conf.json` | Window config, dev/build commands, sidecar resources glob, updater config |
| `standalone/src/main.tsx` | Webview bootstrap (boot sequence above); initializes the quit orchestrator and installs the confirmation gate on the Tauri branch, mounts `<QuitConfirmModalHost>` via Wall's `dialogHost` prop |
| `standalone/src/quit.ts` | Quit orchestrator: listens for `dormouse://quit-requested`, runs the graceful teardown, calls `quit_ack` / `quit_progress` / `quit_proceed` / `quit_cancel` (§Quit flow) |
| `standalone/src/quit-confirm-store.ts`, `QuitConfirmModal.tsx` | Quit-confirmation dialog: the running-work gate + module store, and the modal mounted via Wall's `dialogHost` prop (§Quit flow, "Confirmation dialog") |
| `standalone/src/AppBar.tsx` | Titlebar: shell dropdown, theme picker, window controls |
| `standalone/src/tauri-adapter.ts` | `TauriAdapter`: PlatformAdapter over Tauri invoke/events, session persistence via the Rust store, control-request dispatch |
| `standalone/src/tauri-session-store.ts` | `TauriSessionStore`: Rust-backed `SessionKeyValueStore` — boot-seeded write-through cache over `load_session` / `save_session` (§Persistence) |
| `standalone/src/updater.ts`, `UpdateBanner.tsx`, `UpdateDebugModal.tsx` | Auto-update (owned by `docs/specs/auto-update.md`) |
| `standalone/src/browser-sidecar-host.ts`, `browser-sidecar-adapter.ts` | Browser-dev harness (owned by `docs/specs/transport.md`) |
| `standalone/sidecar/main.js` | Sidecar entry: stdio JSON-lines dispatch, shutdown ordering, parent-PID watchdog |
| `standalone/sidecar/pty-core.js` | Shared PTY manager (owned by `docs/specs/transport.md`) |
| `standalone/sidecar/dor-control-server.js` | dor CLI control socket (owned by `docs/specs/dor-cli.md`) |
| `standalone/sidecar/clipboard-ops.js` | OS clipboard tiers (owned by `docs/specs/mouse-and-clipboard.md`) |
| `standalone/scripts/build-sidecar-proxy.mjs` | Bundles `lib/src/host/` into the sidecar `.cjs` copies |
| `standalone/scripts/dev-agent-browser.mjs` | `dev:standalone:ab` entry (owned by `docs/specs/transport.md`) |
