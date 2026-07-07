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
`pty_get_scrollback` / `get_available_shells`, `dor_control_response`,
`iframe_create_proxy_url`, the `agent_browser_*` family, the `clipboard`
readers, `read_update_log`, and `kill_sidecar_now` — each a thin forwarder to
the corresponding sidecar message. `load_session` / `save_session` are the
exception that is *not* forwarded: they read/write the per-window session file
directly in Rust (§Persistence). Two further carve-outs: on Windows the
clipboard readers skip the sidecar and read the Win32 clipboard natively
(`clipboard_win.rs`; behavior in `docs/specs/mouse-and-clipboard.md` §8.6),
and `agent_browser_screenshot` receives a temp-file *path* from the sidecar
and reads the bytes in Rust so images never ride the JSON-lines pipe shared
with PTY traffic (`docs/specs/dor-browser.md`). Request/response commands block on the
sidecar's reply with a timeout; `OPEN_PORT_TIMEOUT_MS` in `lib.rs` mirrors the
constant in `lib/src/lib/platform/types.ts` and the two must stay in sync.
Sidecar events (`pty:*`, dor control requests, async results) are emitted to
the webview, where `TauriAdapter` converts dor control requests into the
`dormouse:control-request` CustomEvent that `Wall` handles
(`docs/specs/dor-cli.md`, Host Plumbing — including the sidecar env:
`DORMOUSE_NODE`, `DORMOUSE_CLI_*`, `DORMOUSE_CONTROL_*`).

`resolve_sidecar_path` strips Windows `\\?\` verbatim prefixes from
`resource_dir()` once at the boundary so every derived path is plain — the
reasons live in `docs/specs/dor-cli.md` (Bundling And PATH).

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

Host-side ordering: the window-close path is owned by the updater's close
handler (`docs/specs/auto-update.md` — post-install markers, and on Windows a
synchronous `kill_sidecar_now` that waits for the process to actually exit
before `install()`). Independently, Tauri's `RunEvent::Exit` runs
`shutdown_sidecar_and_wait` so a plain quit also tears the sidecar down.

## AppBar

Source of truth: `standalone/src/AppBar.tsx`.

The AppBar is the draggable titlebar region and carries, left to right: the
shell controls, the theme picker (`docs/specs/theme.md`), and the window
controls (minimize / maximize / close via `@tauri-apps/api/window`, with
window-focus tracking dimming the bar). The shell controls are:

- **`[+]`** — spawns a new terminal with the currently selected shell
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
cannot truncate the previous snapshot. There is no WAL to grow, and overwriting
in place bounds the on-disk size to one blob. **Window identity is implicit**:
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

**Migration.** On the first boot after this change `load_session` returns null;
if a legacy blob is still in `localStorage` under `TauriAdapter.STATE_KEY`, the
adapter adopts it, persists it to the Rust store (through the store's normal
write path, so it shares the coalescing), and removes the key — so WebKit stops
rewriting it and its bloated WAL collapses on the next quit.

**Durability on quit (current limitation).** `saveState` returns after updating
the cache and *firing* `save_session`; nothing awaits the Rust write on
shutdown — the `onRequestSessionFlush` handshake is a no-op here (VS Code-only),
and the normal quit path does not intercept the window close (`updater.ts`
`onCloseRequested` only prevents default for a pending update). So a clean quit
can drop the save fired at `pagehide`, losing state changed in the final
debounce/heartbeat window — a regression from the old `localStorage` path, which
WebKit flushed on teardown. Accepted for now because restore is best-effort and
saves are frequent (≤500 ms for layout changes); a drain-on-quit is planned
(`## Future`).

## File drop

The `WindowEvent::DragDrop` handler in `lib.rs` routes dropped paths to the
focused pane as escaped, space-joined paste input — but it is **inert
today**: `tauri.conf.json` sets `dragDropEnabled: false` so HTML5
drag-and-drop inside the webview (dockview pane dragging) keeps working
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
| `standalone/src-tauri/src/lib.rs` | Rust backend: sidecar spawn/supervision, invoke commands, event forwarding, per-window session file store (`save_session` / `load_session`), file drop, logging, dock icon, exit teardown |
| `standalone/src-tauri/src/clipboard_win.rs` | Native Win32 clipboard reads on Windows (owned by `docs/specs/mouse-and-clipboard.md`) |
| `standalone/scripts/tauri.mjs`, `csp.mjs` | Tauri CLI wrapper assembling the webview CSP (`DORMOUSE_REMOTE_CONNECT_SRC`) |
| `standalone/src-tauri/tauri.conf.json` | Window config, dev/build commands, sidecar resources glob, updater config |
| `standalone/src/main.tsx` | Webview bootstrap (boot sequence above) |
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

## Future

**Drain-on-quit for the session store.** Restore the last-save durability the
`localStorage` path had before the Rust store (§Persistence, "Durability on
quit"). Add `TauriSessionStore.drain()` — resolves when no `save_session` is
in-flight or pending — and have the close path (`updater.ts` `onCloseRequested`)
`preventDefault`, run a final `flushSessionSave()`, `await` the drain (with a
timeout so a hung write can't wedge quit), then close. Lands with the part-2
save-path rework (write-on-change + heartbeat removal), which reshapes the same
path.
