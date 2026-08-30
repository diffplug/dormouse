# Auto-Update Spec

> See `docs/specs/glossary.md` for Baseboard / Door vocabulary. Owns the standalone updater's lifecycle; the release pipeline that publishes the update manifest it fetches is `docs/specs/deploy.md`, and the quit orchestrator that drives the install is `docs/specs/standalone.md` §Quit flow.

The standalone app checks for updates on launch and prompts in the Baseboard when one is available. **Nothing is downloaded or installed until the user approves that prompt**; after approval the download runs in the background and the install runs when the user quits. On the next launch a brief banner confirms the update succeeded, or offers a debug report if it failed.

Source of truth: `standalone/src/updater.ts`.

## How it works

```
app launch
  │
  ├─ check for post-install markers in localStorage
  │    ├─ success marker → show "Updated to vX.Y.Z" banner (auto-dismisses after 10s)
  │    ├─ failure marker → show "Update failed" banner with debug action, then STOP —
  │    │    the update check is skipped this launch (re-prompting for the version that
  │    │    just failed would unmount an open debug dialog)
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
  └─ quit orchestrator runs graceful teardown + durable final save
       │   (docs/specs/standalone.md §Quit flow)
       ├─ no approved, downloaded update → quit_proceed → exit
       └─ approved, downloaded update → write success marker → install() → exit
                              │
                              └─ install fails → overwrite with failure marker → quit_proceed → exit
```

The `Update` object returned by `check()` is held in memory as the *available* update. The approval action calls `download()` and promotes it to the *pending* update only once the download succeeds — a failed download leaves the available update in place, so a second approval retries it rather than no-op'ing.

`startUpdateCheck()` is a no-op under the browser-dev harness (`VITE_DORMOUSE_BROWSER_DEV_HOST`), which has no Tauri updater behind it.

### Quit-time install

**The updater owns no quit interception of its own** — the install is the last step of the quit orchestrator (`docs/specs/standalone.md` §Quit flow), because it must run *after* the graceful terminal teardown and the durable final session save land or a Windows NSIS force-kill mid-teardown would lose the freshest scrollback. Only when `hasPendingUpdate()` is true does the orchestrator call `installPendingUpdate()`. That function writes the success marker *before* calling `install()` (§localStorage), and on Windows first kills the sidecar and waits for it to fully exit (§Sidecar teardown on Windows). It **never closes the window itself**: exiting the process is the orchestrator's `quit_proceed` job, which runs after this returns.

In Vite dev mode (`pnpm dev:standalone`), `installPendingUpdate()` drops the pending update and skips `install()` — the updater resolves its replacement target from the current executable path, so install must be tested from a packaged app. The skip is lifted under `MODE === 'test'` so `standalone/src/updater.test.ts` can exercise the real path.

## Sidecar teardown on Windows

**On Windows `installPendingUpdate()` must `invoke` `kill_sidecar_now` and await it before `install()`** — the NSIS installer overwrites files inside the bundled sidecar, and Windows refuses to overwrite a native module (node-pty's `conpty.node`) that a live process still has loaded, so if the Node sidecar is running when NSIS reaches `node_modules`, the install fails with *"Error opening file for writing: …\_up_\sidecar\node_modules\node-pty\prebuilds\win32-x64\conpty.node"*. Rust's `RunEvent::Exit` sidecar shutdown cannot cover this: `install()` force-kills the app and NSIS starts copying immediately, so that handler either never runs or is still polling for the sidecar's exit while NSIS is already writing. (By quit time the orchestrator's graceful teardown has killed the sidecar's *PTYs*, but the sidecar process itself is still alive holding those native modules.)

Because `pty-core` spawns with `useConptyDll: true` on Windows (see [terminal-escapes.md](terminal-escapes.md#osc-color-queries-on-windows-require-the-bundled-conpty)), the same hazard covers two more bundled files: the sidecar additionally `LoadLibrary`s node-pty's `conpty/conpty.dll`, and each pseudoconsole runs an `OpenConsole.exe` child process. `conpty.dll` is released when the sidecar exits (same as `conpty.node`); the `OpenConsole.exe` children run inside the sidecar's job object (`process_wrap`'s `JobObject`), so terminating the sidecar tears them down too.

`kill_sidecar_now` is synchronous on the Rust side: it calls `start_kill()`, then polls `try_wait` every 20 ms (capped at ~5s) until the process has actually exited and released its file handles. **Poll `try_wait`, never the job-object `wait()`** — `wait()` consumes a completion-port message the reaper thread may already have drained, so a sidecar that had crashed earlier would block forever. The ~5s cap means a wedged sidecar cannot stall quit indefinitely. macOS and Linux can replace open files in place, so they skip the kill and rely on the existing `RunEvent::Exit` cleanup.

## Update notice in the Baseboard

Update status appears as a text notice in the Baseboard (the always-visible bottom strip — see `layout.md`).

| State | Message | Actions | Auto-dismiss |
|-------|---------|---------|--------------|
| `available` | "Update available" | "Changelog", "Install when I quit" | No |
| `downloading` | "Downloading update v0.5.0" | "Changelog" | No |
| `downloaded` | "Update downloaded (v0.5.0) — will install when you quit" | "Changelog" | No |
| `post-update-success` | "Updated to v0.5.0 — from v0.4.0" | "Changelog" | 10 seconds |
| `post-update-failure` | "Update failed" | "Click here to debug" | No |

"Install when I quit" is the user's approval to download now and install at quit. "Changelog" calls Tauri's `getVersion()` and opens `https://dormouse.sh/changelog/after/<current-version>`. When a notice has follow-up actions, ` · ` separates the message from the action labels.

**All states are dismissible via [×].** Dismissing an unapproved `available` notice means no update is downloaded or installed in that session. Dismissing a `downloading` or `downloaded` notice hides it for the session only — it **does not cancel** an already-approved download/install.

The notice matches the Baseboard's existing text style (`text-sm font-mono text-muted` — 12px via the theme.css `text-sm` override), and sits inside the Baseboard's single right-hand `ml-auto` cluster, so it does not compete with doors or the shortcut hint on the left.

### Debug report on failure

"Click here to debug" opens `UpdateDebugModal`, which snapshots the failure (version + error string) so the modal survives any later state change. It offers two steps: a GitHub issue *search* seeded with the first 80 characters of the error unquoted (so GitHub can fuzzy-match), and a copyable markdown report assembled by `buildDebugReport()` — app version, `PLATFORM_STRING`, the error, and the tail of the Dormouse log. The log tail comes from the `read_update_log` Tauri command (the last 10 KB of `dormouse.log`, sliced on a char boundary); a failure to read it is embedded as a placeholder rather than aborting the report.

Search-before-file is the reason the modal exists at all: an update failure is environment-specific and the log tail is the only evidence that survives the force-kill.

### Threading

**No updater knowledge in `lib/`** — the Baseboard lives there but all updater code is standalone-only, so the notice is threaded through as an opaque `ReactNode` slot: `App` → `Wall` (`baseboardNotice`) → `Baseboard` (`notice`).

## Platform behavior at quit

On every platform the quit orchestrator calls `quit_proceed` after the teardown + install step returns; `quit_proceed` sets the approved flag and calls `app.exit(0)`, so the app exit is uniform. The per-platform difference is only in what the install step does:

| Platform | Install step | App exit |
|----------|--------------|----------|
| Windows | `installPendingUpdate()` awaits `kill_sidecar_now` (so NSIS can overwrite the sidecar's loaded native modules), then `install()` launches the NSIS installer in passive mode (progress bar, no user interaction) and force-kills the app | NSIS force-kills before `quit_proceed` is reached |
| macOS | `install()` replaces the `.app` bundle in place | `quit_proceed` → `app.exit(0)` |
| Linux | `install()` replaces the AppImage in place | `quit_proceed` → `app.exit(0)` |
| No pending update | — (`installPendingUpdate` not called) | `quit_proceed` → `app.exit(0)` |
| Vite dev mode | Skips `install()` to avoid replacing the dev executable directory | `quit_proceed` → `app.exit(0)` |

Windows uses `"installMode": "passive"` (configured in `tauri.conf.json` under `plugins.updater.windows`).

## localStorage

Single key: `dormouse:update-result`

| Scenario | Value written | When cleared |
|----------|--------------|--------------|
| Successful install | `{ "from": "0.4.0", "to": "0.5.0" }` | On next launch, after reading |
| Failed install | `{ "failed": true, "version": "0.5.0", "error": "..." }` | On next launch, after reading |

**The success marker is written *before* `install()`** because Windows NSIS force-kills the process — written after, it would never persist; if `install()` then throws, the marker is overwritten with a failure entry. No marker is written for an update that was found but never approved, and a corrupt marker is swallowed and treated as no marker.

## Files

| File | Role |
|------|------|
| [`standalone/src/updater.ts`](../../standalone/src/updater.ts) | State machine, update check, user-approved download, quit-time install (`hasPendingUpdate` / `installPendingUpdate`, called by the quit orchestrator), post-install markers, debug-report assembly |
| [`standalone/src/updater.test.ts`](../../standalone/src/updater.test.ts) | Marker read/clear, the 5s probe delay, approval-gated download, marker-before-install ordering, and the Windows kill-before-install ordering |
| [`standalone/src/UpdateBanner.tsx`](../../standalone/src/UpdateBanner.tsx) | Pure presentational component — renders inline notice content for the Baseboard |
| [`standalone/src/UpdateDebugModal.tsx`](../../standalone/src/UpdateDebugModal.tsx) | Failure modal: issue search + copyable report |
| [`standalone/src/quit.ts`](../../standalone/src/quit.ts) | Quit orchestrator (owned by `docs/specs/standalone.md` §Quit flow); calls `installPendingUpdate()` as the last teardown step |
| [`standalone/src/main.tsx`](../../standalone/src/main.tsx) | Owns `<ConnectedUpdateBanner />` (banner + modal wiring), passes it as the `baseboardNotice` prop to `<App />`, calls `startUpdateCheck()` after restore |

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

The Rust side registers the plugin with `tauri_plugin_updater::Builder::new().build()` in `lib.rs`. The install step itself runs entirely in JS; the process exit is the quit orchestrator's `quit_proceed` (`docs/specs/standalone.md` §Quit flow). Two custom Rust commands serve the updater — `kill_sidecar_now` (shared with the quit path) and `read_update_log` — and custom commands need no capability entry. The plugin permissions the updater does need are in `standalone/src-tauri/capabilities/default.json`: `updater:default`, plus `core:app:allow-version` (marker versions, changelog URL) and `shell:default` (opening the changelog and issue search).

## Dependencies

- `@tauri-apps/plugin-updater` — update check, download, install
- `@tauri-apps/api/core` — `invoke('kill_sidecar_now')` before install on Windows, `invoke('read_update_log')` for the debug report
- `@tauri-apps/api/app` — `getVersion()` for the "from" version in markers and the changelog URL
- `@tauri-apps/plugin-shell` — `open()` for the changelog and issue-search links
- `tauri-plugin-updater` Rust crate — registered in `Cargo.toml` and `lib.rs`

## Design decisions

**Why install on quit after approval, not immediately?** Dormouse is a terminal app with running processes; a mid-session relaunch would kill every session, while at quit time the user has already decided to close their terminals.

**Why no silent download?** Update bundles are large, fail for environment-specific reasons, and would surprise a user who did not opt into changing the app — so the launch probe is silent, but download and install wait for explicit approval.

**Why the Baseboard, not a top banner?** A top banner pushes terminal content down; the Baseboard is already a status strip, so the notice occupies unused space in an existing element instead of adding a new one.

**Why `localStorage` instead of Tauri's store plugin?** It persists across launches in Tauri's webview, needs no extra dependency, is scoped to the app, and resetting app data cleans the markers up naturally.
