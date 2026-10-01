# Auto-Update Spec

> See `docs/specs/glossary.md` for Baseboard / Door vocabulary. Owns the standalone updater's lifecycle; the release pipeline that publishes the update manifest it fetches is `docs/specs/deploy.md`, and the quit orchestrator that drives the install is `docs/specs/standalone.md` §Quit flow.

The standalone app checks for updates on launch, where the network policy allows it, and prompts in the Baseboard. **Nothing is downloaded or installed until the user approves that prompt**; the download then runs in the background, the install at quit.

## How it works

**Must read and clear the post-install marker on launch** (§localStorage) and show its banner; a reported failure suppresses this launch's check. Otherwise wait 5 seconds, then read the network policy with `networkPolicy` over the Burrow link and, where it allows (`docs/specs/remote-network.md` → "Updates"), `check()` — no update is silent, an update raises the approval prompt; then the reminder, if due: `check-due`, recording `remindedAt`. **The reminder is re-evaluated hourly while the app runs**, reading no policy and never checking; **never over an undismissed notice, nor while the clock reads before 2026-09**, not yet set. Version-lookup and check failures are logged. **Only approval starts the background `download()`**; a failed one is logged and the prompt returns.

**Check now** — the `check-due` and `check-failed` links, and the `updates` port — shows `checking`, then `available`, `up-to-date`, or `check-failed`. **A second ask joins the check in flight. An update already approved is shown again, `downloading` or `downloaded`, instead of checked for**, which would offer it for approval twice. **Every successful check, automatic or asked for, records `checkedAt`** (§localStorage).

**A self-host build never checks** (`docs/specs/relay.md` → "Relay origin"): `startUpdateCheck()` returns at once and `checkNow()` does nothing unless the webview's own baked mode, `bakedRelayMode()`, is `hosted`.

**A failed download leaves the *available* update in place** so a second approval retries rather than no-ops; only a successful `download()` promotes `check()`'s in-memory *available* `Update` to *pending*.

**`startUpdateCheck()` and `checkNow()` are no-ops under the browser-dev harness** (`VITE_DORMOUSE_BROWSER_DEV_HOST`), which has no Tauri updater behind it.

### Quit-time install

**The updater owns no quit interception** — install runs only when `hasPendingUpdate()` is true, after the quit orchestrator's teardown and save/drain steps (`docs/specs/standalone.md` §Quit flow) (rationale). **It runs in `main`, the window the quit walk tears down last and the only one holding `updater:default`** (`capabilities/main-only.json`); every other window has handed on by then, so nothing it could still be writing outlives the install.

**Only `main` ever checks**, so it is the only window that can hold a download at all — and **closing `main` throws away an approved one**, which lives in that webview's memory. Its close confirmation says so, and is shown for that reason alone even with nothing running (`docs/specs/standalone.md` → "Per-window close"); a session that has closed `main` simply has no update to install until it relaunches (rationale). `installPendingUpdate()` writes the success marker *before* `install()` (§localStorage), and on Windows first awaits bounded sidecar teardown (§Sidecar teardown on Windows). **It never closes the window itself** — exiting the process is `quit_proceed`'s job, after this returns.

**In Vite dev mode (`pnpm dev:standalone`) `installPendingUpdate()` drops the pending update and skips `install()`** (rationale), so install must be tested from a packaged app; **`MODE === 'test'` lifts the skip** for `standalone/src/updater.test.ts`.

## Sidecar teardown on Windows

**On Windows `installPendingUpdate()` must await `kill_sidecar_now` before `install()`** so NSIS can replace the sidecar's loaded node-pty modules and ConPTY children (rationale). Rust calls `start_kill()`, then polls `try_wait` every 20 ms under a ~5 s cap; timeout or wait error is logged and installation proceeds without confirmed exit. **Never use the job-object `wait()`**, whose completion message may already have been consumed (rationale). macOS and Linux skip the step — they replace open files.

## Update notice in the Baseboard

Update status is a text notice in the Baseboard, the always-visible bottom strip (`docs/specs/layout.md`).

| State | Message | Actions | Auto-dismiss |
|-------|---------|---------|--------------|
| `available` | "Update available" | "Changelog", "Install when I quit" | No |
| `downloading` | "Downloading update v0.5.0" | "Changelog" | No |
| `downloaded` | "Update downloaded (v0.5.0) — will install when you quit" | "Changelog", "Restart now" | No |
| `restart-refused` | "Update downloaded (v0.5.0) — will install when you quit (couldn't restart: `<reason>`)" | "Changelog" | No |
| `post-update-success` | "Updated to v0.5.0 — from v0.4.0" | "Changelog" | 10 seconds |
| `post-update-failure` | "Update failed" | "Click here to debug" | No |
| `check-due` | "No update check in 9 days" | "Check now" | No |
| `checking` | "Checking for updates…" | — | No |
| `up-to-date` | "Dormouse is up to date (v0.5.0)" | — | 10 seconds |
| `check-failed` | "Couldn’t check for updates" | "Try again" | No |

"Install when I quit" is the approval; "Changelog" opens `https://dormouse.sh/changelog/after/<getVersion()>`. **"Restart now" calls `quit_restart`** (`docs/specs/standalone.md` → "Restart"): the quit installs on its way out, then relaunches. **A refusal turns a still-shown `downloaded` into `restart-refused`, carrying the host's reason and never "Restart now"**, since the refusal holds until relaunch; the update stays pending. ` · ` separates the message from the action labels.

**Every state is dismissible via [×].** Dismissing an unapproved `available` notice means no download and no install that session; dismissing `downloading`, `downloaded`, or `restart-refused` hides the notice only and **never cancels** an approved download/install.

**The notice carries the Baseboard's own text style (`text-sm font-mono text-muted`), in its single right-hand `ml-auto` cluster** — clear of doors and the shortcut hint.

### Debug report on failure

**"Click here to debug" opens `UpdateDebugModal`, which snapshots the failure** (version + error string) so a later state change cannot alter it. Two steps (rationale): a GitHub issue *search* seeded with the error's first 80 characters **unquoted**, so GitHub can fuzzy-match; and a copyable markdown report from `buildDebugReport()` — app version, `PLATFORM_STRING`, the error, and the log tail. The tail is `read_update_log`'s last 10,000 bytes of `dormouse.log`, sliced on a char boundary; **a failed read is embedded as a placeholder, never aborts the report**.

### Threading

**No updater knowledge in `lib/`** — the Baseboard lives there and every updater module is standalone-only, so the notice threads through as an opaque `ReactNode` slot: `App` → `Wall` (`baseboardNotice`) → `Baseboard` (`notice`). Settings reads the checks through the platform's optional `updates` port (`UpdatesPort`: `{ checkedAt, checking }` and `checkNow()`), which `main.tsx` gives `main` alone, and only in a build that checks.

## Platform behavior at quit

**`quit_proceed` runs on every path** (`docs/specs/standalone.md` §Quit flow), so app exit is uniform (Windows aside); only the install step differs:

| Platform | Install step |
|----------|--------------|
| Windows | Awaits `kill_sidecar_now`, then `install()` starts the NSIS installer in passive mode (progress bar, no interaction) and exits the process itself, before `quit_proceed` is reached |
| macOS | `install()` replaces the `.app` bundle in place |
| Linux | `install()` replaces the AppImage in place |
| No pending update | — (`installPendingUpdate` not called) |
| Vite dev mode | Skips `install()`, which would replace the dev executable directory |

**The app relaunches only on a restart** (`docs/specs/standalone.md` → "Restart"), which a debug build refuses — except that a Windows install always relaunches, by NSIS (`/R`).

## localStorage

`dormouse:update-result`, the post-install marker:

| Scenario | Value written | When cleared |
|----------|--------------|--------------|
| Successful install | `{ "from": "0.4.0", "to": "0.5.0" }` | On next launch, after reading |
| Failed install | `{ "failed": true, "version": "0.5.0", "error": "..." }` | On next launch, after reading |

**Must write the success marker *before* `install()`** — on Windows `install()` never returns. **Must confirm its target against the running app version on next launch**; a mismatch becomes a failure notice and suppresses the update check. **A throwing `install()` overwrites it with a failure entry.** An unapproved update writes nothing. **Must ignore corrupt markers**, including invalid field types. `standalone/src/updater.test.ts` pins marker validation and confirmation.

`dormouse:update-check`, the check clock: `{ "checkedAt": number | null, "since": number, "remindedAt": number | null }`, epoch ms — the last successful check, when this machine started counting, and the last reminder. Written by the first launch, tick, or check that finds none, with `since` then; never cleared. **A value of the wrong shape counts as none**, restarting the clock. **A time ahead of the clock is saved as now**, the others kept, so a clock set back delays the reminder a week at most.

## Files

| File | Role |
|------|------|
| [`standalone/src/updater.ts`](../../standalone/src/updater.ts) | State machine, policy-gated check, reminder, Check now and the `updates` port, approved download, quit-time install (`hasPendingUpdate` / `installPendingUpdate`), markers, debug report |
| [`standalone/src/updater.test.ts`](../../standalone/src/updater.test.ts) | Pins the updater lifecycle and ordering |
| [`standalone/src/UpdateBanner.tsx`](../../standalone/src/UpdateBanner.tsx) | Presentational notice content for the Baseboard |
| [`standalone/src/UpdateDebugModal.tsx`](../../standalone/src/UpdateDebugModal.tsx) | Failure modal: issue search + copyable report |
| [`standalone/src-tauri/tauri.conf.json`](../../standalone/src-tauri/tauri.conf.json) | Updater endpoint, public key, artifact mode, Windows install mode |

## Configuration

`tauri.conf.json` fixes the endpoint at `https://dormouse.sh/standalone-latest.json`, pins the public key releases are signed against, and sets `plugins.updater.windows.installMode` to `passive`; the artifact mode and the manifest it serves are `docs/specs/deploy.md`. Rust registers `tauri-plugin-updater`; the JS install step and the quit orchestrator own the lifecycle. **Updater, app-version, and shell-open calls need capability entries; custom Tauri commands need none.**
