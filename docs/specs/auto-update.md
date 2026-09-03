# Auto-Update Spec

> See `docs/specs/glossary.md` for Baseboard / Door vocabulary. Owns the standalone updater's lifecycle; the release pipeline that publishes the update manifest it fetches is `docs/specs/deploy.md`, and the quit orchestrator that drives the install is `docs/specs/standalone.md` §Quit flow.

The standalone app checks for updates on launch and prompts in the Baseboard. **Nothing is downloaded or installed until the user approves that prompt**; the download then runs in the background, the install at quit.

## How it works

**Launch.** Read and clear any post-install marker (§localStorage) and show its banner; **a failure marker stops there — no update check this launch**, since re-prompting for the version that just failed would unmount an open debug dialog. Otherwise wait 5 seconds, then `check(endpoint)`: no update is silent, an update raises the approval prompt. **Only approval starts the background `download()`**; a failed one is logged and the prompt returns.

**A failed download leaves the *available* update in place** so a second approval retries rather than no-ops; only a successful `download()` promotes `check()`'s in-memory *available* `Update` to *pending*.

**`startUpdateCheck()` is a no-op under the browser-dev harness** (`VITE_DORMOUSE_BROWSER_DEV_HOST`), which has no Tauri updater behind it.

### Quit-time install

**The updater owns no quit interception** — the install is the quit orchestrator's last step, strictly after the graceful terminal teardown and the durable final session save (`docs/specs/standalone.md` §Quit flow) (rationale), and runs only when `hasPendingUpdate()` is true. `installPendingUpdate()` writes the success marker *before* `install()` (§localStorage), and on Windows first kills the sidecar and waits for it to fully exit (§Sidecar teardown on Windows). **It never closes the window itself** — exiting the process is `quit_proceed`'s job, after this returns.

**In Vite dev mode (`pnpm dev:standalone`) `installPendingUpdate()` drops the pending update and skips `install()`** (rationale), so install must be tested from a packaged app; **`MODE === 'test'` lifts the skip** for `standalone/src/updater.test.ts`.

## Sidecar teardown on Windows

**On Windows `installPendingUpdate()` must await `kill_sidecar_now` before `install()`** so NSIS can replace the sidecar's loaded node-pty modules and ConPTY children (rationale). The Rust command calls `start_kill()`, then polls `try_wait` every 20 ms under a ~5 s cap, so a wedged sidecar cannot stall quit. **Never use the job-object `wait()`**, whose completion message may already have been consumed (rationale). macOS and Linux skip the step — they replace open files.

## Update notice in the Baseboard

Update status is a text notice in the Baseboard, the always-visible bottom strip (`docs/specs/layout.md`).

| State | Message | Actions | Auto-dismiss |
|-------|---------|---------|--------------|
| `available` | "Update available" | "Changelog", "Install when I quit" | No |
| `downloading` | "Downloading update v0.5.0" | "Changelog" | No |
| `downloaded` | "Update downloaded (v0.5.0) — will install when you quit" | "Changelog" | No |
| `post-update-success` | "Updated to v0.5.0 — from v0.4.0" | "Changelog" | 10 seconds |
| `post-update-failure` | "Update failed" | "Click here to debug" | No |

"Install when I quit" is the approval; "Changelog" opens `https://dormouse.sh/changelog/after/<getVersion()>`. ` · ` separates the message from the action labels.

**Every state is dismissible via [×].** Dismissing an unapproved `available` notice means no download and no install that session; dismissing `downloading` or `downloaded` hides the notice only and **never cancels** an approved download/install.

**The notice carries the Baseboard's own text style (`text-sm font-mono text-muted`), in its single right-hand `ml-auto` cluster** — clear of doors and the shortcut hint.

### Debug report on failure

**"Click here to debug" opens `UpdateDebugModal`, which snapshots the failure** (version + error string) so a later state change cannot alter it. Two steps (rationale): a GitHub issue *search* seeded with the error's first 80 characters **unquoted**, so GitHub can fuzzy-match; and a copyable markdown report from `buildDebugReport()` — app version, `PLATFORM_STRING`, the error, and the log tail. The tail is `read_update_log`'s last 10 KB of `dormouse.log`, sliced on a char boundary; **a failed read is embedded as a placeholder, never aborts the report**.

### Threading

**No updater knowledge in `lib/`** — the Baseboard lives there and every updater module is standalone-only, so the notice threads through as an opaque `ReactNode` slot: `App` → `Wall` (`baseboardNotice`) → `Baseboard` (`notice`).

## Platform behavior at quit

**`quit_proceed` runs on every path** (`docs/specs/standalone.md` §Quit flow), so app exit is uniform (Windows aside); only the install step differs:

| Platform | Install step |
|----------|--------------|
| Windows | Awaits `kill_sidecar_now`, then `install()` runs the NSIS installer in passive mode (progress bar, no interaction), which force-kills the app before `quit_proceed` is reached |
| macOS | `install()` replaces the `.app` bundle in place |
| Linux | `install()` replaces the AppImage in place |
| No pending update | — (`installPendingUpdate` not called) |
| Vite dev mode | Skips `install()`, which would replace the dev executable directory |

## localStorage

Single key: `dormouse:update-result`

| Scenario | Value written | When cleared |
|----------|--------------|--------------|
| Successful install | `{ "from": "0.4.0", "to": "0.5.0" }` | On next launch, after reading |
| Failed install | `{ "failed": true, "version": "0.5.0", "error": "..." }` | On next launch, after reading |

**Write the success marker *before* `install()`** — Windows NSIS force-kills the process, so a later write would never persist. **A throwing `install()` overwrites it with a failure entry.** An update found but never approved writes no marker, and **a corrupt marker is swallowed and read as no marker**.

## Files

| File | Role |
|------|------|
| [`standalone/src/updater.ts`](../../standalone/src/updater.ts) | State machine, check, approved download, quit-time install (`hasPendingUpdate` / `installPendingUpdate`), markers, debug report |
| [`standalone/src/updater.test.ts`](../../standalone/src/updater.test.ts) | Pins the updater lifecycle and ordering |
| [`standalone/src/UpdateBanner.tsx`](../../standalone/src/UpdateBanner.tsx) | Presentational notice content for the Baseboard |
| [`standalone/src/UpdateDebugModal.tsx`](../../standalone/src/UpdateDebugModal.tsx) | Failure modal: issue search + copyable report |
| [`standalone/src/quit.ts`](../../standalone/src/quit.ts) | Quit orchestrator (`docs/specs/standalone.md` §Quit flow); calls `installPendingUpdate()` last |
| [`standalone/src/main.tsx`](../../standalone/src/main.tsx) | `<ConnectedUpdateBanner />` (banner + modal) as `<App />`'s `baseboardNotice`; `startUpdateCheck()` after restore |
| [`standalone/src-tauri/tauri.conf.json`](../../standalone/src-tauri/tauri.conf.json) | Updater endpoint, public key, artifact mode, Windows install mode |
| [`standalone/src-tauri/src/lib.rs`](../../standalone/src-tauri/src/lib.rs) | Plugin registration, sidecar teardown, update-log tail |
| [`standalone/src-tauri/capabilities/default.json`](../../standalone/src-tauri/capabilities/default.json) | Updater, version, and shell permissions |

## Configuration

`tauri.conf.json` fixes the endpoint at `https://dormouse.sh/standalone-latest.json`, pins the public key releases are signed against, and sets `plugins.updater.windows.installMode` to `passive`; the artifact mode and the manifest it serves are `docs/specs/deploy.md`. Rust registers `tauri-plugin-updater`; the JS install step and the quit orchestrator own the lifecycle. **Updater, app-version, and shell-open calls need capability entries; custom Tauri commands need none.**
