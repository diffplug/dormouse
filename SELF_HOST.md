# Run the Dormouse Relay behind Tailscale

> This is an assistant-run setup playbook. Start a fresh Claude instance in
> this repository and say: `read @SELF_HOST.md and walk me through it`.
>
> It is also the spec for `deploy/local/` — the
> [Installer contract](#installer-contract-maintainers) at the end is the
> maintainer half, and `scripts/spec-lint.mjs` checks this file with the specs.

Installs the Dormouse coordinating Relay on the user's own laptop — or, to
outlive its sleep, on an always-on tailnet box ("Keeping the relay up while the
laptop sleeps") — reachable only from their tailnet at
`https://<laptop>.<tailnet>.ts.net`. That is the whole self-host story today.
One idempotent installer per platform:

| OS | Installer | Service | Install root |
| --- | --- | --- | --- |
| macOS | `deploy/local/install-macos.sh` | LaunchAgent `sh.dormouse.relay` | `~/Library/Application Support/Dormouse Relay` |
| Windows | `deploy/local/install-windows.ps1` | Scheduled Task `\Dormouse Relay` | `%LOCALAPPDATA%\Dormouse Relay` |
| Linux | `deploy/local/install-linux.sh` | systemd user unit `dormouse-relay.service` | `~/.local/share/dormouse-relay` |

**Pick the column that applies before the first command and stay on it** —
mixing them is the main way this runbook goes wrong. Each checkpoint that
differs gives all three forms; the [Mechanism map](#mechanism-map) has the rest.

This runbook covers running the installer and finishing what it cannot — the
passkey, the Burrow build, the backup — with no code for anyone to write or edit.

## Instructions to the assistant

Guide the user one checkpoint at a time: do the command-line work you safely
can, pause for browser consent flows, secrets, and approval of external or
destructive changes, and **never dump the whole runbook back at the user**.

**Run the installer; never reimplement it** or paper over it with hand-run
`launchctl`, `schtasks`, `systemctl --user` or `tailscale serve`. Wrong behavior
is a bug in that platform's installer: say so plainly and offer to fix it as an
ordinary reviewed code change, a separate task. Its contract is the
[Installer contract](#installer-contract-maintainers) here; a change to one is a
change to both.

Before acting:

1. Read `docs/specs/relay.md` ("Configuration", "Where a Burrow may reach a Relay (self-host builds)"), `docs/specs/remote-security-model.md` for the
   trust model, and the [Installer contract](#installer-contract-maintainers).
2. Establish the OS and pick the installer column; run its `--help` / `-Help`,
   skim the script, and quote its errors rather than paraphrasing — they are
   written for whoever is standing here.
3. An install root that already exists means an update or a repair: read
   `manage status` before changing anything.
4. Recheck the linked documentation — updated 2026-08-27, and dashboards and CLI
   syntax change.
5. Explain the checkpoint, carry it out, verify it, then move on.
6. **Never ask the user to paste the setup password or any other bearer
   credential into chat.** The Relay generates it into owner-only state;
   `manage show-password` prints it in their terminal.
7. Never commit, push, merge, or delete installed state without first showing
   the exact change and obtaining approval.
8. For a relay that outlives this laptop's sleep, read "Keeping the relay up
   while the laptop sleeps" with the user rather than improvising cloud
   infrastructure.

Keep a worksheet, filled in as values become known: laptop OS; its Tailscale DNS
name (derived from `tailscale status --json`); external origin
(`https://<laptop-name>.<tailnet-dns-suffix>`); install root (the table above —
the installer prints the exact path, honoring `$XDG_DATA_HOME` on Linux) and its
`state/`; service; loopback port `3100`; lingering, on Linux only; and the
installed release, which the installer and `manage status` both print.

## Prerequisites

- **A tailnet** with MagicDNS and HTTPS certificates enabled, Tailscale running
  on this laptop and on the phone that will run Pocket. Whether the HTTPS origin
  stays private is a deployment choice, not a security premise
  (`docs/specs/security-remote.md` → "Network posture").
- **macOS, Windows or Linux.** Each installer refuses the others. On a fourth
  OS, or Linux without systemd, design the native service manager with the user
  rather than translating LaunchAgent, Scheduled Task or unit-file commands
  blindly.
- **No installer runs privileged** — root on macOS and Linux, elevated on
  Windows, all three refuse. Use an ordinary terminal
  ([Invariants](#invariants) → "The install belongs to one user account").
- **On Linux, this account must be allowed to operate `tailscaled`** — the local
  API socket is root-owned, so an unprivileged `tailscale serve` is refused.
  Preflight checks before the build and prints the fix, but never runs `sudo`;
  this is the only step of a Linux install needing root:

  ```sh
  sudo tailscale set --operator=$USER
  ```
- **On Linux, decide the availability shape before installing.** The default is
  per-login like macOS and Windows: up from login to logout. A machine reached
  over SSH, or serving with nobody logged in, needs `--linger`. Switching later
  is `loginctl enable-linger $USER` / `disable-linger`, not a reinstall.
- **On Windows, one signed-in user at a time owns Tailscale.** `tailscaled`
  serves its local API to a single interactive session, so a second signed-in
  profile fails every `tailscale` call with
  `401 Unauthorized: Tailscale already in use by <user>`; that user must sign
  out or quit the tray app. Preflight detects it and names the account.
- **A Burrow build that can reach a `*.ts.net` origin.** The shipped standalone
  and VS Code Burrows bake in the SaaS-only relay allowlist, so a self-host relay
  needs a local build of whichever Burrow the user runs:

  ```sh
  DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:standalone
  DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:vscode
  ```

  Both bake it into their Node Burrow bundles, and the relay socket is in neither
  webview, so no webview CSP change widens the allowlist
  (`docs/specs/relay.md` → "Where a Burrow may reach a Relay").

## What the installer does

It builds the exact current checkout into a self-contained release, registers a
per-login user agent restarted on exit ([Mechanism map](#mechanism-map)) running
the Relay on `127.0.0.1:3100`, and points `tailscale serve --bg` at it to
terminate private HTTPS. Only under the current user's profile, with no
administrator rights:

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
    vapid.json
```

Logs: `~/Library/Logs/Dormouse Relay/` on macOS, `<install root>\logs` on
Windows, `~/.local/state/dormouse-relay/logs` on Linux. Service definition:
`~/Library/LaunchAgents/sh.dormouse.relay.plist`, the Scheduled Task
`\Dormouse Relay`, or `~/.config/systemd/user/dormouse-relay.service`.

Before the first Burrow enrollment, `run/enroll-offer.json` holds the origin and a
token that `POST /api/burrow/enroll` accepts in place of the setup password, and a
Dormouse Burrow on this machine offers one-click enrollment from it (checkpoint 4,
step 2). It expires after 24 hours; either credential path's first Burrow
enrollment removes it, and no later run recreates it.

No installer will **ever**: run `git pull`, fetch, or switch branches; install a
scheduled updater; ask for elevation; install or re-authenticate Tailscale;
rewrite an origin that no longer matches the node's DNS name; or touch `config/`
and `state/`, which survive every update, prune, and uninstall.

Two [Invariants](#invariants) set day-to-day expectations. **An update is a
short intentional restart**: Burrow and Pocket WebSockets disconnect and
reconnect. **A per-login agent is unavailable while the laptop sleeps, is shut
down, or has no logged-in user** — normally fine, since there is then no local
Dormouse Burrow to control either. Windows' at-logon `LogonType=Interactive` is
what keeps the task free of a stored password; Linux alone opts out, with
`--linger` (Prerequisites).

## Definition of done

`manage verify` checks all of these locally and exits nonzero on any failure:

- **The service is registered and running, declares the run-at-load and
  restart-on-exit of the [Mechanism map](#mechanism-map), and carries no
  credential** — a definition it cannot read at all fails rather than passes.
  Plus what only the live system shows: macOS, loaded in `gui/$UID` with a plist
  that lints; Windows, task `Running`, no execution time limit, restarts on
  failure, unelevated, unstopped by battery or idle, `bin\run-relay.ps1` still
  carrying the supervision loop; Linux, unit known to the user manager,
  `enabled`, passing `systemd-analyze --user verify`.
- **Loopback `/api/hello` responds, the Pocket app is served, and the process
  holding the port belongs to the current release** ([Invariants](#invariants) →
  "A 200 does not say who answered"); Linux additionally requires
  `systemctl --user is-active`.
- **Port 3100 is bound only to `127.0.0.1`**, and the plaintext port is
  unreachable on the laptop's Tailscale IP.
- **`tailscale serve` proxies `/` to `127.0.0.1:3100` at the origin recorded in
  `config/relay.env`.** Funnel may be on or off; verification does not treat
  public HTTPS reachability as a defect.
- **`config/`, `state/`, `run/` and `config/relay.env` are readable only by the
  installing user**, by the per-platform means in the
  [Mechanism map](#mechanism-map) and [Invariants](#invariants).
  `run/enroll-offer.json` is held to the same standard while it is there; a
  spent offer is gone, and `verify` says so rather than failing.
- **The current release pointer resolves to a release with `RELEASE`
  metadata**, and neither the service definition nor the `run-relay` wrapper
  refers to the source checkout. The previous-release pointer is checked too:
  absent on a first install warns, naming the same release as `current` fails.

These cannot be proven from the laptop, and are the checkpoints below: the HTTPS
origin answering from a second tailnet device and stopping when that device
leaves the tailnet; the service manager restarting the Relay after a real kill;
state surviving a reinstall from a newer checkout, with rollback returning the
previous release; Pocket passkey setup and Burrow enrollment completing against
this origin, and one command typed from the phone coming back with the laptop's
own output; and the install root backed up somewhere off this laptop.

## Checkpoint 1: preflight

The installer preflights and stops with a specific error, so do not re-run these
by hand: OS and unprivileged session; the Tailscale CLI (on `PATH`, in the macOS
app bundle invoked with `TAILSCALE_BE_CLI=1`, or under
`Program Files\Tailscale` on Windows); backend state `Running`; the node's
MagicDNS name and derived origin; tailnet HTTPS certificates; an origin
disagreeing with an existing installation; the Git SHA and dirty status (it asks
before installing a dirty worktree); and the Node and pnpm versions pinned in
root `package.json`. Windows also names the account holding `tailscaled`'s local
API; Linux also checks a reachable systemd user manager, systemd 240 or newer,
and that this account may operate `tailscaled` — that one before the build,
since the refusal would otherwise surface only at Serve, after `current` had
moved.

Establish with the user what the script cannot:

- **This checkout is the one they want installed.** Show `git status --short`,
  the branch, and the SHA. Never pull or switch branches on their behalf; the
  installer installs exactly what is checked out.
- **Their phone runs Tailscale** and is signed in to the same tailnet.
- **Port 3100 is free.** Unchecked by the installer, and a stale process there
  would let the post-install health check pass against the wrong Relay
  (`pnpm dev:relay` uses 3000):

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

It prints each step; read that with the user rather than summarizing. Its
confirmations — a dirty worktree, a mismatched pnpm, repointing an
already-claimed Serve root path — are decisions, and it refuses to assume an
answer with no terminal. Tailscale may open a browser consent flow the first
time Serve requests a certificate; that one is the user's to click. A first
install ends by pointing at `manage show-password`; do not run that yet.

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

Expect every check to pass and the command to exit 0. `manage status` gives the
same picture without the pass/fail framing.

Then, from another tailnet-connected device: request
`https://<laptop>.<tailnet>.ts.net/api/hello`, open the Pocket application at
the same origin, then temporarily leave Tailscale on that device and confirm the
origin becomes unreachable.

Kill the Relay process once and confirm the service manager restarts it:

```sh
# macOS — launchd restarts within a second or two
pkill -f 'Dormouse Relay/current/relay/dist/index.js'
"$HOME/Library/Application Support/Dormouse Relay/bin/manage" status
```

```powershell
# Windows — run-relay.ps1's supervision loop restarts after its 10s throttle,
# so wait ~15s before reading status.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*Dormouse Relay*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
& "$env:LOCALAPPDATA\Dormouse Relay\bin\manage.cmd" status
```

```sh
# Linux — Restart=always with RestartSec=10, so wait ~15s before reading status.
systemctl --user kill --signal=SIGKILL dormouse-relay.service
"$HOME/.local/share/dormouse-relay/bin/manage" status
```

On Linux, also prove the availability shape you chose. Without `--linger`: log
out fully, confirm the service is gone (`loginctl` shows no session and the
origin stops answering), then log back in and confirm it returns on its own.
With `--linger`: it keeps answering across a logout, and
`loginctl show-user $USER -p Linger` reports `yes`.

Restart the laptop only with the user's approval; otherwise say plainly that the
run-at-load trigger and registered service were verified but the reboot test
skipped. After a real login or reboot, confirm the process and the background
Serve mapping both return without rerunning the installer.

## Checkpoint 4: first-run setup

The Relay has no account, no passkey, and no enrolled Burrow. Same sequence as
`docs/specs/relay.md` → "Running it", run against the tailnet origin, with the
Relay's generated password.

**The Burrow comes first**: a passkey is registered only off a code an enrolled
Burrow displays (`docs/specs/relay.md` → Setup tokens and the pairing QR).

1. **The setup password.** Needed only if the step-2 offer card is gone or the
   Burrow is elsewhere: have the user run `manage show-password` in their own
   terminal, which warns before printing. Never ask for the value, and never
   print it into the conversation.

2. **The Burrow.** On this same machine, launch the standalone or VS Code build
   made with `DORMOUSE_REMOTE_CONNECT_SRC` (Prerequisites) and open
   **Settings → Remote control** — the sliders icon at the far right of the
   baseboard. While the offer is unspent, its card enrolls in one click with no
   setup password; the typed form behind "Enroll with a different Relay…"
   covers a Relay elsewhere or a spent offer (`docs/specs/relay.md`, "Remote
   control, in the Settings dialog"). Enrollment persists in the Burrow service's
   own store (`docs/specs/security-remote.md` → "Credentials at rest"), so later launches connect
   on their own; the section then shows the Relay, the relay connection and the
   paired-device count.

   A build without the `*.ts.net` allowlist refuses outright, before any
   credential leaves the machine, and both card and form render that refusal
   verbatim: the expected symptom of a stock build, not a Relay problem.

3. **The phone, and only then the code.** On the phone, open
   `https://<laptop>.<tailnet>.ts.net` in Safari and confirm it leads with
   **Scan a setup code**. For push, add Pocket to the Home Screen and pair
   inside the installed app (`docs/specs/pocket-app.md` → Installable web app
   owns why, and covers the phone's camera). **A setup code is
   live for five minutes**, so that first load — bundle, service worker, Home
   Screen install — must not happen inside the window. With the phone waiting on
   that screen, press **Set up a phone** in **Settings → Remote control**;
   scanning or pasting the code creates the passkey and signs them in, bound to
   this exact origin, with no password typed on the phone.

4. **A real session.** The scan runs straight into pairing: read the two digits
   off the phone, type them into the modal on the laptop, and **approve — the
   last thing anyone does**. The phone answers its own biometric prompt and
   lands on the machine's terminal. (**Connect**, on the Burrows row, is for later
   sessions.) Only now have HTTPS proxying, the WebSocket upgrade, and the
   security flow been exercised together.

5. **State.** Confirm `account.json`, `burrows.json` and `vapid.json` — plus
   `push-subscriptions.json` if push was enabled — now exist in `state/`. Record
   ownership and checksums without printing contents; checkpoint 5 checks them
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
   checkpoint 4 and `config/relay.env` are unchanged.
3. Run `manage rollback`, confirm the previous release comes back healthy, then
   return to the desired release.

`manage uninstall` removes the service definition and installed code, keeps
`config` and `state` and reports where they are, and keeps `manage` itself —
which is what makes step 3 possible. `manage purge` is the separate,
irreversible deletion, behind a typed confirmation phrase and never part of a
reinstall. Run them in that order; purge finishes by printing the single command
that clears whatever is left: the install root, plus the log directory on Linux
and macOS, where it sits outside that root.

## Checkpoint 6: limits and backup

Make these explicit: the relay is down while the laptop sleeps, is shut down,
has Tailscale disconnected, or is logged out; the installer does not follow
`main`, so updates happen only when the user reruns it; the HTTPS origin is tied
to the laptop's Tailscale node name, so renaming or re-enrolling that node means
redoing the passkey and every Burrow enrollment, and the installer stops rather
than rewriting the origin; and Tailscale network policy still controls which
tailnet members reach the laptop — review existing grants if the tailnet has
other users.

Confirm the install root, especially `config` and `state`, is covered by an
encrypted backup off the laptop — Time Machine, File History,
Déjà Dup/restic/borg. **Check the coverage rather than assuming it**:
`%LOCALAPPDATA%` is excluded from File History's default library set and from
OneDrive's Known Folder Move, and `~/.local/share` from dotfile-oriented backup
rules, so on both the install root is very likely unprotected until added
explicitly. A second directory on the same disk is not a backup; these files
hold Burrow bearer credentials and a VAPID private key. Rehearse a small restore
without overwriting live state.

## Final handoff

Report concisely: the Pocket URL and its WebAuthn-origin significance; the exact
installed Git SHA and whether the build was dirty; where runtime config, state,
release metadata and logs live; the rollback command; backup status and restore
location; any skipped acceptance test or remaining manual Burrow/Pocket setup;
that updates happen only when the user reruns the installer for their platform,
plus the sleep/shutdown/logout availability limit; and the installed
`manage status`, `manage verify`, `manage logs` and `manage restart` commands.

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

None of the three service managers runs the user's interactive shell or
PowerShell startup files, so a `PATH` that works in a terminal proves nothing
about any of them.

- **The service works only while the source checkout exists:** an installer bug
  — the release must be self-contained — not a reason to keep the checkout
  around. `manage verify` checks it directly.
- **The service loops or will not start:** macOS — `plutil -lint` the plist,
  `launchctl print gui/$UID/sh.dormouse.relay`, and
  `~/Library/Logs/Dormouse Relay`. Windows —
  `Get-ScheduledTaskInfo -TaskName 'Dormouse Relay'` for `LastTaskResult`,
  `Export-ScheduledTask -TaskName 'Dormouse Relay'` for the definition, and
  `<install root>\logs`, where `run-relay.ps1` timestamps each start and exit
  into `relay.err.log` (a crash loop is a run of those lines). Linux —
  `systemctl --user status dormouse-relay.service`,
  `journalctl --user -u dormouse-relay.service -n 50`, and
  `~/.local/state/dormouse-relay/logs`.
- **The task shows `Ready` rather than `Running` after a reboot:** the at-logon
  `LogonType=Interactive` trigger fires on interactive sign-in, not at boot —
  the LaunchAgent's per-login limitation, not a fault.
- **Every `tailscale` call returns `401 Unauthorized: Tailscale already in use
  by <user>` (Windows):** another signed-in profile owns `tailscaled`'s local
  API (Prerequisites); `quser` lists the sessions, and elevating does not bypass
  it.
- **`install-windows.ps1` refuses because the session is elevated:** use an
  ordinary PowerShell (Prerequisites).
- **`systemctl --user` fails with `DBUS_SESSION_BUS_ADDRESS` (Linux):** no user
  manager for this uid, usually a shell reached with `su`. Use
  `machinectl shell $USER@` or a fresh SSH session; preflight refuses rather
  than installing a unit nothing will start.
- **`tailscale serve` is refused for a non-root user (Linux):** grant the
  operator role (Prerequisites). Preflight checks it before building, so a late
  hit means the check regressed — and since the release is already installed and
  running, finish with `manage serve` rather than reinstalling.
- **The service disappears at logout (Linux):** the documented per-login
  default, not a fault — `--linger` is the opt-out (Prerequisites); make the
  availability change explicit in checkpoint 6 if you take it.
- **`/api/hello` answers but the unit is not active (Linux):** something else
  holds port 3100 and the install correctly refuses to claim it.
  `ss -lntp 'sport = :3100'` names that process — unless it cannot see it, as
  under WSL with `networkingMode=mirrored`, where the listener may be a Windows
  process (a Windows Dormouse Relay install does exactly this). Stop it, or
  install on a burrow not sharing loopback.
- **The HTTPS URL returns 502:** check the loopback health endpoint first, then
  `tailscale serve status`; service and Serve configuration have separate
  lifecycles, and `manage serve` re-applies a mapping a dev session repointed.
- **Port 3100 is visible on the LAN or the Tailscale IP:** stop. Confirm
  `DORMOUSE_BIND_HOST=127.0.0.1` in `config/relay.env`. Tailscale access
  control is not a reason to expose the plaintext backend.
- **The installer stops on an origin mismatch:** it is refusing to invalidate
  the registered passkey and every enrolled Burrow. Establish whether the node was
  renamed or re-enrolled, then restore the old name or plan the re-enrollment.
- **Pocket loads but passkey setup fails:** compare the browser URL
  byte-for-byte with `DORMOUSE_ORIGIN` in `config/relay.env`; confirm HTTPS and
  the node hostname.
- **A Burrow cannot connect while Pocket can:** that Burrow build almost certainly
  lacks the `*.ts.net` `DORMOUSE_REMOTE_CONNECT_SRC` setting.
- **State disappears:** verify the absolute state path for this platform's
  install root and the installed config. Never initialize a new account until
  the old state is located or restored.

## Keeping the relay up while the laptop sleeps

A per-login agent is down whenever its machine is — fine until the user controls
a Burrow that is *not* this laptop.

That needs no new machinery: the phone reaches the origin and the Burrow dials
*out* to it, so the relay need not run on the laptop. Run the Linux installer
with `--linger` on any always-on tailnet machine — a spare box, a NUC, a small
VM — and that node's own MagicDNS name becomes the origin:

```sh
./deploy/local/install-linux.sh --linger
```

Lingering is what makes it survive logout and come back at boot
(Prerequisites); `manage verify` reports which mode is live. Two things follow,
both the same ones any origin change brings: **`DORMOUSE_ORIGIN` becomes that
machine's name**, so the passkey and every Burrow enrollment are redone against it
— a deliberate migration, not an upgrade path, which is why the installers
refuse to rewrite an origin; and **the Burrow still needs a build whose baked
allowlist admits `*.ts.net`** (Prerequisites). That machine needs the same
backup story as any other install (checkpoint 6): `config/` and `state/` hold
Burrow bearer credentials and a VAPID private key.

A managed cloud deployment would buy a stable origin independent of any one
machine's name — the one thing the above does not give — and belongs with the
multi-tenant work in `docs/specs/relay.md` `## Future`, not with a single-user
install.

## Installer contract (maintainers)

The runbook above is the operator half; this section is the *spec* for the three
installers — what they guarantee and the traps they encode. One idempotent
script per platform, the whole mechanism there, with no hand-edited service
definitions and no scheduled updater; rerunning one updates the installed
release from the current checkout and never pulls, fetches, or switches
branches.

The security properties this deployment is audited against are the "Network
posture (self-hosted)" and "Credentials at rest" `FAIL IF` lines in
`docs/specs/security-remote.md`. **Those lines bind all three installers** — a control present in
one and absent from another is a finding — and `scripts/deploy-lint.mjs`
(`pnpm lint:deploy`, part of `pnpm test`) checks each one textually against each
installer, with `scripts/deploy-lint-selftest.mjs` deleting each matched control
in turn to keep that honest. On Windows, which nothing in CI executes, the lint
is the only automated signal at all.

**Each release is self-contained**: the production Relay tree,
`lib/dist-pocket`, and a copy of the exact Node binary the build ran under, so
the service depends on neither the source checkout, nor Homebrew/nvm/a version
manager, nor pnpm's store, nor the user's interactive `PATH` — none of launchd,
Task Scheduler, or the systemd user manager reads any of those.

Source of truth: `deploy/local/install-macos.sh`,
`deploy/local/install-windows.ps1`, `deploy/local/install-linux.sh`.

### Mechanism map

Service and install root are in the table at the top of this file; logs and
service-definition paths are under "What the installer does".

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| RunAtLoad | plist `RunAtLoad` | the at-logon trigger, `LogonType=Interactive`, `RunLevel=Limited` | `WantedBy=default.target` |
| KeepAlive | plist `KeepAlive` | the supervision loop in `bin\run-relay.ps1`; Task Scheduler's `RestartCount` is defence in depth, not the mechanism | `Restart=always`, `RestartSec=10` |
| Stopping it | `launchctl bootout` takes the process tree | ends only the `powershell.exe`; its children survive and are reaped by install root (see the traps) | `systemctl --user stop` takes the whole cgroup |
| `current`/`previous` | symlinks, swapped with `rename(2)` on the link path | `current.txt`/`previous.txt` naming a release id, swapped with `rename(2)` on the file | symlinks, swapped with `rename(2)` on the link path |
| `0700` / `0600` | the modes, under `umask 077` | a DACL protected from inheritance carrying exactly one ACE, for the installing user | the modes, under `umask 077`; `verify` checks mode **and** owner |
| Entry | `/bin/bash bin/run-relay` | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bin\run-relay.ps1`, at an absolute interpreter path | `ExecStart=/bin/bash "<root>/bin/run-relay"` |

Two rows are load-bearing Windows deviations, both because the macOS mechanism
has no unprivileged Windows equivalent. **The release pointer is a file**: no
unprivileged replaceable directory symlink exists (a junction cannot be renamed
over a junction, and delete-then-create leaves `current` naming nothing), while
a file swaps atomically with `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`; the switch
still asserts the pointer advanced. **KeepAlive lives in the wrapper**: Task
Scheduler restarts a task that *fails*, not one that exits 0, so
`run-relay.ps1` is a supervision loop with the plist's own 10-second throttle,
and `manage verify` checks that loop is present rather than trusting task
settings. Linux's one deviation: **lingering is the availability knob, and it is
opt-in** (`--linger`, Prerequisites) — a user manager stops at logout like a
LaunchAgent, the installer never changes that silently, and `manage verify`
reports which mode is live rather than asserting either.

### Invariants

- **One replica; an update is a short intentional restart.** Relay transient
  state is in memory (`docs/specs/relay.md` → Guardrails), so Burrows and Pocket
  clients reconnect across a release switch; no zero-downtime swap to attempt.
- **State outlives code.** `config/` and `state/` sit outside `releases/`, are
  readable only by the installing user, and survive every update, prune and
  uninstall; purging is separate and explicitly confirmed. The Relay generates
  `state/setup-password.json` once from 32 CSPRNG bytes, validates it on every
  boot, and never accepts an operator-supplied setup credential.
  `config/relay.env` is generated once, then preserved byte-for-byte.
  **A preserved file missing installer-owned keys is half-written**: name them
  and stop, never rewrite values that cannot be proven stale. **`manage verify`
  walks every file in `state\` on Windows**, where Node's modes are a no-op.
- **The enrollment offer rotates on every run before the first Burrow enrolls**,
  including updates that preserve `relay.env`; `state/burrows.json` then disables
  it permanently until a state purge. **Minted last** — after release, Serve and
  pruning succeed — so a failure leaves the previous offer unspent.
  `run-relay` exports `DORMOUSE_ENROLL_TOKEN_FILE`; unset, the Relay refuses
  every offer (`docs/specs/relay.md` → Configuration). Generation and
  protection: `docs/specs/security-remote.md` → "Credentials at rest".
- **Loopback backend, publicly safe HTTPS origin.** The install pins
  `DORMOUSE_BIND_HOST=127.0.0.1` and refuses to proceed without it
  (`docs/specs/relay.md` → Configuration). Port 3100, not 3000, so the service
  coexists with `pnpm dev:relay`. Serve is the private default; Funnel is safe
  to enable because the application controls, not network privacy, govern
  admission (`docs/specs/security-remote.md` → "Network posture").
- **`DORMOUSE_ORIGIN` is durable WebAuthn identity**, derived from the node's
  MagicDNS name. An installation recording a different origin stops the
  installer, because rewriting silently invalidates the registered passkey and
  every enrolled Burrow.
- **The install belongs to one user account.** Every installer refuses to run
  privileged — root on macOS/Linux, elevated on Windows — because that account
  owning `config/` and `state/` is the whole credential posture. **On unix the
  property is mode *and* owner**, since a `0700` directory owned by another
  principal satisfies the mode and inverts it; Linux's `manage verify` asserts
  both legs on `config/`, `state/`, `run/` and `config/relay.env`. *(macOS
  checks the modes only, Windows' `Test-OwnerOnly` the DACL but never the owner
  — two known gaps, `docs/specs/security-remote.md` → "Credentials at rest".)*
- **A failed update is a failure.** The candidate release is health-checked on
  an ephemeral port against a throwaway state dir *before* `current` moves; if
  the live service then fails to answer, `current` is restored to `previous` and
  the installer exits nonzero — rollback succeeding is not success. **The
  restore also clears `previous`** on every platform, which the switch had aimed
  at the release being restored: both pointers on one release would make
  `verify` report a rollback target that does not exist and `rollback` swap a
  release with itself, and both commands refuse that state independently. **On
  macOS and Linux the clear is gated on the restore having landed**
  (`rollback_release` re-reads `current`; its `|| true` call sites disable
  `errexit`), so a failed restore
  cannot strip the rollback pointer off an install still running the rejected
  release. The restore then confirms *which* release answered (next invariant);
  on Windows it reaps orphaned processes first (see the traps).
- **A 200 does not say who answered.** An orphan of an older release holding the
  loopback port answers `/api/hello` exactly like a healthy current one, so
  **every check whose contract is *which release is running* proves the
  responder's identity**: the post-switch health check (rolls back and exits
  nonzero on a mismatch), the rollback restore, `manage verify`, and — identity
  being folded into the health *wait* — every command that waits for health
  (`manage rollback`, `manage restart`), which also absorbs the window where an
  outgoing process answers one last time. `run-relay` passes
  `DORMOUSE_RUNTIME_FILE` and `DORMOUSE_RELEASE_ID` (`docs/specs/relay.md` →
  Configuration); the Relay records `{pid, releaseId, port, origin, startedAt}`
  there once **bound**, so `listening_release` (macOS, Linux) /
  `Get-ListeningRelease` (Windows) is a file read, a port match and a liveness
  check. **It cannot go in `/api/hello`**, which is unauthenticated and reachable
  through the HTTPS proxy. **Empty means unknown, never
  "nobody"** — a stale file with a dead pid, a Relay started outside the
  installer, and a foreign port-holder all fail the comparison. A clean exit
  removes the file; a crash leaves it, which the liveness check reads correctly.
  **Linux still leads with `systemctl --user is-active`**, which catches a
  responder no port lookup can see: a foreign network namespace, or WSL with
  `networkingMode=mirrored`, where loopback is shared with the Windows burrow.
  Two known exceptions: Windows `manage restart` still accepts a bare 200, and
  `manage status` on all three reports what the pointers say by design.
  Source of truth: `relay/src/runtime-file.ts`.

### Mechanical traps

Each fails silently unless encoded in the scripts:

- **`pnpm deploy --prod --legacy` poisons the workspace.** (All three.) It
  rewrites pnpm's workspace-state file to production mode. **Snapshot and
  restore that file on every exit**, including failed installs.
- **`mv -f tmp link` follows a symlink to a directory.** (macOS, Linux.) Used
  to swap `current`, it silently leaves the old release selected. **Use
  `rename(2)` on the link path and assert that `current` advanced.**
- **`pnpm` resolves to a `.ps1` before its `.CMD`.** (Windows.) The shim cannot
  be launched as a process, so **take the first `Application`-typed resolution**,
  not `(Get-Command pnpm).Source`.
- **Redirecting a native command's stderr inline sets `$?` to false.**
  (Windows, PowerShell 5.1.) **Route control-flow commands through
  `Invoke-Native`**; only the candidate probe and `run-relay.ps1` append
  redirector bypass it, because `Start-Process` cannot express their setup.
- **Stopping a Scheduled Task does not reap its grandchildren.** (Windows.)
  **Before every start, reap processes belonging to the install root by image
  path and command line, never image name**, and never accept a bare health 200.
  Source of truth: `Get-DormouseProcess` / `Get-ListeningRelease` in `deploy/local/install-windows.ps1`.
- **Windows `tailscaled` serves its local API to one interactive session at a
  time.** Preflight must match the
  `401 Unauthorized: Tailscale already in use by <user>` string and name the
  account holding it, not report the raw 401 as "is Tailscale signed in?".
- **Linux operator preflight must inspect the role, not a Serve read**, since
  `tailscale serve status` can succeed when the invoking user may not write the
  config. Read `OperatorUser` from `tailscale debug prefs`, using `ControlURL`
  to tell a parsed-but-unset role from an unreadable response: an absent or
  mismatched role is fatal and prints `sudo tailscale set --operator=$USER`,
  while an unreadable one warns and degrades to the later Serve refusal, which
  reports the install as unserved and points at `manage serve`. Test mode skips
  this unstable CLI probe.
- **`systemctl --user` needs a real login session, not just a shell.** (Linux.)
  Under `su`, or wherever no user manager runs, its `DBUS_SESSION_BUS_ADDRESS`
  failure does not say what to do, so preflight checks
  `systemctl --user show-environment` and names the fix — log in properly, or
  `machinectl shell $USER@`.
- **`StandardOutput=append:` is systemd 240 or newer.** (Linux.) Older systemd
  truncates the log on every restart, so `manage logs` would show only the
  current run. Parse `systemctl --version` and refuse below 240 rather than
  installing a unit whose logging silently lies.

### Operator surface and test hooks

`bin/manage` (`bin\manage.ps1`, with a `manage.cmd` shim, on Windows) carries:
`status`, `verify` (runs every acceptance check and exits nonzero on any
failure), `logs`, `restart`, `show-password`, `serve` (re-apply the Serve
mapping after a dev session repointed it), `rollback`, `uninstall`, and the
separately-confirmed `purge`.

**Teardown is two steps in that order, and `uninstall` must leave `manage`
behind** for the second to be reachable: it removes the service definition, the
releases, the pointers, `run/` and `bin/run-relay`, but not the `bin` directory
`manage` lives in — deleting that strands `config/` and `state/`, the data its
own message tells you to `purge`. **`purge` deletes `state/`, `config/` and
`run/`** after its typed confirmation — `run/` because an unspent offer redeems
for a Burrow enrollment with no account in existence — and, once `bin/run-relay`
is gone, prints the one command that removes what is left, since it cannot
delete itself from under the running shell. That command names the
dormouse-owned log directory alongside the install root, because on Linux and
macOS the logs live outside it — `LOG_ROOT` (`$XDG_STATE_HOME/dormouse-relay`)
and `~/Library/Logs/Dormouse Relay`, each named at the level dormouse owns so
no empty directory survives; on Windows `logs` is inside the root. Source of
truth: `cmd_uninstall` / `cmd_purge` (`Invoke-Uninstall` / `Invoke-Purge` on
Windows) in the generated `manage` script.

Two test-only hooks, each refused unless `DORMOUSE_INSTALL_TEST=1`:
`DORMOUSE_INSTALL_ROOT` puts the whole install under a throwaway path, and —
Linux only — `DORMOUSE_INSTALL_ORIGIN` supplies the origin so Tailscale is never
consulted. `.github/workflows/ci.yml` pins the Linux install/update path in a
temp root. Test mode stops before systemd and Serve; macOS and Windows have no
runtime CI coverage, so `deploy-lint` checks all three installers textually.
