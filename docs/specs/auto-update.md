# Auto-Update Spec

The standalone app checks for updates on launch and prompts in the Baseboard when one is available. It does not download or install the update until the user approves the prompt. Once approved, the app downloads the update in the background and installs it when the user quits. On next launch, a brief banner confirms the update succeeded (or notes a failure).

## How it works

```
app launch
  │
  ├─ check for post-install markers in localStorage
  │    ├─ success marker → show "Updated to vX.Y.Z" banner (auto-dismisses after 10s)
  │    ├─ failure marker → show "Update failed." banner with debug action
  │    └─ no marker → continue
  │
  ├─ wait 5 seconds
  │
  ├─ check(endpoint) ──→ no update ──→ done (silent)
  │                  │
  │                  └─→ update available → show approval prompt
  │                                           │
  │                                           ├─ dismissed/no approval → no download, no install
  │                                           │
  │                                           └─ user approves → download in background
  │                                                              ├─ success → show "will install when you quit" banner
  │                                                              └─ failure → log error, return to approval prompt
  │
  ... user works normally ...
  │
  user quits
  │
  ├─ no approved, downloaded update → exit normally
  └─ approved, downloaded update → write success marker → install() → exit
                         │
                         └─ install fails → overwrite with failure marker → exit normally
```

The `Update` object returned by `check()` is held in memory as an available update. Clicking the approval action calls `download()` and promotes it to a pending update only after the download succeeds. The close handler intercepts the window close event only when there is an approved, downloaded update, writes a success marker to `localStorage` *before* calling `install()` (because on Windows, NSIS force-kills the process), then — on Windows only — kills the sidecar and waits for it to fully exit (see *Sidecar teardown on Windows* below) before calling `install()`. In Vite dev mode (`pnpm dev:standalone`), the close handler skips `install()` without preventing the close. Dev mode is useful for testing check/download/banner behavior, but install must be tested from a packaged app because the updater resolves its replacement target from the current executable path.

## Sidecar teardown on Windows

The NSIS installer overwrites files inside the bundled sidecar — including node-pty's native `conpty.node`. Windows refuses to overwrite a native module that a live process still has loaded, so if the Node sidecar is running when NSIS reaches `node_modules`, the install fails with *"Error opening file for writing: …\_up_\sidecar\node_modules\node-pty\prebuilds\win32-x64\conpty.node"*. The Rust `RunEvent::Exit` kill is too late and asynchronous — NSIS starts copying files immediately after `install()` force-kills the app, racing the sidecar's shutdown.

Because `pty-core` spawns with `useConptyDll: true` on Windows (see [terminal-escapes.md](terminal-escapes.md#osc-color-queries-on-windows-require-the-bundled-conpty)), the same hazard now covers two more bundled files: the sidecar additionally `LoadLibrary`s node-pty's `conpty/conpty.dll`, and each pseudoconsole runs an `OpenConsole.exe` child process. `conpty.dll` is released when the sidecar exits (same as `conpty.node`); the `OpenConsole.exe` children run inside the sidecar's job object (`process_wrap`'s `JobObject`), so terminating the sidecar tears them down too.

So on Windows the close handler `invoke`s `kill_sidecar_now` and awaits it before `install()`. That command is synchronous on the Rust side: it sends the kill, then polls `try_wait` (capped at ~5s) until the process has actually exited and released its file handles. `try_wait` is used instead of the job-object `wait()` because `wait()` consumes a completion-port message the reaper thread relies on and could block forever if the sidecar had already exited. macOS and Linux can replace open files in place, so they skip this and rely on the existing `RunEvent::Exit` cleanup.

## Update notice in the Baseboard

Update status appears as a text notice on the right side of the Baseboard (the always-visible bottom strip — see `layout.md`). It coexists with doors and shortcut hints.

| State | Message | Actions | Auto-dismiss |
|-------|---------|---------|--------------|
| `available` | "Update available" | "Changelog", "Install when I quit" | No |
| `downloading` | "Downloading update v0.5.0" | "Changelog" | No |
| `downloaded` | "Update downloaded (v0.5.0) — will install when you quit" | "Changelog" | No |
| `post-update-success` | "Updated to v0.5.0 — from v0.4.0" | "Changelog" | 10 seconds |
| `post-update-failure` | "Update failed" | "Click here to debug" | No |

The "Install when I quit" action is the user's approval to download the update now and install it when they quit. The inline "Changelog" action calls Tauri's `getVersion()` and opens `https://dormouse.sh/changelog/after/<current-version>`.
When a notice has follow-up actions, it uses ` · ` as the separator between the message and action labels.

All states are dismissible via [×]. Dismissing an unapproved `available` notice means no update is downloaded or installed in that session. Dismissing a `downloading` or `downloaded` notice hides it for the session only — it does not cancel an already-approved download/install.

The notice matches the Baseboard's existing text style (9px mono, `text-muted`). It's pushed right via `ml-auto` so it doesn't compete with doors or the shortcut hint on the left.

### Threading

The Baseboard is in `lib/` but the updater is standalone-only. The notice is threaded as a `ReactNode` prop: `App` → `Wall` → `Baseboard` (via `baseboardNotice`). This keeps all updater knowledge out of `lib/` — the Baseboard just renders an opaque slot.

## Platform behavior at quit

| Platform | What `install()` does | App exit |
|----------|----------------------|----------|
| Windows | Kills the sidecar and waits for it to exit (so NSIS can overwrite its loaded native modules), then launches NSIS installer in passive mode (progress bar, no user interaction). Force-kills the app. | Automatic (NSIS) |
| macOS | Replaces the `.app` bundle in place | `getCurrentWindow().close()` after `install()` returns |
| Linux | Replaces the AppImage in place | `getCurrentWindow().close()` after `install()` returns |
| Vite dev mode | Skips `install()` to avoid replacing the dev executable directory | Native close proceeds normally |

Windows uses `"installMode": "passive"` (configured in `tauri.conf.json` under `plugins.updater.windows`).

## localStorage

Single key: `dormouse:update-result`

| Scenario | Value written | When cleared |
|----------|--------------|--------------|
| Successful install | `{ "from": "0.4.0", "to": "0.5.0" }` | On next launch, after reading |
| Failed install | `{ "failed": true, "version": "0.5.0", "error": "..." }` | On next launch, after reading |

The success marker is written *before* `install()` because Windows NSIS force-kills the process — if we wrote it after, it would never persist. If `install()` then throws, the marker is overwritten with a failure entry. No marker is written for an update that was found but never approved.

## Files

| File | Role |
|------|------|
| [`standalone/src/updater.ts`](../../standalone/src/updater.ts) | State machine, update check, user-approved download, close handler, post-install markers |
| [`standalone/src/UpdateBanner.tsx`](../../standalone/src/UpdateBanner.tsx) | Pure presentational component — renders inline notice content for the Baseboard |
| [`standalone/src/main.tsx`](../../standalone/src/main.tsx) | Passes `<ConnectedUpdateBanner />` as the `baseboardNotice` prop to `<App />`, calls `startUpdateCheck()` after platform init |

All updater code is standalone-only. The Baseboard accepts a generic `notice` prop (`ReactNode`) — it has no knowledge of the updater.

## Configuration

In `standalone/src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "pubkey": "<ed25519 public key>",
    "endpoints": ["https://dormouse.sh/standalone-latest.json"],
    "windows": { "installMode": "passive" }
  }
}
```

The Rust side registers the plugin with `tauri_plugin_updater::Builder::new().build()` in `lib.rs`. No custom Rust commands or `on_before_exit` hooks — the JS close handler handles everything. Capabilities must include `core:window:allow-destroy` as well as `core:window:allow-close`: Tauri's `onCloseRequested` API calls `destroy()` after the handler returns when the close was not prevented.

## Dependencies

- `@tauri-apps/plugin-updater` — update check, download, install
- `@tauri-apps/api/window` — `getCurrentWindow()`, `onCloseRequested`
- `@tauri-apps/api/app` — `getVersion()` for the "from" version in markers
- `@tauri-apps/plugin-shell` — `open()` for the changelog link
- `tauri-plugin-updater` Rust crate — registered in `Cargo.toml` and `lib.rs`

## Design decisions

**Why install on quit after approval, not immediately?** Dormouse is a terminal app with running processes. A mid-session relaunch would kill all sessions. By installing at quit time, the user has already decided to close their terminals.

**Why no silent download?** Update bundles can be large, can fail for environment-specific reasons, and may surprise users who did not opt into changing the app. The launch probe is silent, but download/install only begins after explicit approval.

**Why the Baseboard, not a top banner?** A top banner pushes terminal content down, which is disruptive in a terminal app. The Baseboard is already a status strip — the update notice fits naturally alongside doors and shortcut hints. It also avoids adding a new UI element; the notice just occupies unused space in an existing one.

**Why write the success marker before `install()`?** On Windows, the NSIS installer force-kills the process — code after `install()` may never run. Writing optimistically and overwriting on failure handles both platforms correctly.

**Why no `on_before_exit` Rust hook?** The JS close handler (`onCloseRequested`) runs before `install()` and handles marker writes and (on Windows) the synchronous sidecar kill. On Windows, NSIS handles process termination after `install()`. On macOS/Linux the sidecar is orphaned and exits when its stdin closes — harmless there because open files can be replaced in place.

**Why `localStorage` instead of Tauri's store plugin?** `localStorage` persists across launches in Tauri's webview, requires no additional dependencies, and is automatically scoped to the app. If the user resets app data, markers are cleaned up naturally.
