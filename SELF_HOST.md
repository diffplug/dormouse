# Run the Dormouse server behind Tailscale

> This is an assistant-run setup playbook. Start a fresh Claude instance in
> this repository and say: `read @SELF_HOST.md and walk me through it`.
>
> It is also the spec for `deploy/local/` — the
> [Installer contract](#installer-contract-maintainers) at the end is the
> maintainer half, and `scripts/spec-lint.mjs` checks this file with the specs.

This installs the Dormouse coordinating server on the user's own laptop,
reachable only from their tailnet at `https://<laptop>.<tailnet>.ts.net`. That
is the whole self-host story today. To keep the relay up while that machine
sleeps, run the same installer on an always-on tailnet box — see "Keeping the
relay up while the laptop sleeps".

The installer already exists — one idempotent command that ships in this
repository, in a macOS, a Windows and a Linux edition:

| OS | Installer | Service | Install root |
| --- | --- | --- | --- |
| macOS | `deploy/local/install-macos.sh` | LaunchAgent `sh.dormouse.server` | `~/Library/Application Support/Dormouse Server` |
| Windows | `deploy/local/install-windows.ps1` | Scheduled Task `\Dormouse Server` | `%LOCALAPPDATA%\Dormouse Server` |
| Linux | `deploy/local/install-linux.sh` | systemd user unit `dormouse-server.service` | `~/.local/share/dormouse-server` |

The three hold the same invariants through different native mechanisms; where a
checkpoint below differs, each form is given. **Work out which one applies
before the first command and stay on that column** — mixing them is the main way
this runbook goes wrong. The [Installer contract](#installer-contract-maintainers)
at the end of this file carries the full mechanism-by-mechanism table.

This runbook is about running the installer and finishing the parts it cannot do
on its own — the passkey, the Host build, the backup. Nobody following it should
have to write or edit code.

## Instructions to the assistant

Your job is to guide the user through this runbook one checkpoint at a time,
performing the command-line work you safely can and pausing only for browser
consent flows, secrets, or explicit approval of external or destructive
changes. Do not dump the entire runbook back at the user.

The installer is shipped, reviewed code. Run it — do not reimplement it, and do
not paper over it with hand-run `launchctl`, `schtasks`, `systemctl --user` or
`tailscale serve` commands. If it does the wrong thing, that is a bug in the
installer for that platform: say so plainly and offer to fix it as an ordinary
reviewed code change, which is a different task from this one. Its contract is
the [Installer contract](#installer-contract-maintainers) section of this same
file; a change to one is a change to both.

Before acting:

1. Read `docs/specs/server.md` — "Configuration" and "Where a Host may reach a
   relay server (self-host builds)" — plus `docs/specs/remote-security-model.md`
   for the trust model you are about to set up, and the
   [Installer contract](#installer-contract-maintainers) below.
2. Establish the OS and pick the installer column. Run its `--help` / `-Help`
   and skim the script. Its errors are written to be read by whoever is standing
   here; quote them rather than paraphrasing.
3. Check whether the install root for that platform already exists. If it does,
   this is an update or a repair, not a first install: read `manage status`
   before changing anything.
4. Recheck the linked official documentation. This runbook was updated on
   2026-08-27; dashboards and CLI syntax change.
5. Explain the current checkpoint, carry it out, verify it, and only then move
   to the next checkpoint.
6. Never ask the user to paste the setup password or any other bearer credential
   into chat. The installer generates it on the laptop and leaves it in a
   mode-`0600` file; `manage show-password` prints it in their terminal.
7. Do not commit, push, merge, or delete installed state without first showing
   the exact change and obtaining the user's approval.
8. If the user needs a relay that stays up while this laptop is asleep, read
   "Keeping the relay up while the laptop sleeps" with them rather than
   improvising cloud infrastructure. It is the same installer on another
   machine, and it changes the origin.

Keep a small worksheet in the conversation and fill it in as values become
known:

| Value | Default / example |
| --- | --- |
| Laptop OS | must be macOS, Windows or Linux |
| Laptop Tailscale DNS name | the installer derives it from `tailscale status --json` |
| External origin | `https://<laptop-name>.<tailnet-dns-suffix>` |
| Install root | macOS `~/Library/Application Support/Dormouse Server` · Windows `%LOCALAPPDATA%\Dormouse Server` · Linux `$XDG_DATA_HOME/dormouse-server`, i.e. `~/.local/share/dormouse-server` unless XDG is set — the installer prints the exact path it used |
| State directory | `<install root>/state` |
| Service | macOS `~/Library/LaunchAgents/sh.dormouse.server.plist` · Windows Scheduled Task `\Dormouse Server` · Linux `~/.config/systemd/user/dormouse-server.service` |
| Loopback port | `3100` |
| Lingering (Linux only) | off unless installed with `--linger`; decides whether the service outlives logout |
| Installed release | printed by the installer and by `manage status` |

## Prerequisites

- **A tailnet.** The user needs a Tailscale account with MagicDNS and HTTPS
  certificates enabled, Tailscale running on this laptop, and Tailscale on the
  phone that will run Pocket. A tailnet-only origin is not reachable merely
  because the laptop is on the tailnet.
- **macOS, Windows or Linux.** Each installer refuses to run on the other
  platforms. On a fourth OS, or on a Linux box without systemd, stop and design
  the native service manager with the user rather than translating LaunchAgent,
  Scheduled Task or unit-file commands blindly.
- **No installer runs privileged.** All three refuse — as root on macOS and
  Linux, elevated on Windows. The whole credential posture is that one user
  account owns `config/` and `state/`; an elevated run would write them owned by
  another principal and register the service for it. Use an ordinary terminal.
- **On Linux, this account must be allowed to operate `tailscaled`.** Its local
  API socket is root-owned, so an unprivileged `tailscale serve` is refused. The
  installer checks this in preflight — before the build — and prints the fix:

  ```sh
  sudo tailscale set --operator=$USER
  ```

  It will not run `sudo` for the user. This is the only step of a Linux install
  that needs root at all.
- **On Linux, decide the availability shape before installing.** The default is
  a per-login service, matching macOS and Windows: it starts when the user logs
  in and stops when they log out. A machine reached over SSH, or one expected to
  serve while nobody is logged in, needs `--linger` instead. Changing your mind
  later is `loginctl enable-linger $USER` / `disable-linger`, not a reinstall.
- **On Windows, one signed-in user at a time owns Tailscale.** `tailscaled`
  serves its local API to a single interactive session, so on a PC with a second
  signed-in profile every `tailscale` call fails with
  `401 Unauthorized: Tailscale already in use by <user>`. That user must sign
  out or quit the Tailscale tray app first. The installer detects this in
  preflight and names the account holding it.
- **A Host build that can reach a `*.ts.net` origin.** The shipped standalone
  and VS Code Hosts bake in the SaaS-only relay allowlist, so a self-host relay
  needs a local build of whichever Host the user runs:

  ```sh
  DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:standalone
  DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:vscode
  ```

  `standalone/scripts/build-sidecar-proxy.mjs` and
  `vscode-ext/scripts/esbuild.mjs` bake that variable into their respective
  Node Host bundles. The relay socket no longer lives in either webview, so
  changing a webview CSP does not widen this allowlist.

## What the installer does

```text
user runs the installer for their platform
        |
        v
build exact current checkout into a self-contained release
        |
        v
per-login user agent, restarted on exit
  macOS   LaunchAgent (RunAtLoad + KeepAlive)
  Windows Scheduled Task (at logon) + supervision loop in run-server.ps1
  Linux   systemd user unit (WantedBy=default.target, Restart=always)
        |
        v
Dormouse Node server on 127.0.0.1:3100
        |
        v
tailscale serve --bg terminates private HTTPS
        |
        v
https://<laptop>.<tailnet>.ts.net
```

It installs only under the current user's profile, needs no administrator
rights, and lays out:

```text
<install root>/
  bin/
    run-server            (run-server.ps1 on Windows)
    manage                (manage.ps1 + manage.cmd on Windows)
  config/
    server.env
  current    -> releases/<release-id>     (current.txt naming it, on Windows)
  previous   -> releases/<release-id>     (previous.txt, on Windows)
  releases/
    <release-id>/
      runtime/node        (runtime\node.exe on Windows)
      server/
      lib/dist-pocket/
      RELEASE
  run/
    enroll-offer.json
    server.json
  state/
    account.json
    hosts.json
    push-subscriptions.json
    vapid.json
```

Logs live in `~/Library/Logs/Dormouse Server/` on macOS, `<install root>\logs`
on Windows, and `~/.local/state/dormouse-server/logs` on Linux. The service
definition is `~/Library/LaunchAgents/sh.dormouse.server.plist`, the Scheduled
Task `\Dormouse Server`, or
`~/.config/systemd/user/dormouse-server.service`.

Before first Host enrollment, `run/enroll-offer.json` holds origin and a token that
`POST /api/host/enroll` accepts in place of the setup password. A Dormouse Host
on this machine reads the same file and offers one-click enrollment from it
(checkpoint 4, step 3). It expires after 24 hours; either credential path's
first Host enrollment removes it, and later installer runs do not recreate it.

No installer will **ever**: run `git pull`, fetch, or switch branches; install a
scheduled updater; ask for elevation; install or re-authenticate Tailscale;
rewrite an origin that no longer matches the node's DNS name; or touch `config/`
and `state/`, which survive every update, prune, and uninstall.

The invariants it exists to hold — one replica, state outlives code, loopback
only, `DORMOUSE_ORIGIN` as durable WebAuthn identity, and a failed update being
a failure rather than a rollback dressed as success — are the
[Installer contract](#installer-contract-maintainers)'s Invariants. Two of them
shape what the user should expect day to day:

- An update is a short intentional restart. Existing Host and Pocket WebSockets
  disconnect and reconnect; there is no zero-downtime swap to attempt.
- All three are per-login agents, so the service is unavailable while the laptop
  sleeps, is shut down, or has no logged-in user. That is normally fine, because
  there is then no local Dormouse Host to control either. On Windows the
  at-logon trigger uses `LogonType=Interactive`, which is what keeps the task
  free of a stored password — and is the same tradeoff. Linux is the one
  platform that can be opted out of this, with `--linger` — see Prerequisites.

## Definition of done

`manage verify` checks all of these locally and exits nonzero on any failure:

- The service is registered and running, declares its run-at-load and
  restart-on-exit behavior, and carries no credential. On macOS: the LaunchAgent
  is loaded in `gui/$UID` and its plist lints, declares `RunAtLoad` and
  `KeepAlive`. On Windows: the Scheduled Task is `Running`, has an at-logon
  trigger, no execution time limit, restarts on failure, runs unelevated, is not
  stopped by battery or idle transitions, and `bin\run-server.ps1` still carries
  the supervision loop that is the actual KeepAlive. On Linux: the unit is known
  to the user manager, is `enabled`, passes `systemd-analyze --user verify`, and
  declares `Restart=always` and `WantedBy=default.target`.
- Loopback `/api/hello` responds and the Pocket app is served, and the process
  actually holding the port belongs to the current release — an orphan of an
  older release answers `/api/hello` identically, so a 200 alone would let every
  check here pass while stale code serves. The server records its own identity
  at bind time, so this is a file read rather than a hunt through the process
  table; Linux additionally requires `systemctl --user is-active`, which is
  what catches a responder no port lookup can see at all.
- Port 3100 is bound only to `127.0.0.1`, and the plaintext port is unreachable
  on the laptop's Tailscale IP.
- `tailscale serve` proxies to `127.0.0.1:3100` at the same origin recorded in
  `config/server.env`, and `tailscale funnel` is **off** — a Funnel would
  publish this same origin to the public internet, which the setup password's
  hardening was never sized for (`SECURITY.md` -> "Network posture").
- `config/`, `state/`, `run/` and `config/server.env` are readable only by the
  installing user: modes `0700`/`0600` on macOS and Linux, a DACL with exactly
  that one user on Windows. The Windows check also covers each file in `state/`
  individually, because Node's file modes are a no-op there. The Linux check
  also asserts the *owner* of all four, since a `0700` directory owned by
  someone else satisfies the mode and inverts the property. `run/enroll-offer.json`
  is held to the same standard while it is there; a spent offer is gone, and
  `verify` says so rather than failing.
- The current release pointer resolves to a release with `RELEASE` metadata, and
  neither the service definition nor the `run-server` wrapper refers to the
  source checkout. A retained previous release is checked too, but a first
  install has none, so `verify` warns there rather than failing. It does fail if
  that pointer names the same release as `current`, because such an install
  advertises a rollback target that does not exist.

These cannot be proven from the laptop, and are the checkpoints below:

- The HTTPS origin answers from a second tailnet device, and stops answering
  when that device leaves the tailnet.
- The service manager restarts the server after a real kill.
- State survives a reinstall from a newer checkout, and rollback returns the
  previous release.
- Pocket passkey setup and Host enrollment complete against this origin.
- The install root is backed up somewhere off this laptop.

## Checkpoint 1: preflight

The installer performs its own preflight and stops with a specific error rather
than proceeding, so do not re-run these by hand: the right OS and an unprivileged
session, the Tailscale CLI (on `PATH`, in the macOS app bundle invoked with
`TAILSCALE_BE_CLI=1`, or under `Program Files\Tailscale` on Windows), backend
state `Running`, the node's MagicDNS name and derived origin, tailnet HTTPS
certificates, an origin that disagrees with an existing installation, the Git SHA
and dirty status (it asks before installing a dirty worktree), and the Node and
pnpm versions pinned in root `package.json`. The Windows edition additionally
names the account holding `tailscaled`'s local API when another signed-in user
has it. The Linux edition additionally checks that a systemd user manager is
reachable, that systemd is 240 or newer, and that this account may operate
`tailscaled` — that last one before the build, because the refusal would
otherwise surface only at the Serve step, after `current` had already moved.

Establish with the user what the script cannot:

- **This checkout is the one they want installed.** Show `git status --short`,
  the branch, and the SHA. Do not pull or switch branches on their behalf; the
  installer intentionally installs exactly what is checked out.
- **Their phone runs Tailscale** and is signed in to the same tailnet.
- **Port 3100 is free.** The installer does not check this before installing.
  `pnpm dev:server` and `pnpm dev:pocket-server` use 3000, not 3100, but a stale
  process of any kind on 3100 would let the post-install health check pass
  against the wrong server:

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

It prints each step. Read the output with the user rather than summarizing it —
the confirmations it asks for (a dirty worktree, a mismatched pnpm, repointing
an already-claimed Serve root path) are decisions, and it refuses to assume an
answer when there is no terminal. Tailscale may open a browser consent flow the
first time Serve requests a certificate; that one is the user's to click.

On a first install it finishes by pointing at `manage show-password`. Do not run
that yet.

## Checkpoint 3: verify

```sh
# macOS
"$HOME/Library/Application Support/Dormouse Server/bin/manage" verify
```

```powershell
# Windows
& "$env:LOCALAPPDATA\Dormouse Server\bin\manage.cmd" verify
```

```sh
# Linux — the installer prints the exact path; this is the default when
# XDG_DATA_HOME is unset.
"$HOME/.local/share/dormouse-server/bin/manage" verify
```

Expect every check to pass and the command to exit 0. `manage status` gives the
same picture without the pass/fail framing.

Then, from another tailnet-connected device:

1. Request `https://<laptop>.<tailnet>.ts.net/api/hello`.
2. Open the Pocket application at the same origin.
3. Temporarily leave Tailscale on that device and confirm the origin becomes
   unreachable.

Kill the server process once and confirm the service manager restarts it:

```sh
# macOS — launchd restarts within a second or two
pkill -f 'Dormouse Server/current/server/dist/index.js'
"$HOME/Library/Application Support/Dormouse Server/bin/manage" status
```

```powershell
# Windows — run-server.ps1's supervision loop restarts after its 10s throttle,
# so wait ~15s before reading status.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*Dormouse Server*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
& "$env:LOCALAPPDATA\Dormouse Server\bin\manage.cmd" status
```

```sh
# Linux — Restart=always with RestartSec=10, so wait ~15s before reading status.
systemctl --user kill --signal=SIGKILL dormouse-server.service
"$HOME/.local/share/dormouse-server/bin/manage" status
```

On Linux, also prove the availability shape you chose. Without `--linger`, log
out fully and confirm the service is gone (`loginctl` shows no session and the
origin stops answering), then log back in and confirm it returns on its own.
With `--linger`, confirm the opposite: it keeps answering across a logout, and
`loginctl show-user $USER -p Linger` reports `yes`.

Restart the laptop only if the user approves the interruption; otherwise say
plainly that the run-at-load trigger plus the registered service has been
verified but the reboot test was skipped. After a real login or reboot, confirm
both the process and the background Serve mapping return without rerunning the
installer.

## Checkpoint 4: first-run setup

The server is running but has no account, no passkey, and no enrolled Host. The
same sequence is documented against the dev loop in `docs/specs/server.md`
→ "Running it"; here it runs against the tailnet origin instead of
`localhost:3000`, and the password comes from the installer rather than the
command line.

**The Host comes first**: a passkey is registered only off a code an enrolled
Host displays (`docs/specs/server.md` → Setup tokens and the pairing QR).

1. **The setup password.** Only needed if the offer card in step 2 is gone or
   the Host is elsewhere. Have the user run `manage show-password` in their own
   terminal when they are ready. It warns before printing. Do not ask for the
   value, and do not print it into the conversation.

2. **The Host.** On this same machine, launch the standalone or VS Code build
   made with `DORMOUSE_REMOTE_CONNECT_SRC` (see Prerequisites) and open
   **Settings → Remote control** — the sliders icon at the far right of the
   baseboard. Until its 24-hour limit or another Host enrollment, the offer
   card leads: origin found, name prefilled,
   one **Enroll**, no setup password. "Enroll with a different server…" unfolds
   the typed form, for a server elsewhere or an offer already spent
   (`docs/specs/server.md`, "Remote control, in the Settings dialog").

   Enrollment persists in the Host service's own store — a file under the
   app-data dir in standalone (mode `0600` on macOS and Linux; on Windows the
   mode is a no-op and the app-data ACL is what protects it), `SecretStorage` in
   VS Code — so later launches connect on their own. The section then shows the server, the relay
   connection, and the paired-device count.

   A build without the `*.ts.net` allowlist refuses this outright, before any
   credential leaves the machine, and both the card and the form render that
   refusal verbatim. That is the expected symptom of a stock build, not a server
   problem.

3. **The phone.** In **Settings → Remote control**, press **Set up a phone**
   for a pairing code. On the phone, open `https://<laptop>.<tailnet>.ts.net` in
   Safari; a browser that has never been here leads with **Scan a Host QR**.
   Scanning (or pasting) that code creates the passkey and signs them in — there
   is no password to type on the phone — bound to this exact origin. For push,
   add Pocket to the Home Screen *before* scanning and do all of this inside the
   installed app: iOS delivers Web Push only there, and the install is a
   separate storage partition that would otherwise need its own pairing
   (`docs/specs/pocket-app.md` → Installable web app, which also covers what
   happens if they reach for the phone's own camera instead).

4. **A real session.** The scan runs straight into pairing: read the two digits
   off the phone, type them into the modal on the laptop, then **Connect** (one
   biometric prompt) → pick a pane and type. Only now have HTTPS proxying, the
   WebSocket upgrade, and the security flow been exercised together.

5. **State.** Confirm `account.json`, `hosts.json`, and `vapid.json` now exist
   in `state/` (plus `push-subscriptions.json` if push was enabled). Record
   ownership and checksums without printing contents — checkpoint 5 checks them
   against a reinstall.

## Checkpoint 5: updating, rollback, uninstall

Updating is choosing a checkout and rerunning the same command:

```sh
git -C <checkout> log --oneline -1     # decide deliberately what to install
./deploy/local/install-macos.sh        # or .\deploy\local\install-windows.ps1
                                       # or ./deploy/local/install-linux.sh
```

Prove it once, while the user is watching:

1. Rerun the installer from the same or a newer checkout.
2. Confirm the release changed as expected and that the `state/` checksums from
   checkpoint 4 and `config/server.env` are unchanged.
3. Run `manage rollback`, confirm the previous release comes back healthy, then
   return to the desired release.

`manage uninstall` removes the service definition and installed code and keeps
`config` and `state`, reporting where they are. It also keeps `manage` itself,
which is what makes the second step possible. `manage purge` is the separate,
irreversible operation that deletes them; it requires typing a confirmation
phrase and is never part of a reinstall. Run them in that order — uninstall,
then purge — and purge finishes by printing the single command that clears
whatever is left: the install root, plus the log directory on Linux and macOS,
where it sits outside that root.

## Checkpoint 6: limits and backup

Make these explicit:

- The relay is down while the laptop sleeps, is shut down, Tailscale is
  disconnected, or the user is logged out.
- The installer does not follow `main`. Updates happen only when the user
  reruns it.
- The HTTPS origin is tied to the laptop's Tailscale node name. Renaming or
  re-enrolling that node means redoing the passkey and Host enrollment, and the
  installer will stop rather than rewrite the origin for you.
- Tailscale network policy still controls which tailnet members can reach the
  laptop. Review existing grants if the tailnet contains other users.

Confirm that the install root, especially `config` and `state`, is covered by an
encrypted backup outside the laptop — Time Machine on macOS, File History or any
equivalent on Windows, Déjà Dup/restic/borg or whatever the distro's tooling is
on Linux. Check the coverage rather than assuming it: on Windows,
`%LOCALAPPDATA%` is **excluded** from File History's default library set and
from OneDrive's Known Folder Move, and on Linux `~/.local/share` is routinely
excluded by dotfile-oriented backup rules, so on both the install root is very
likely unprotected until it is added explicitly. A second directory on the same
disk is not a backup. These files include Host bearer credentials
and a VAPID private key. Perform a small restore rehearsal without overwriting
live state.

## Final handoff

Give the user a concise final report. Include:

- The Pocket URL and its WebAuthn-origin significance.
- The exact installed Git SHA and whether the build was dirty.
- Where runtime config, state, release metadata, and logs live.
- The rollback command.
- Backup status and restore location.
- Any skipped acceptance test or remaining manual Host/Pocket setup.
- That updates happen only when the user reruns the installer for their
  platform, plus the sleep/shutdown/logout availability limitation.
- The installed `manage status`, `manage verify`, `manage logs`, and
  `manage restart` commands.

Do not print the setup password or any credential in the handoff.

## Official references

- Dormouse server runtime and state contract: `docs/specs/server.md`. What the
  installer guarantees is the
  [Installer contract](#installer-contract-maintainers) in this file.
- Dormouse trust model: `docs/specs/remote-security-model.md`
- Host installations: `docs/specs/standalone.md`, `docs/specs/vscode.md`
- [Install Tailscale on macOS](https://tailscale.com/docs/install/mac)
- [Tailscale variants on macOS](https://tailscale.com/docs/concepts/macos-variants)
- [Install Tailscale on Windows](https://tailscale.com/docs/install/windows)
- [Manage scripts with launchd](https://support.apple.com/guide/terminal/script-management-with-launchd-apdc6c1077b/mac)
- [Windows Task Scheduler](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page)
- [ScheduledTasks PowerShell module](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)

## Troubleshooting boundaries

- **The service works only while the source checkout exists:** the release is
  supposed to be self-contained, so this is a bug in the installer rather than
  something to work around with a permanent checkout path. `manage verify`
  checks for it directly.
- **The LaunchAgent loops or will not load:** run `plutil -lint` on the plist,
  inspect `launchctl print gui/$UID/sh.dormouse.server`, and read
  `~/Library/Logs/Dormouse Server`. launchd does not run the user's interactive
  shell startup files, so a `PATH` that works in Terminal proves nothing here.
- **The Scheduled Task loops or will not start:** read
  `Get-ScheduledTaskInfo -TaskName 'Dormouse Server'` for `LastTaskResult`,
  `Export-ScheduledTask -TaskName 'Dormouse Server'` for the definition, and
  `<install root>\logs`. `run-server.ps1` timestamps every start and exit into
  `server.err.log`, so a crash loop is visible as a run of those lines. Task
  Scheduler does not run the user's PowerShell profile, so a `PATH` that works
  interactively proves nothing here either.
- **The task shows `Ready` rather than `Running` after a reboot:** the trigger
  is at-logon with `LogonType=Interactive`, so it fires on interactive sign-in,
  not at boot. That is the same per-login limitation the LaunchAgent has, not a
  fault.
- **Every `tailscale` command returns `401 Unauthorized: Tailscale already in
  use by <user>` (Windows):** another signed-in Windows profile owns
  `tailscaled`'s local API. Have that user sign out or quit the Tailscale tray
  app; `quser` lists the sessions. Elevating does not bypass it.
- **`install-windows.ps1` refuses because the session is elevated:** run it from
  an ordinary PowerShell. This is deliberate — see Prerequisites.
- **The systemd user unit loops or will not start:** read
  `systemctl --user status dormouse-server.service`,
  `journalctl --user -u dormouse-server.service -n 50` for the unit's own view
  of each start, and `~/.local/state/dormouse-server/logs` for the server's
  output. The user manager does not run the user's shell startup files, so a
  `PATH` that works in a terminal proves nothing here either.
- **`systemctl --user` fails with a `DBUS_SESSION_BUS_ADDRESS` error (Linux):**
  there is no user manager for this uid — usually because the shell was reached
  with `su` rather than a real login. Use `machinectl shell $USER@` or a fresh
  SSH session. The installer refuses in preflight rather than installing a unit
  nothing will start.
- **`tailscale serve` is refused for a non-root user (Linux):** grant the
  operator role — see Prerequisites. The installer checks for this before
  building, so hitting it later means the check regressed. If you do hit it
  late, the release is already installed and the service already running: grant
  the role, then run `manage serve` to add the HTTPS front door rather than
  reinstalling.
- **The service disappears at logout (Linux):** that is the documented per-login
  default, not a fault. This is deliberate — see Prerequisites for the `--linger`
  opt-out, and make the availability change in checkpoint 6 explicit if you take
  it.
- **`/api/hello` answers but the unit is not active (Linux):** something else
  holds port 3100 and the install correctly refuses to claim it. `ss -lntp
  'sport = :3100'` names the process — unless it cannot see it, which is the
  case under WSL with `networkingMode=mirrored`, where loopback is shared with
  Windows and the listener may be a Windows process (a Windows Dormouse Server
  install on the same machine will do exactly this). Stop the other server, or
  install on a host that is not sharing loopback with one.
- **The HTTPS URL returns 502:** check the loopback health endpoint first, then
  `tailscale serve status`. The service and the Serve configuration have
  separate lifecycles; `manage serve` re-applies the mapping if a dev session
  repointed it.
- **Port 3100 is visible on the LAN or the Tailscale IP:** stop. Confirm
  `DORMOUSE_BIND_HOST=127.0.0.1` in `config/server.env`. Tailscale access
  control is not a reason to expose the plaintext backend.
- **The installer stops on an origin mismatch:** it is refusing to invalidate
  the registered passkey and every enrolled Host. Determine whether the
  Tailscale node was renamed or re-enrolled, then either restore the old node
  name or plan the re-enrollment explicitly.
- **Pocket loads but passkey setup fails:** compare the browser URL
  byte-for-byte with the `DORMOUSE_ORIGIN` in `config/server.env`; confirm HTTPS
  and the node hostname.
- **A Host cannot connect while Pocket can:** that Host build almost certainly
  lacks the `*.ts.net` `DORMOUSE_REMOTE_CONNECT_SRC` setting.
- **State disappears:** verify the absolute state path for this platform's
  install root and the installed config. Do not initialize a new account until
  the old state has been located or restored.

## Keeping the relay up while the laptop sleeps

A per-login agent is down whenever its machine is. That is usually fine, because
there is then no local Host to control either — but it stops being fine the
moment the user controls a Host that is *not* this laptop.

That case needs no new machinery. The relay does not have to run on the laptop:
the phone reaches the origin, and the Host dials *out* to it. So run the Linux
installer with `--linger` on any always-on tailnet machine — a spare box, a NUC,
a small VM — and that node's own MagicDNS name becomes the origin:

```sh
./deploy/local/install-linux.sh --linger
```

Lingering is what makes it survive logout and come back at boot; without it the
service is still per-login and nothing has changed. `manage verify` reports
which of the two modes is live.

Two things follow, and both are the same ones any origin change brings:

- **`DORMOUSE_ORIGIN` becomes that machine's name**, so the passkey and every
  Host enrollment are redone against it. The installers refuse to rewrite an
  origin rather than silently invalidating them, so this is a deliberate
  migration, not an upgrade path.
- **The Host still needs a build whose baked allowlist admits `*.ts.net`** — see
  Prerequisites. Nothing about that changes when the server moves.

The machine hosting the relay needs the same backup story as any other install
(checkpoint 6): `config/` and `state/` hold Host bearer credentials and a VAPID
private key.

A managed cloud deployment — a container, an image pipeline, a Tailscale Service
fronting it — would buy a stable origin independent of any one machine's name,
which is the one thing the above does not give. That belongs with the
multi-tenant work in `docs/specs/server.md` `## Future`, not with a single-user
install, and is not designed here.

## Installer contract (maintainers)

The runbook above is the operator half; this section is the *spec* for the
three installers — what they guarantee and the traps they encode. Source of
truth: `deploy/local/install-macos.sh`, `deploy/local/install-windows.ps1`,
`deploy/local/install-linux.sh` — one idempotent script per platform, the whole
mechanism there, with no hand-edited service definitions and no scheduled
updater. Running one again updates the installed release from the current
checkout; it never pulls, fetches, or switches branches.

The security properties this deployment is audited against are the
"Network posture (self-hosted)" and "Credentials at rest" `FAIL IF` lines in
`SECURITY.md`. Those lines bind **all three** installers — a control present in
one and absent from another is a finding — and `scripts/deploy-lint.mjs`
(`pnpm lint:deploy`, part of `pnpm test`) checks each one textually against
each installer, the only automated signal the Windows edition has, since
nothing in CI executes PowerShell. Its companion
`scripts/deploy-lint-selftest.mjs` deletes each matched control in turn and
requires the lint to fail, so a rule cannot be satisfied by prose about itself.

Each release is self-contained: the production server tree, `lib/dist-pocket`,
and a copy of the exact Node binary the build ran under, so the service depends
on neither the source checkout, nor Homebrew/nvm/a version manager, nor pnpm's
store, nor the user's interactive `PATH` — none of launchd, Task Scheduler, or
the systemd user manager reads any of those.

### Mechanism map

Service and install root are in the table at the top of this file; logs and
service-definition paths are under "What the installer does".

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| RunAtLoad | plist `RunAtLoad` | the at-logon trigger, `LogonType=Interactive`, `RunLevel=Limited` | `WantedBy=default.target` |
| KeepAlive | plist `KeepAlive` | the supervision loop in `bin\run-server.ps1`; Task Scheduler's `RestartCount` fires only on a *failed* exit, so it is defence in depth, not the mechanism | `Restart=always`, `RestartSec=10` |
| Stopping it | `launchctl bootout` takes the process tree | ends only the `powershell.exe`; its children survive and are reaped by install root (see the traps) | `systemctl --user stop` takes the whole cgroup |
| `current`/`previous` | symlinks, swapped with `rename(2)` on the link path | `current.txt`/`previous.txt` naming a release id, swapped with `rename(2)` on the file | symlinks, swapped with `rename(2)` on the link path |
| `0700` / `0600` | the modes, under `umask 077` | a DACL protected from inheritance carrying exactly one ACE, for the installing user | the modes, under `umask 077`; `verify` checks mode **and** owner |
| Entry | `/bin/bash bin/run-server` | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bin\run-server.ps1`, at an absolute interpreter path | `ExecStart=/bin/bash "<root>/bin/run-server"` |

Two rows are load-bearing Windows deviations, both because the macOS mechanism
has no unprivileged Windows equivalent. The release pointer is a **file**:
Windows has no unprivileged replaceable directory symlink (a junction cannot be
renamed over an existing junction, and delete-then-create leaves a window where
`current` names nothing), while a file swaps atomically with
`MoveFileEx(MOVEFILE_REPLACE_EXISTING)`; the switch still asserts afterwards
that the pointer advanced. And KeepAlive lives in the **wrapper**: Task
Scheduler restarts a task that *fails*, not one that exits 0, so
`run-server.ps1` is a supervision loop with the plist's own 10-second throttle,
and `manage verify` checks the loop is still present rather than trusting the
task settings. Linux needs neither workaround; its one deviation is that
**lingering is the availability knob, and it is opt-in** (`--linger`, see
Prerequisites): a user manager stops at logout exactly like a LaunchAgent, the
installer never changes that silently, and `manage verify` reports which mode
is live rather than asserting either.

### Invariants

- **One replica; an update is a short intentional restart.** Server transient
  state is in memory (`docs/specs/server.md` → Guardrails), so Hosts and Pocket
  clients reconnect across a release switch; there is no zero-downtime swap to
  attempt.
- **State outlives code.** `config/` and `state/` sit outside `releases/`, are
  readable only by the installing user, and are never touched by an update,
  prune, or uninstall; purging is a separate, explicitly confirmed operation.
  `config/server.env` is generated once with a setup password from the
  platform's CSPRNG — 32 bytes, i.e. **64 hex characters**, and a guard refuses
  anything shorter, counting characters rather than bytes so a regression to
  half the entropy cannot pass — and is preserved byte-for-byte thereafter.
  `manage verify` fails if the password ever appears in the service definition;
  it must live only in `server.env`. Windows applies the `server.env` DACL
  *before* writing the password (Linux: `chmod 0600` on the empty file first),
  so the secret never sits under the inherited `%LOCALAPPDATA%` ACL — and
  because Node's file modes are a no-op on Windows, `manage verify` walks the
  files in `state\` individually there, where the unix editions need not.
- **The enrollment offer rotates on every run before the first Host enrolls**,
  including updates that preserve `server.env`; `state/hosts.json` then disables
  it permanently until a state purge. Minted last after release, Serve, and
  pruning succeed, it leaves the previous offer unspent on failure.
  `run-server`
  exports `DORMOUSE_ENROLL_TOKEN_FILE`; unset, the server refuses every offer
  (`docs/specs/server.md` → Configuration). How the token is generated and
  protected: `SECURITY.md` → "Credentials at rest".
- **Loopback only, and tailnet-only.** The install pins
  `DORMOUSE_BIND_HOST=127.0.0.1` and refuses to proceed without it
  (`docs/specs/server.md` → Configuration on why the listen interface is a
  security boundary when the TLS proxy is local). Port 3100, deliberately not
  3000, so the installed service coexists with `pnpm dev:server` /
  `pnpm dev:pocket-server` on the same machine. `verify` also fails on an
  active `tailscale funnel`: Serve and Funnel are one configuration surface,
  and a Funnel publishes this origin — and the setup password behind it — to
  the public internet, which nothing in the threat model was sized for
  (`SECURITY.md` → "Network posture").
- **`DORMOUSE_ORIGIN` is durable WebAuthn identity.** Derived from the node's
  MagicDNS name. If an existing installation records a different origin the
  installer stops rather than rewriting it, because the rewrite silently
  invalidates the registered passkey and every enrolled Host.
- **The install belongs to one user account.** Every installer refuses to run
  privileged — root on macOS/Linux, elevated on Windows — because the whole
  credential posture is that one account owns `config/` and `state/`; an
  elevated run would write them owned by another principal and register the
  service for it. The property is checked from the other side too: on unix,
  "reachable only by the installing user" is mode **and** owner, since a `0700`
  directory owned by another principal satisfies the mode and inverts the
  property. Linux's `manage verify` asserts both legs on `config/`, `state/`,
  `run/` and `config/server.env`. *(macOS checks the modes only on all of them,
  and Windows' `Test-OwnerOnly` reads the DACL but never the owner — two known
  gaps, `SECURITY.md` → "Credentials at rest".)*
- **A failed update is a failure.** The candidate release is health-checked on
  an ephemeral port against a throwaway state dir *before* `current` moves; if
  the live service then fails to answer, `current` is restored to `previous`
  and the installer exits nonzero — rollback succeeding is not success. The
  restore also clears `previous` on every platform, because the switch had
  already aimed it at the release being restored; leaving both naming one
  release makes `verify` report a rollback target that does not exist and
  `rollback` swap a release with itself. On macOS and Linux that clear is gated
  on the restore having actually landed (`rollback_release` re-reads `current`
  and returns early otherwise): both call sites are `rollback_release || true`,
  which disables `errexit` for the whole function body, so without the gate a
  failed restore would strip the rollback pointer off an install still running
  the rejected release. Both also refuse the same-release state independently
  in `manage verify` / `manage rollback`, so an install left in it by an older
  installer reports honestly. The restore then confirms *which* release
  answered (next invariant); on Windows it reaps orphaned processes first (see
  the traps).
- **A 200 does not say who answered.** An orphan of an older release holding
  the loopback port answers `/api/hello` exactly like a healthy current one, so
  every check whose contract is *which release is running* proves the
  responder's identity rather than accepting a bare 200: the post-switch health
  check (rolls back and exits nonzero on a mismatch), the rollback restore,
  `manage verify`, and — because the identity is folded into the health *wait*
  — every command that waits for health (`manage rollback`, `manage restart`).
  Waiting on the identity also absorbs the window in which an outgoing process
  answers one last time. The server answers this itself: `run-server` passes
  `DORMOUSE_RUNTIME_FILE` and `DORMOUSE_RELEASE_ID`
  (`docs/specs/server.md` → Configuration) and the server records
  `{pid, releaseId, port, origin, startedAt}` there once it has **bound**, so
  `listening_release` (macOS, Linux) / `Get-ListeningRelease` (Windows) is a
  file read, a port match and a liveness check rather than a walk of the
  process table — which is also what took `ss` off Linux's critical path. It
  cannot go in `/api/hello`, which is unauthenticated, CORS-`*` and reachable
  through `tailscale serve`. Empty means **unknown**, never "nobody": a stale
  file whose pid is dead, a server started outside the installer, and a foreign
  port-holder are indistinguishable from the reader's side, and all must fail
  the comparison. A clean exit removes the file; a crash leaves it, which the
  liveness check reads correctly. Linux still leads with
  `systemctl --user is-active`, which catches a responder no port lookup can
  see at all — a foreign network namespace, or WSL with
  `networkingMode=mirrored`, where loopback is shared with the Windows host.
  Two known exceptions, stated so the invariant is not read as covering them:
  Windows `manage restart` still accepts a bare 200, and `manage status` on all
  three platforms reports what the pointers say by design. Source of truth:
  `server/src/runtime-file.ts`.

### Mechanical traps

Each fails silently unless encoded in the scripts:

- **`pnpm deploy --prod --legacy` poisons the workspace.** (All three.) It
  rewrites pnpm's workspace-state file to production mode. **Snapshot and
  restore that file on every exit**, including failed installs.
- **`mv -f tmp link` follows a symlink to a directory.** (macOS, Linux.) Used
  to swap `current`, it silently leaves the old release selected. **Use
  `rename(2)` on the link path and assert that `current` advanced.**
- **`pnpm` resolves to a `.ps1` before its `.CMD`.** (Windows.) The shim cannot
  be launched as a process, so the installer takes the first
  `Application`-typed resolution rather than `(Get-Command pnpm).Source`.
- **Redirecting a native command's stderr inline sets `$?` to false.**
  (Windows, PowerShell 5.1.) **Route control-flow commands through
  `Invoke-Native`**; only the candidate probe and `run-server.ps1` append
  redirector bypass it because `Start-Process` cannot express their setup.
- **Stopping a Scheduled Task does not reap its grandchildren.** (Windows.) The
  **Before every start, reap processes belonging to the install root by image
  path and command line, never image name**, and never accept a bare health 200.
  Source of truth: `Get-DormouseProcess` / `Get-ListeningRelease`.
- **Windows `tailscaled` serves its local API to one interactive session at a
  time.** (Windows.) On a PC with a second signed-in profile every `tailscale`
  call fails `401 Unauthorized: Tailscale already in use by <user>`. The
  installer matches that string in preflight and says which account holds it
  and what to do, rather than reporting the raw 401 as "is Tailscale signed
  in?".
- **Linux operator preflight must inspect the role, not a Serve read.**
  `tailscale serve status` can succeed when the invoking user may not write the
  config. Read `OperatorUser` from `tailscale debug prefs`; use `ControlURL` to
  distinguish a parsed-but-unset role from an unreadable response. A definitive
  absent/mismatched role is fatal and prints
  `sudo tailscale set --operator=$USER`; an unreadable response warns and
  degrades to the later Serve refusal. Test mode skips this unstable CLI probe.
  A late refusal reports the completed install as unserved and points to
  `manage serve`.
- **`systemctl --user` needs a real login session, not just a shell.** (Linux.)
  Under `su`, or wherever no user manager runs, it fails with a
  `DBUS_SESSION_BUS_ADDRESS` message that does not say what to do. Preflight
  checks `systemctl --user show-environment` and names the fix — log in
  properly, or `machinectl shell $USER@`.
- **`StandardOutput=append:` is systemd 240 or newer.** (Linux.) Older systemd
  truncates the log on every restart, so `manage logs` would quietly show only
  the current run. The installer parses `systemctl --version` and refuses below
  240 rather than installing a unit whose logging silently lies.

### Operator surface and test hooks

`bin/manage` (`bin\manage.ps1`, with a `manage.cmd` shim, on Windows) carries:
`status`, `verify` (runs every acceptance check and exits nonzero on any
failure), `logs`, `restart`, `show-password`, `serve` (re-apply the Serve
mapping after a dev session repointed it), `rollback`, `uninstall`, and the
separately-confirmed `purge`.

Teardown is two steps in that order, and `uninstall` has to leave `manage`
itself behind for the second one to be reachable at all: it removes the service
definition, the releases, the pointers, `run/` and `bin/run-server`, but not
the `bin` directory `manage` lives in — deleting that would strand `config/`
and `state/`, the data the message it prints tells you to run `purge` for.
`purge` deletes `state/`, `config/` and `run/` after its typed confirmation —
`run/` because an unspent offer redeems for a Host enrollment with no account in
existence, recreating the state just deleted — and, when
`bin/run-server` is already gone, closes by printing the one command that
removes what is left; it cannot delete itself out from under the shell running
it. That command names the dormouse-owned log directory alongside the install
root, because on Linux and macOS the logs live outside it — `LOG_ROOT`
(`$XDG_STATE_HOME/dormouse-server`) and `~/Library/Logs/Dormouse Server`
respectively, each named at the level dormouse owns so no empty directory
survives. On Windows `logs` is inside the root, so the root alone is enough.
Source of truth: `cmd_uninstall` / `cmd_purge` (`Invoke-Uninstall` /
`Invoke-Purge` on Windows) in the `manage` script each installer generates.

The installers carry two test-only hooks, each refused unless
`DORMOUSE_INSTALL_TEST=1`: `DORMOUSE_INSTALL_ROOT` puts the whole install under
a throwaway path, and — Linux only — `DORMOUSE_INSTALL_ORIGIN` supplies the
origin so Tailscale is never consulted. `.github/workflows/ci.yml` pins the
Linux install/update path in a temp root. Test mode stops before systemd and
Serve; macOS and Windows have no runtime CI coverage, so `deploy-lint` checks
all three installers textually.
