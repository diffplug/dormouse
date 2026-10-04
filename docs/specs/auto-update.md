# Auto-Update Spec

> - See `docs/specs/glossary.md` for Baseboard / Door vocabulary.
> - Owns the standalone updater's lifecycle; the release pipeline that publishes the update manifest it fetches, and the updater's configuration, are `docs/specs/deploy.md`, and the quit orchestrator that drives the install is `docs/specs/standalone.md` §Quit flow.

The standalone app checks for updates on launch, where the network policy allows it, and prompts in the Baseboard. **Never download or install an update until the user approves its prompt**; the download then runs in the background, the install at quit.

## How it works

On launch the updater, in order:

1. **Must read and clear the post-install marker** (§localStorage) and show its notice; a reported failure suppresses this launch's check and reminder.
2. Reads the network policy over the Burrow link and, where it allows (`docs/specs/remote-network.md` → "Updates"), calls `check()`: no update is silent, an update raises the approval prompt.
3. Shows the reminder if due, recording `remindedAt`.

**Must skip that `check()` once an update is approved**, including through Check now, and drop its result if approval lands while it runs. The reminder is re-evaluated periodically while the app runs, reading no policy and never checking, never over an undismissed notice or before the clock is set. **Only approval starts the background `download()`**; a failed download leaves the update available, so a second approval retries, and only a successful one makes it pending.

Check now (`checkNow()`) joins a check in flight, and shows an approved update's progress instead of checking, which would offer it for approval twice. **Must record `checkedAt` on every successful check**, automatic or asked for (§localStorage).

**Never check from a self-host build** (`docs/specs/relay.md` → "Relay origin"): `startUpdateCheck()` and `checkNow()` act only when the webview's baked mode, `bakedRelayMode()`, is `hosted`.

### Quit-time install

**Never intercept quit in the updater**: install runs only when `hasPendingUpdate()` is true, after the quit orchestrator's teardown and save/drain steps (`docs/specs/standalone.md` §Quit flow; rationale). **Must install in `main`**, the window the quit walk tears down last and the only one holding `updater:default` (`capabilities/main-only.json`), so nothing another window could still be writing outlives the install.

Only `main` checks, so only it can hold a download, which lives in its webview's memory: closing `main` discards an approved update, which its close confirmation says (`docs/specs/standalone.md` → "Per-window close"; rationale). `installPendingUpdate()` writes the success marker (§localStorage) and, on Windows, tears down the sidecar (§Sidecar teardown on Windows) before `install()`. **Never close the window from the install**: exiting is `quit_proceed`'s job, after it returns.

**Must skip `install()` in Vite dev mode**, dropping the pending update (rationale), so install is tested from a packaged app.

## Sidecar teardown on Windows

**Must await `kill_sidecar_now` before `install()` on Windows**, so NSIS can replace the sidecar's loaded node-pty modules and ConPTY children (rationale). Rust polls `try_wait` under a ~5 s cap; a timeout or wait error is logged and the install proceeds without confirmed exit. **Never use the job object's `wait()`**, whose completion message may already have been consumed (rationale). macOS and Linux replace open files and skip the step.

## Update notice in the Baseboard

Update status is a text notice in the Baseboard's `notice` slot (`docs/specs/layout.md`), one per updater state (`UpdateBannerState`). "Install when I quit" is the approval; "Changelog" opens `https://dormouse.sh/changelog/after/<getVersion()>`. **"Restart now" must call `quit_restart`** (`docs/specs/standalone.md` → "Restart"): the quit installs on its way out, then relaunches. A refusal turns a still-shown `downloaded` into `restart-refused`, carrying the host's reason and never "Restart now", since the refusal holds until relaunch; the update stays pending.

**Must let every state be dismissed, and never cancel an approved download or install by it**; dismissing an unapproved `available` approves nothing, and Check now may offer it again.

### Debug report on failure

The failure notice opens `UpdateDebugModal`, which snapshots the failure so a later state change cannot alter it, and offers a seeded GitHub issue search and a copyable report carrying the log tail (rationale). A failed log read is embedded as a placeholder, never aborting the report.

### Threading

**Never put updater knowledge in `lib/`**: every updater module is standalone-only, so the notice reaches the Baseboard as an opaque `ReactNode` slot (`baseboardNotice` → `notice`), and Settings reads the checks through the platform's optional `updates` port (`UpdatesPort`), which `main.tsx` gives `main` alone, and only in a build that checks.

## Platform behavior at quit

`quit_proceed` runs on every path (`docs/specs/standalone.md` §Quit flow), so app exit is uniform, Windows aside; only the install step differs:

| Platform | Install step |
|----------|--------------|
| Windows | Awaits `kill_sidecar_now`, then `install()` starts the NSIS installer in passive mode (progress bar, no interaction) and exits the process itself, before `quit_proceed` is reached |
| macOS | `install()` replaces the `.app` bundle in place |
| Linux | `install()` replaces the AppImage in place |

**The app relaunches only on a restart** (`docs/specs/standalone.md` → "Restart"), which a debug build refuses — except that a Windows install always relaunches, by NSIS (`/R`).

## localStorage

`dormouse:update-result`, the post-install marker, cleared on the next launch after reading:

| Scenario | Value written |
|----------|--------------|
| Successful install | `{ "from": "0.4.0", "to": "0.5.0" }` |
| Failed install | `{ "failed": true, "version": "0.5.0", "error": "..." }` |

**Must write the success marker before `install()`**, which never returns on Windows. **Must confirm its target against the running app version on next launch**; a mismatch becomes a failure notice and suppresses the update check. A throwing `install()` overwrites it with a failure entry; an unapproved update writes nothing. **Must ignore corrupt markers**, including invalid field types.

`dormouse:update-check`, the check clock: `{ "checkedAt": number | null, "since": number, "remindedAt": number | null }`, epoch ms — the last successful check, when this machine started counting, and the last reminder. Written by the first launch, tick, or check that finds none, with `since` then; never cleared. A value of the wrong shape counts as none, restarting the clock. A time ahead of the clock is saved as now, the others kept, so a clock set back delays the reminder a week at most.

## Files

| File | Role |
|------|------|
| [`standalone/src/updater.ts`](../../standalone/src/updater.ts) | The updater: check, reminder, approval, download, quit-time install, markers, the `updates` port |
| [`standalone/src/UpdateBanner.tsx`](../../standalone/src/UpdateBanner.tsx) | Each state's notice copy and actions |
| [`standalone/src/UpdateDebugModal.tsx`](../../standalone/src/UpdateDebugModal.tsx) | Failure modal |

## Configuration

`plugins.updater` in `standalone/src-tauri/tauri.conf.json` — the endpoint, the key releases are signed against, the Windows install mode — is `docs/specs/deploy.md` → "Tauri auto-updater". Updater, app-version, and shell-open calls need capability entries; custom Tauri commands need none.
