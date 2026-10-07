# Run the Dormouse Relay behind Tailscale

> - See `docs/specs/glossary.md` for Session, baseboard, and remote-role vocabulary.
> - This is an assistant-run setup playbook. Start a fresh Claude instance in this repository and say: `read @SELF_HOST.md and walk me through it`.
> - It is also the spec for `deploy/local/` — the [Installer contract](#installer-contract-maintainers) at the end is the maintainer half, and `scripts/spec-lint.mjs` checks this file with the specs.

Installs the Dormouse coordinating Relay on the user's own laptop — or, to outlive its sleep, on an always-on tailnet box ("Keeping the relay up while the laptop sleeps") — reachable only from their tailnet at `https://<laptop>.<tailnet>.ts.net`. One idempotent installer per platform:

| OS | Installer | Service | Install root |
| --- | --- | --- | --- |
| macOS | `deploy/local/install-macos.sh` | LaunchAgent `sh.dormouse.relay` | `~/Library/Application Support/Dormouse Relay` |
| Windows | `deploy/local/install-windows.ps1` | Scheduled Task `\Dormouse Relay` | `%LOCALAPPDATA%\Dormouse Relay` |
| Linux | `deploy/local/install-linux.sh` | systemd user unit `dormouse-relay.service` | `~/.local/share/dormouse-relay` |

**Pick the column that applies before the first command and stay on it** — mixing them is the main way this runbook goes wrong. Each checkpoint that differs gives all three forms; the [Mechanism map](#mechanism-map) has the rest.

This runbook covers running the installer and finishing what it cannot — the passkey, the Burrow build (Standalone or VS Code), the backup — with no code for anyone to write or edit.

## Instructions to the assistant

Guide the user one checkpoint at a time: do the command-line work you safely can, pause for browser consent flows, secrets, and approval of external or destructive changes, and **never dump the whole runbook back at the user**.

**Run the installer; never reimplement it** or paper over it with hand-run `launchctl`, `schtasks`, `systemctl --user` or `tailscale serve`. Wrong behavior is a bug in that platform's installer: say so plainly and offer to fix it as an ordinary reviewed code change, a separate task. Its contract is the [Installer contract](#installer-contract-maintainers) here; a change to one is a change to both.

Before acting:

1. Read `docs/specs/relay.md` ("Configuration", "Relay origin"), `docs/specs/remote-security-model.md` for the trust model, and the [Installer contract](#installer-contract-maintainers).
2. Establish the OS and pick the installer column; run its `--help` / `-Help`, skim the script, and quote its errors rather than paraphrasing — they are written for whoever is standing here.
3. An install root that already exists means an update or a repair: read `manage status` before changing anything.
4. Recheck the linked documentation — dashboards and CLI syntax change.
5. Explain the checkpoint, carry it out, verify it, then move on.
6. **Never ask the user to paste the setup password or any other bearer credential into chat.** `manage show-password` prints it in their terminal.
7. Never commit, push, merge, or delete installed state without first showing the exact change and obtaining approval.
8. For a relay that outlives this laptop's sleep, read "Keeping the relay up while the laptop sleeps" with the user rather than improvising cloud infrastructure.

Keep a worksheet, filled in as values become known: laptop OS; its Tailscale DNS name (from `tailscale status --json`); external origin (`https://<laptop-name>.<tailnet-dns-suffix>`); install root (the installer prints the exact path, honoring `$XDG_DATA_HOME` on Linux) and its `state/`; service; loopback port `3100`; lingering, on Linux only; and the installed release, which the installer and `manage status` both print.

## Prerequisites

- **A tailnet** with MagicDNS and HTTPS certificates enabled, Tailscale running on this laptop and on the phone that will run Pocket. Whether the HTTPS origin stays private is a deployment choice, not a security premise (`docs/specs/security-remote.md` → "Network posture (self-hosted)").
- **macOS, Windows or Linux.** Each installer refuses the others. On a fourth OS, or Linux without systemd, design the native service manager with the user rather than translating LaunchAgent, Scheduled Task or unit-file commands blindly.
- **An ordinary terminal.** Every installer refuses to run privileged — root on macOS and Linux, elevated on Windows — because the one account owning `config/` and `state/` is the whole credential posture (`docs/specs/security-remote.md` → "Network posture (self-hosted)").
- **On Linux, this account must be allowed to operate `tailscaled`.** Preflight checks before the build and prints the fix, but never runs `sudo`; this is the only step of a Linux install needing root:

  ```sh
  sudo tailscale set --operator=$USER
  ```
- **On Linux, decide the availability shape before installing.** The default is per-login like macOS and Windows: up from login to logout. A machine reached over SSH, or serving with nobody logged in, needs `--linger`. Switching later is `loginctl enable-linger $USER` / `disable-linger`, not a reinstall.
- **On Windows, one signed-in user at a time owns Tailscale.** A second signed-in profile fails every `tailscale` call with `401 Unauthorized: Tailscale already in use by <user>`, and elevating does not bypass it; that user must sign out or quit the tray app (`quser` lists the sessions). Preflight detects it and names the account.
- **A Burrow built for this Relay's origin.** The shipped standalone and VS Code Burrows reach only Dormouse Hosted, so a self-host Relay needs a local build of whichever Burrow the user runs, its `DORMOUSE_RELAY_ORIGIN` byte for byte the `DORMOUSE_ORIGIN` the installer writes to `config/relay.env`:

  ```sh
  DORMOUSE_RELAY_ORIGIN=https://<laptop>.<tailnet>.ts.net pnpm dogfood:standalone
  DORMOUSE_RELAY_ORIGIN=https://<laptop>.<tailnet>.ts.net pnpm dogfood:vscode
  ```

  That self-host build has no one-time connection, no managed voice, and no auto-update — update it by rebuilding (`docs/specs/relay.md` → "Relay origin").

## What the installer does

It builds the exact current checkout into a self-contained release, registers a per-login user agent restarted on exit ([Mechanism map](#mechanism-map)) running the Relay on `127.0.0.1:3100`, and points `tailscale serve --bg` at it to terminate private HTTPS — all under the current user's profile:

```text
<install root>/
  bin/
    run-relay            (run-relay.ps1 on Windows)
    manage                (manage.ps1 + manage.cmd on Windows)
  config/
    relay.env
  current    -> releases/<release-id>     (current.txt naming it, on Windows)
  previous   -> releases/<release-id>     (previous.txt, on Windows)
  releases/
    <release-id>/
      runtime/node        (runtime\node.exe on Windows)
      relay/
      lib/dist-pocket/
      RELEASE
  run/
    enroll-offer.json
    relay.json
  state/
    account.json
    burrows.json
    push-subscriptions.json
    setup-password.json
    vapid.json
```

Logs: `~/Library/Logs/Dormouse Relay/` on macOS, `<install root>\logs` on Windows, `~/.local/state/dormouse-relay/logs` on Linux. Service definition: `~/Library/LaunchAgents/sh.dormouse.relay.plist`, the Scheduled Task `\Dormouse Relay`, or `~/.config/systemd/user/dormouse-relay.service`.

Until the first Burrow enrolls, `run/enroll-offer.json` lets a Dormouse Burrow on this machine enroll in one click without the setup password (checkpoint 4, step 2); its lifetime is `docs/specs/relay.md` → "Configuration".

No installer will **ever**: run `git pull`, fetch, or switch branches; install a scheduled updater; install or re-authenticate Tailscale; rewrite an origin that no longer matches the node's DNS name; or touch `config/` and `state/`, which survive every update, prune, and uninstall.

An update is a short restart: Burrow and Pocket WebSockets disconnect and reconnect ([Invariants](#invariants)).

## Definition of done

`manage verify` checks all of these locally and exits nonzero on any failure:

- **The service is registered and running, declares the run-at-load and restart-on-exit of the [Mechanism map](#mechanism-map), and carries no credential** — a definition it cannot read at all fails rather than passes, and `verify` searches it and the `run-relay` wrapper for every credential name the installer knows. Plus what only the live system shows: macOS, loaded in `gui/$UID` with a plist that lints; Windows, task `Running`, no execution time limit, restarts on failure, unelevated, unstopped by battery or idle, `bin\run-relay.ps1` still carrying the supervision loop; Linux, unit known to the user manager, `enabled`, passing `systemd-analyze --user verify`.
- **Loopback `/api/hello` responds, the Pocket app is served, and the process holding the port belongs to the current release** ([Invariants](#invariants) → "A 200 does not say who answered"); Linux additionally requires `systemctl --user is-active`.
- **Port 3100 is bound only to `127.0.0.1`**, and the plaintext port is unreachable on the laptop's Tailscale IP.
- **`tailscale serve` proxies `/` to `127.0.0.1:3100` at the origin recorded in `config/relay.env`.** A failure prints the `manage serve` command that re-applies it.
- **`config/`, `state/`, `run/`, `config/relay.env` and an unspent offer are owner-only** (`docs/specs/security-remote.md` → "Credentials at rest"); a spent offer is gone, and `verify` says so rather than failing.
- **The current release pointer resolves to a release with `RELEASE` metadata**, and neither the service definition nor the `run-relay` wrapper refers to the source checkout. An absent previous-release pointer warns (a first install); one naming the same release as `current`, or a release no longer on disk, fails.

What the laptop cannot prove alone — reachability from another device, a real restart, an update and rollback, a phone session, an off-laptop backup — is checkpoints 3–6.

## Checkpoint 1: preflight

The installer preflights and stops with a specific error, so do not re-run its checks by hand: OS and unprivileged session; the Tailscale CLI, backend state, MagicDNS name, HTTPS certificates, and (Windows) local-API owner or (Linux) operator role; an origin disagreeing with an existing installation; the Git SHA and dirty status; the Node and pnpm versions pinned in root `package.json`; and on Linux a reachable systemd user manager, version 240 or newer.

Establish with the user what the script cannot:

- **This checkout is the one they want installed.** Show `git status --short`, the branch, and the SHA. Never pull or switch branches on their behalf; the installer installs exactly what is checked out.
- **Their phone runs Tailscale** and is signed in to the same tailnet.
- **Port 3100 is free.** Unchecked before installation; a stale listener blocks the new Relay from binding and fails the post-install identity check. A dev Relay is not normally the culprit: `pnpm dev:relay` takes any free port unless `PORT` names one.

  ```sh
  # macOS
  lsof -nP -iTCP:3100 -sTCP:LISTEN
  ```

  ```powershell
  # Windows
  Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue
  ```

  ```sh
  # Linux
  ss -lntp 'sport = :3100'
  ```

## Checkpoint 2: install

With the user's approval:

```sh
# macOS
./deploy/local/install-macos.sh
```

```powershell
# Windows, from an ordinary (not elevated) PowerShell
.\deploy\local\install-windows.ps1
```

```sh
# Linux, as the ordinary user who will own the install (no sudo).
# Add --linger only if the service must outlive logout.
./deploy/local/install-linux.sh
```

On a machine with a pre-rename install, the installer removes the retired `sh.dormouse.server` LaunchAgent / `dormouse-server.service` unit, since both bind the same port, but leaves the old install root and logs: say so, and let the user delete them.

Read its printed steps with the user rather than summarizing. Its confirmations — a dirty worktree, a mismatched pnpm, repointing an already-claimed Serve root path — are the user's decisions, and it refuses to assume an answer with no terminal. Tailscale may open a browser consent flow the first time Serve requests a certificate; that one is the user's to click. A first install ends by pointing at `manage show-password`; do not run that yet.

## Checkpoint 3: verify

```sh
# macOS
"$HOME/Library/Application Support/Dormouse Relay/bin/manage" verify
```

```powershell
# Windows
& "$env:LOCALAPPDATA\Dormouse Relay\bin\manage.cmd" verify
```

```sh
# Linux — the installer prints the exact path; this is the default when
# XDG_DATA_HOME is unset.
"$HOME/.local/share/dormouse-relay/bin/manage" verify
```

Expect every check to pass and the command to exit 0. `manage status` gives the same picture without the pass/fail framing.

Then, from another tailnet-connected device: request `https://<laptop>.<tailnet>.ts.net/api/hello`, open the Pocket application at the same origin. If private HTTPS is intended, temporarily leave Tailscale on that device and confirm the origin becomes unreachable.

Kill the Relay process once and confirm the service manager restarts it:

```sh
# macOS — launchd restarts within a second or two
pkill -f 'Dormouse Relay/current/relay/dist/index.js'
"$HOME/Library/Application Support/Dormouse Relay/bin/manage" status
```

```powershell
# Windows — select by install-root path and command line, never by image name:
# other node.exe processes on this machine are not the Relay. The supervision
# loop restarts after a 10s throttle, so wait ~15s before reading status.
$root = "$env:LOCALAPPDATA\Dormouse Relay"
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -like "$root\*" -or $_.CommandLine -like "*$root*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
& "$root\bin\manage.cmd" status
```

```sh
# Linux — Restart=always with RestartSec=10, so wait ~15s before reading status.
systemctl --user kill --signal=SIGKILL dormouse-relay.service
"$HOME/.local/share/dormouse-relay/bin/manage" status
```

On Linux, also prove the availability shape you chose. Without `--linger`: log out fully, confirm the service is gone (`loginctl` shows no session and the origin stops answering), then log back in and confirm it returns on its own. With `--linger`: it keeps answering across a logout, and `loginctl show-user $USER -p Linger` reports `yes`.

Restart the laptop only with the user's approval; otherwise say plainly that the run-at-load trigger and registered service were verified but the reboot test skipped. After a real login or reboot, confirm the process and the background Serve mapping both return without rerunning the installer.

## Checkpoint 4: first-run setup

The Relay has no account, no passkey, and no enrolled Burrow. Same sequence as `docs/specs/relay.md` → "Running it", run against the tailnet origin, with the Relay's generated password. **The Burrow comes first**: a passkey is registered only off a code an enrolled Burrow displays (`docs/specs/relay.md` → Setup tokens and the pairing QR).

1. **The setup password.** Needed only if the step-2 offer card is gone or the Burrow is elsewhere: have the user run `manage show-password` in their own terminal, which warns before printing. Never ask for the value, and never print it into the conversation.

2. **The Burrow.** On this same machine, launch the build made with `DORMOUSE_RELAY_ORIGIN` (Prerequisites), open **Settings → Network** (the baseboard's Settings button), and choose **Anywhere, through** your Relay's host: a new install's default, **Nowhere**, refuses enrollment (`docs/specs/remote-network.md` → "Policy"). While the offer is unspent, its card enrolls in one click; "Enroll with the setup password…" covers a spent offer or a Burrow on another machine (`docs/specs/relay.md` → "Remote control, in the Settings dialog"). Enrollment persists, so later launches connect on their own; the section then shows the Relay and its connection.

   A Burrow that offers only "Enroll with hosted.dormouse.sh" is a stock build, not a Relay problem.

3. **The phone, and only then the code.** On the phone, open `https://<laptop>.<tailnet>.ts.net` in Safari and confirm it leads with **Scan a setup code**. For push, add Pocket to the Home Screen and pair inside the installed app (`docs/specs/pocket-app.md` → Installable web app). **A setup code is live for five minutes**, so that first load — bundle, service worker, Home Screen install — must not happen inside the window. With the phone waiting on that screen, press **Set up a phone** in **Settings → Network**; scanning or pasting the code creates the passkey and signs them in, bound to this exact origin, with no password typed on the phone.

4. **A real session.** The scan runs straight into pairing: read the two digits off the phone, type them into the modal on the laptop, and **approve — the last thing anyone does**. The phone answers its own biometric prompt and lands on the machine's terminal. Only now have HTTPS proxying, the WebSocket upgrade, and the security flow been exercised together.

5. **State.** Confirm `account.json`, `burrows.json` and `vapid.json` — plus `push-subscriptions.json` if push was enabled — now exist in `state/`. Record ownership and checksums without printing contents; checkpoint 5 checks them against a reinstall.

## Checkpoint 5: updating, rollback, uninstall

Updating is choosing a checkout and rerunning the same command:

```sh
git -C <checkout> log --oneline -1     # decide deliberately what to install
./deploy/local/install-macos.sh        # or .\deploy\local\install-windows.ps1
                                       # or ./deploy/local/install-linux.sh
```

Prove it once, while the user is watching:

1. Rerun the installer from the same or a newer checkout.
2. Confirm the release changed as expected and that the `state/` checksums from checkpoint 4 and `config/relay.env` are unchanged.
3. Run `manage rollback`, confirm the previous release comes back healthy, then return to the desired release.

`manage uninstall` removes the service definition, installed code and `run/`, keeps `config` and `state` and reports where they are, and keeps `manage` itself. `manage purge` is the separate, irreversible deletion behind a typed confirmation phrase; run it after `uninstall`, and it prints the one command that clears whatever is left.

## Checkpoint 6: limits and backup

Make these explicit: the relay is down while the laptop sleeps, is shut down, has Tailscale disconnected, or is logged out; the installer does not follow `main`, so updates happen only when the user reruns it; the HTTPS origin is tied to the laptop's Tailscale node name, so renaming or re-enrolling that node means redoing the passkey and every Burrow enrollment; and Tailscale network policy still controls which tailnet members reach the laptop — review existing grants if the tailnet has other users.

Confirm the install root, especially `config` and `state`, is covered by an encrypted backup off the laptop — Time Machine, File History, Déjà Dup/restic/borg. **Check the coverage rather than assuming it**: `%LOCALAPPDATA%` is excluded from File History's default library set and from OneDrive's Known Folder Move, and `~/.local/share` from dotfile-oriented backup rules, so on both the install root is very likely unprotected until added explicitly. A second directory on the same disk is not a backup; these files hold Burrow bearer credentials and a VAPID private key. Rehearse a small restore without overwriting live state.

## Final handoff

Report concisely: the Pocket URL and its WebAuthn-origin significance; the exact installed Git SHA and whether the build was dirty; where runtime config, state, release metadata and logs live; the rollback command; backup status and restore location; any skipped acceptance test or remaining manual Burrow/Pocket setup; the update and availability limits of checkpoint 6; and the installed `manage status`, `manage verify`, `manage logs` and `manage restart` commands.

**Never print the setup password or any credential in the handoff.**

## Official references

- Dormouse Relay runtime and state contract: `docs/specs/relay.md`
- Dormouse trust model: `docs/specs/remote-security-model.md`
- Burrow installations: `docs/specs/standalone.md`, `docs/specs/vscode.md`
- [Install Tailscale on macOS](https://tailscale.com/docs/install/mac)
- [Tailscale variants on macOS](https://tailscale.com/docs/concepts/macos-variants)
- [Install Tailscale on Windows](https://tailscale.com/docs/install/windows)
- [Manage scripts with launchd](https://support.apple.com/guide/terminal/script-management-with-launchd-apdc6c1077b/mac)
- [Windows Task Scheduler](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page)
- [ScheduledTasks PowerShell module](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)

## Troubleshooting boundaries

### Phone capability diagnostics

For pairing-storage failures on iOS, Android, or desktop, open `https://<relay-origin>/diagnostics/index.html` in the affected browser and choose **Run checks**, then **Copy results**; no setup code is needed. For persistence across app or phone restarts, follow the page's restart test, and remove its test data afterward in each context where you prepared one. Inspect a report before sharing, since it includes browser/version information; each result is evidence for that one browser or installed app only. The diagnostic contract is `docs/specs/pocket-app.md` -> "The capability harness".

### Service and deployment failures

None of the three service managers runs the user's interactive shell or PowerShell startup files, so a `PATH` that works in a terminal proves nothing about any of them.

- **The service works only while the source checkout exists:** an installer bug — the release must be self-contained — not a reason to keep the checkout around. `manage verify` checks it directly.
- **The service loops or will not start:** macOS — `plutil -lint` the plist, `launchctl print gui/$UID/sh.dormouse.relay`, and `~/Library/Logs/Dormouse Relay`. Windows — `Get-ScheduledTaskInfo -TaskName 'Dormouse Relay'` for `LastTaskResult`, `Export-ScheduledTask -TaskName 'Dormouse Relay'` for the definition, and `<install root>\logs`, where `run-relay.ps1` timestamps each start and exit into `relay.err.log` (a crash loop is a run of those lines). Linux — `systemctl --user status dormouse-relay.service`, `journalctl --user -u dormouse-relay.service -n 50`, and `~/.local/state/dormouse-relay/logs`.
- **The task shows `Ready` rather than `Running` after a reboot:** the at-logon trigger fires on interactive sign-in, not at boot — the per-login limit, not a fault.
- **`tailscale serve` is refused for a non-root user (Linux):** grant the operator role (Prerequisites). Preflight checks it before building, so a late hit means the check regressed or could not read the role — the release is already installed and running, so finish with `manage serve` rather than reinstalling.
- **`/api/hello` answers but the unit is not active (Linux):** something else holds port 3100 and the install correctly refuses to claim it. `ss -lntp 'sport = :3100'` names that process — unless it cannot see it, as under WSL with `networkingMode=mirrored`, where the listener may be a Windows process (a Windows Dormouse Relay install does exactly this). Stop it, or install on a host not sharing loopback.
- **The HTTPS URL returns 502:** check the loopback health endpoint first, then `tailscale serve status`; service and Serve configuration have separate lifecycles, and `manage serve` re-applies a mapping a dev session repointed.
- **Port 3100 is visible on the LAN or the Tailscale IP:** stop. Confirm `DORMOUSE_BIND_HOST=127.0.0.1` in `config/relay.env`. Tailscale access control is not a reason to expose the plaintext backend.
- **The installer stops on an origin mismatch:** it is refusing to invalidate the registered passkey and every enrolled Burrow. Establish whether the node was renamed or re-enrolled, then restore the old name or plan the re-enrollment.
- **Pocket loads but passkey setup fails:** compare the browser URL byte-for-byte with `DORMOUSE_ORIGIN` in `config/relay.env`; confirm HTTPS and the node hostname.
- **A Burrow cannot connect while Pocket can:** that Burrow build almost certainly bakes a different origin; its `DORMOUSE_RELAY_ORIGIN` must match `DORMOUSE_ORIGIN` byte for byte, and it reads an enrollment for any other as none.
- **State disappears:** verify the absolute state path for this platform's install root and the installed config. Never initialize a new account until the old state is located or restored.

## Keeping the relay up while the laptop sleeps

A per-login agent is down whenever its machine is — fine until the user controls a Burrow that is *not* this laptop. The phone reaches the origin and the Burrow dials *out* to it, so the relay need not run on the laptop: run the Linux installer with `--linger` (Prerequisites) on any always-on tailnet machine — a spare box, a NUC, a small VM — and that node's own MagicDNS name becomes the origin:

```sh
./deploy/local/install-linux.sh --linger
```

That is an origin change, a deliberate migration rather than an upgrade path: the passkey and every Burrow enrollment are redone against the new `DORMOUSE_ORIGIN`, and every Burrow is rebuilt with it (Prerequisites). That machine needs the same backup as any other install (checkpoint 6).

Managed cloud accounts and deployment belong to `docs/specs/hosted.md` -> "Application boundary".

## Installer contract (maintainers)

**Must keep one idempotent installer per platform.** Rerunning it updates the installed release from the current checkout; it never pulls, fetches, switches branches, or schedules an updater.

The security properties this deployment is audited against, and everything that enforces them, are the "Network posture (self-hosted)" and "Credentials at rest" `FAIL IF` lines in `docs/specs/security-remote.md`. **Those lines bind all three installers** — a control present in one and absent from another is a finding.

**Each release is self-contained**: the production Relay tree, `lib/dist-pocket`, and a copy of the exact Node binary the build ran under, so the service depends on neither the source checkout, nor Homebrew/nvm/a version manager, nor pnpm's store, nor the user's interactive `PATH` — none of launchd, Task Scheduler, or the systemd user manager reads any of those.

Source of truth: `deploy/local/install-macos.sh`, `deploy/local/install-windows.ps1`, `deploy/local/install-linux.sh`.

### Mechanism map

Service and install root are in the table at the top of this file; logs and service-definition paths are under "What the installer does". The Windows `KeepAlive` and `current`/`previous` rows deviate because the macOS mechanism has no unprivileged Windows equivalent (rationale).

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| RunAtLoad | plist `RunAtLoad` | the at-logon trigger, `LogonType=Interactive` (no stored password), `RunLevel=Limited` | `WantedBy=default.target`; survives logout only with opt-in `--linger`, which the installer never enables silently and `verify` reports rather than asserts |
| KeepAlive | plist `KeepAlive` | the supervision loop in `bin\run-relay.ps1`; Task Scheduler's `RestartCount` is defence in depth, not the mechanism | `Restart=always`, `RestartSec=10` |
| Stopping it | `launchctl bootout` takes the process tree | ends only the `powershell.exe`; before every start the installer and `manage` reap its children by install-root image path and command line, never image name | `systemctl --user stop` takes the whole cgroup |
| `current`/`previous` | symlinks, swapped with `rename(2)` on the link path | `current.txt`/`previous.txt` naming a release id, swapped with `rename(2)` on the file | symlinks, swapped with `rename(2)` on the link path |
| `0700` / `0600` | modes under `umask 077`; `verify` checks mode and owner | an owner-only DACL; `verify` also checks owner SID | modes under `umask 077`; `verify` checks mode and owner |
| Entry | `/bin/bash bin/run-relay` | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bin\run-relay.ps1`, at an absolute interpreter path | `ExecStart=/bin/bash "<root>/bin/run-relay"` |

### Invariants

- **One replica; an update is a short intentional restart.** Relay transient state is in memory (`docs/specs/relay.md` → Guardrails), so Burrows and Pocket clients reconnect across a release switch; no zero-downtime swap to attempt.
- **Never overwrite an existing release directory while staging.** A colliding release id fails without deleting its contents.
- **State outlives code.** `config/` and `state/` sit outside `releases/` and survive every update, prune and uninstall; purging is separate and explicitly confirmed. `config/relay.env` preservation is `docs/specs/security-remote.md` → "Credentials at rest". **Must read its last assignment for each key**, stripping only one matched pair of double quotes, in the installer, service wrapper, and management commands. `scripts/installer-verify-test.mjs` exercises the unix readers against the shipped wrapper parser.
- **`run-relay` exports `DORMOUSE_ENROLL_TOKEN_FILE`** naming `run/enroll-offer.json` (`docs/specs/relay.md` → Configuration); when the offer is minted and rotated is `docs/specs/security-remote.md` → "Credentials at rest".
- **Every installer requires `PORT=3100` in `config/relay.env`**, matching its Serve mapping (rationale). Bind host, Serve, Funnel and origin rules are `docs/specs/security-remote.md` → "Network posture (self-hosted)".
- **A failed update is a failure.** The candidate release is health-checked on an ephemeral port against a throwaway state dir *before* `current` moves; if the live service then fails to answer, `current` is restored to `previous` and the installer exits nonzero — rollback succeeding is not success. **The restore clears `previous` only once `current` is back on that release**, so the pointers are not left naming one release (both `verify` and `rollback` refuse that state) and a failed restore keeps its rollback target. The restore then confirms *which* release answered (next invariant).
- **A 200 does not say who answered.** An orphan of an older release holding the loopback port answers `/api/hello` exactly like a healthy current one, so **every check whose contract is *which release is running* proves the responder's identity**: the post-switch health check (rolls back and exits nonzero on a mismatch), the rollback restore, `manage verify`, and every command that waits for health (`manage rollback`, `manage restart`). `run-relay` passes `DORMOUSE_RUNTIME_FILE` and `DORMOUSE_RELEASE_ID` (`docs/specs/relay.md` → Configuration), and the Relay writes `RuntimeInfo` only once **bound**, so the identity check is a file read, a port match and a liveness check. **It cannot go in `/api/hello`**, which is unauthenticated and reachable through the HTTPS proxy. **Empty means unknown, never "nobody"** — a stale file with a dead pid, a Relay started outside the installer, and a foreign port-holder all fail the comparison. **Linux still leads with `systemctl --user is-active`**, which catches a responder no port lookup can see: a foreign network namespace, or WSL with `networkingMode=mirrored`. `manage status` on all three reports what the pointers say by design. Source of truth: `relay/src/runtime-file.ts`.

### Mechanical traps

Each fails silently unless encoded in every installer it names; single-platform traps live as comments at their code:

- **`pnpm deploy --prod --legacy` poisons the workspace.** (All three.) **Snapshot and restore pnpm's workspace-state file on every exit**, including failed installs (rationale).
- **`mv -f tmp link` follows a symlink to a directory.** (macOS, Linux.) **Use `rename(2)` on the link path and assert that `current` advanced** (rationale).

### Operator surface and test hooks

`bin/manage` (`bin\manage.ps1`, with a `manage.cmd` shim, on Windows) carries: `status`, `verify`, `logs`, `restart`, `show-password`, `serve` (re-apply the Serve mapping after a dev session repointed it), `rollback`, `uninstall`, and the separately-confirmed `purge`.

**`uninstall` must leave `manage` behind**, so `purge` stays reachable for `config/` and `state/`. **`purge` deletes `run/` along with `state/` and `config/`**, and once uninstalled prints the one command removing the install root and, on macOS and Linux, the log directory outside it. Source of truth: `cmd_uninstall` / `cmd_purge` in `deploy/local/install-linux.sh` and `deploy/local/install-macos.sh`; `Invoke-Uninstall` / `Invoke-Purge` in `deploy/local/install-windows.ps1`.

Two test-only hooks, each refused unless `DORMOUSE_INSTALL_TEST=1`: `DORMOUSE_INSTALL_ROOT` puts the whole install under a throwaway path, and — Linux only — `DORMOUSE_INSTALL_ORIGIN` supplies the origin so Tailscale is never consulted. `.github/workflows/ci.yml` pins the Linux install/update path in a temp root. Test mode stops before systemd and Serve; macOS and Windows have no runtime CI coverage, so `deploy-lint` checks all three installers textually.
