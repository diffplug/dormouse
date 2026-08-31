# Auto-Update Spec

> See `docs/specs/glossary.md` for Baseboard / Door vocabulary. Owns the standalone updater's lifecycle; the release pipeline that publishes the update manifest it fetches is `docs/specs/deploy.md`, and the quit orchestrator that drives the install is `docs/specs/standalone.md` §Quit flow.

The standalone app checks for updates on launch and prompts in the Baseboard when one is available. **Nothing is downloaded or installed until the user approves that prompt**; after approval the download runs in the background and the install runs when the user quits. On the next launch a brief banner confirms the update succeeded, or offers a debug report if it failed.

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

**On Windows `installPendingUpdate()` must await `kill_sidecar_now` before `install()`** so NSIS can replace the sidecar's loaded node-pty modules and ConPTY children (rationale). The Rust command calls `start_kill()`, then polls `try_wait` every 20 ms for at most ~5 seconds. **Never use the job-object `wait()`**, whose completion message may already have been consumed (rationale). macOS and Linux skip this step because they can replace open files.

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
| [`standalone/src/updater.test.ts`](../../standalone/src/updater.test.ts) | Pins the updater lifecycle and ordering |
| [`standalone/src/UpdateBanner.tsx`](../../standalone/src/UpdateBanner.tsx) | Pure presentational component — renders inline notice content for the Baseboard |
| [`standalone/src/UpdateDebugModal.tsx`](../../standalone/src/UpdateDebugModal.tsx) | Failure modal: issue search + copyable report |
| [`standalone/src/quit.ts`](../../standalone/src/quit.ts) | Quit orchestrator (owned by `docs/specs/standalone.md` §Quit flow); calls `installPendingUpdate()` as the last teardown step |
| [`standalone/src/main.tsx`](../../standalone/src/main.tsx) | Owns `<ConnectedUpdateBanner />` (banner + modal wiring), passes it as the `baseboardNotice` prop to `<App />`, calls `startUpdateCheck()` after restore |
| [`standalone/src-tauri/tauri.conf.json`](../../standalone/src-tauri/tauri.conf.json) | Updater endpoint, public key, artifact mode, and Windows install mode |
| [`standalone/src-tauri/src/lib.rs`](../../standalone/src-tauri/src/lib.rs) | Plugin registration, sidecar teardown, and update-log tail |
| [`standalone/src-tauri/capabilities/default.json`](../../standalone/src-tauri/capabilities/default.json) | Updater, version, and shell permissions |

## Configuration

The config fixes the endpoint at `https://dormouse.sh/standalone-latest.json`, uses the Ed25519 public key published by the release pipeline, and selects passive NSIS installation. Rust registers `tauri-plugin-updater`; the JS install step and the quit orchestrator own the lifecycle. Custom commands need no capability entry, while updater, app-version, and shell-opening calls do.
