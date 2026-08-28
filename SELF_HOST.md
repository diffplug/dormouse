# Run the Dormouse server behind Tailscale

> This is an assistant-run setup playbook. Start a fresh Claude instance in
> this repository and say: `read @SELF_HOST.md and walk me through it`.

This installs the Dormouse coordinating server on the user's own laptop,
reachable only from their tailnet at `https://<laptop>.<tailnet>.ts.net`. That
is the whole self-host story today. An always-on cloud relay is designed but not
built; it lives under `## Future`.

The installer already exists — one idempotent command that ships in this
repository, in a macOS and a Windows edition:

| OS | Installer | Service | Install root |
| --- | --- | --- | --- |
| macOS | `deploy/local/install-macos.sh` | LaunchAgent `sh.dormouse.server` | `~/Library/Application Support/Dormouse Server` |
| Windows | `deploy/local/install-windows.ps1` | Scheduled Task `\Dormouse Server` | `%LOCALAPPDATA%\Dormouse Server` |

The two hold the same invariants through different native mechanisms; where a
checkpoint below differs, both forms are given. **Work out which one applies
before the first command and stay on that column** — mixing them is the main way
this runbook goes wrong. `docs/specs/server.md` -> "Installing it (behind
Tailscale)" carries the full mechanism-by-mechanism table.

This runbook is about running the installer and finishing the parts it cannot do
on its own — the passkey, the Host build, the backup. Nobody following it should
have to write or edit code.

## Instructions to the assistant

Your job is to guide the user through this runbook one checkpoint at a time,
performing the command-line work you safely can and pausing only for browser
consent flows, secrets, or explicit approval of external or destructive
changes. Do not dump the entire runbook back at the user.

The installer is shipped, reviewed code. Run it — do not reimplement it, and do
not paper over it with hand-run `launchctl`, `schtasks` or `tailscale serve`
commands. If it does the wrong thing, that is a bug in the installer for that
platform: say so plainly and offer to fix it as an ordinary reviewed code
change, which is a different task from this one. Its contract lives in
`docs/specs/server.md` under "Installing it (behind Tailscale)"; a change to one
is a change to both.

Before acting:

1. Read `docs/specs/server.md` — "Configuration", "Where a Host may reach a
   relay server (self-host builds)", and "Installing it (behind Tailscale)" —
   plus `docs/specs/remote-security-model.md` for the trust model you are about
   to set up.
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
8. If the user needs a relay that stays up while this laptop is asleep, stop and
   read `## Future` with them rather than improvising cloud infrastructure.

Keep a small worksheet in the conversation and fill it in as values become
known:

| Value | Default / example |
| --- | --- |
| Laptop OS | must be macOS or Windows |
| Laptop Tailscale DNS name | the installer derives it from `tailscale status --json` |
| External origin | `https://<laptop-name>.<tailnet-dns-suffix>` |
| Install root | macOS `~/Library/Application Support/Dormouse Server` · Windows `%LOCALAPPDATA%\Dormouse Server` |
| State directory | `<install root>/state` |
| Service | macOS `~/Library/LaunchAgents/sh.dormouse.server.plist` · Windows Scheduled Task `\Dormouse Server` |
| Loopback port | `3100` |
| Installed release | printed by the installer and by `manage status` |

## Prerequisites

- **A tailnet.** The user needs a Tailscale account with MagicDNS and HTTPS
  certificates enabled, Tailscale running on this laptop, and Tailscale on the
  phone that will run Pocket. A tailnet-only origin is not reachable merely
  because the laptop is on the tailnet.
- **macOS or Windows.** Each installer refuses to run on the other platform. On
  any third OS, stop and design the native service manager with the user rather
  than translating LaunchAgent or Scheduled Task commands blindly.
- **Neither installer runs privileged.** Both refuse — as root on macOS,
  elevated on Windows. The whole credential posture is that one user account
  owns `config/` and `state/`; an elevated run would write them owned by another
  principal and register the service for it. Use an ordinary terminal.
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
  state/
    account.json
    hosts.json
    push-subscriptions.json
    vapid.json
```

Logs live in `~/Library/Logs/Dormouse Server/` on macOS and `<install root>\logs`
on Windows. The service definition is
`~/Library/LaunchAgents/sh.dormouse.server.plist` or the Scheduled Task
`\Dormouse Server`.

Either installer deliberately will **not**: run `git pull`, fetch, or switch
branches; install a scheduled updater; ask for elevation; install or
re-authenticate Tailscale; rewrite an origin that no longer matches the node's
DNS name; or touch `config/` and `state/`, which survive every update, prune,
and uninstall.

The invariants it exists to hold — one replica, state outlives code, loopback
only, `DORMOUSE_ORIGIN` as durable WebAuthn identity, and a failed update being
a failure rather than a rollback dressed as success — are documented in
`docs/specs/server.md`. Two of them shape what the user should expect day to
day:

- An update is a short intentional restart. Existing Host and Pocket WebSockets
  disconnect and reconnect; there is no zero-downtime swap to attempt.
- Both are per-login agents, so the service is unavailable while the laptop
  sleeps, is shut down, or has no logged-in user. That is normally fine, because
  there is then no local Dormouse Host to control either. On Windows the
  at-logon trigger uses `LogonType=Interactive`, which is what keeps the task
  free of a stored password — and is the same tradeoff.

## Definition of done

`manage verify` checks all of these locally and exits nonzero on any failure:

- The service is registered and running, declares its run-at-load and
  restart-on-exit behavior, and carries no credential. On macOS: the LaunchAgent
  is loaded in `gui/$UID` and its plist lints, declares `RunAtLoad` and
  `KeepAlive`. On Windows: the Scheduled Task is `Running`, has an at-logon
  trigger, no execution time limit, restarts on failure, runs unelevated, is not
  stopped by battery or idle transitions, and `bin\run-server.ps1` still carries
  the supervision loop that is the actual KeepAlive.
- Loopback `/api/hello` responds and the Pocket app is served.
- Port 3100 is bound only to `127.0.0.1`, and the plaintext port is unreachable
  on the laptop's Tailscale IP.
- `tailscale serve` proxies to `127.0.0.1:3100` at the same origin recorded in
  `config/server.env`, and `tailscale funnel` is **off** — a Funnel would
  publish this same origin to the public internet, which the setup password's
  hardening was never sized for (`SECURITY.md` -> "Network posture").
- `config/`, `state/` and `config/server.env` are readable only by the
  installing user: modes `0700`/`0600` on macOS, a DACL with exactly that one
  user on Windows. The Windows check also covers each file in `state/`
  individually, because Node's file modes are a no-op there.
- The current release pointer resolves to a release with `RELEASE` metadata, and
  neither the service definition nor the `run-server` wrapper refers to the
  source checkout. A retained previous release is checked too, but a first
  install has none, so `verify` warns there rather than failing. On macOS it
  does fail if that pointer names the same release as `current`, because such
  an install advertises a rollback target that does not exist.

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
has it.

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

1. **The setup password.** Have the user run `manage show-password` in their own
   terminal when they are ready. It warns before printing. Do not ask for the
   value, and do not print it into the conversation.

2. **The passkey.** On the phone, open `https://<laptop>.<tailnet>.ts.net` in
   Safari → First-time setup (password + label) creates the passkey and signs
   them in. The passkey is bound to this exact origin. If they want push
   notifications, add Pocket to the Home Screen *before* signing in and do all
   of this inside the installed app — iOS delivers Web Push only there, and the
   install is a separate storage partition that would otherwise need its own
   pairing (`docs/specs/pocket-app.md` → Installable web app).

3. **The Host.** Launch the standalone or VS Code build made with
   `DORMOUSE_REMOTE_CONNECT_SRC` (see Prerequisites) and enroll once in
   **Settings → Remote control** — the sliders icon at the far right of the
   baseboard. Three fields: the server origin, the setup password from step 1,
   and a name for this machine. The `window.dormouseRemoteHost` console hook
   carries the same four commands and stays as the scripting seam
   (`docs/specs/server.md`, "Remote control, in the Settings dialog").

   Enrollment persists in the Host service's own store — a file under the
   app-data dir in standalone (mode `0600` on macOS and Linux; on Windows the
   mode is a no-op and the app-data ACL is what protects it), `SecretStorage` in
   VS Code — so later launches connect on their own. The section then shows the server, the relay
   connection, and the paired-device count.

   A build without the `*.ts.net` allowlist refuses this outright, before the
   password leaves the machine, and the form renders that refusal verbatim.
   That is the expected symptom of a stock build, not a server problem.

4. **A real session.** On the phone: Hosts → **Pair** → approve the modal that
   appears on the laptop → **Connect** (one biometric prompt) → pick a pane and
   type. Only now have HTTPS proxying, the WebSocket upgrade, and the security
   flow been exercised together.

5. **State.** Confirm `account.json`, `hosts.json`, and `vapid.json` now exist
   in `state/` (plus `push-subscriptions.json` if push was enabled). Record
   ownership and checksums without printing contents — checkpoint 5 checks them
   against a reinstall.

## Checkpoint 5: updating, rollback, uninstall

Updating is choosing a checkout and rerunning the same command:

```sh
git -C <checkout> log --oneline -1     # decide deliberately what to install
./deploy/local/install-macos.sh        # or .\deploy\local\install-windows.ps1
```

Prove it once, while the user is watching:

1. Rerun the installer from the same or a newer checkout.
2. Confirm the release changed as expected and that the `state/` checksums from
   checkpoint 4 and `config/server.env` are unchanged.
3. Run `manage rollback`, confirm the previous release comes back healthy, then
   return to the desired release.

`manage uninstall` removes the service definition and installed code and keeps
`config` and `state`, reporting where they are. `manage purge` is the separate,
irreversible operation that deletes them; it requires typing a confirmation
phrase and is never part of a reinstall.

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
equivalent on Windows. Check the coverage rather than assuming it: on Windows,
`%LOCALAPPDATA%` is **excluded** from File History's default library set and
from OneDrive's Known Folder Move, so the install root is very likely
unprotected until it is added explicitly. A second directory on the same disk is
not a backup. These files include Host bearer credentials
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

- Dormouse runtime, state contract, and what the installer guarantees:
  `docs/specs/server.md`
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
- **State disappears:** verify the absolute Application Support state path and
  the installed config. Do not initialize a new account until the old state has
  been located or restored.

## Future

**Scope: always-on-relay** — run the coordinating server on a cloud host
instead of the laptop, so the relay stays reachable while the laptop is asleep,
shut down, or logged out. Nothing below is implemented. It matters only for a
user who controls a Host that is not this laptop; a laptop that must be awake
to be controlled gains little from an always-on relay.

The design below carries its own origin: `https://dormouse.<tailnet-dns-suffix>`
via a Tailscale Service, not the laptop's machine name. Moving from the local
install to this one changes `DORMOUSE_ORIGIN`, which means redoing passkey setup
and Host enrollment.

### Architecture

```text
push/merge to main
        |
        v
existing CI workflow succeeds
        |
        v
deploy-server workflow builds an amd64 Docker image on GitHub's runner
        |
        |  short-lived OIDC identity; no reusable Tailscale or SSH key
        v
ephemeral tag:dormouse-ci node --Tailscale SSH--> tag:dormouse-server Droplet
                                                        |
                                                        v
                                             one Dormouse container
                                             127.0.0.1:3000 only
                                                        |
                                                        v
                                Tailscale Service HTTPS: svc:dormouse :443
                                                        |
                                                        v
                                    phone and Dormouse Host on the tailnet

/var/lib/dormouse on the Droplet
  account.json
  hosts.json
  push-subscriptions.json
  vapid.json
```

### Definition of done


- The container is healthy, non-root, and read-only except for `/data`.
- A successful `CI` run for a new `main` SHA automatically deploys that exact
  SHA.
- A failed CI run does not deploy.
- A failed container health check automatically restores the prior image and
  makes the deployment workflow fail visibly.
- Tailscale SSH from `tag:dormouse-ci` can log in only to the deployment node as
  `deploy`; it is not granted broad tailnet access.
- Public SSH is closed after Tailscale SSH has been tested.
- DigitalOcean backups are enabled, or the user has explicitly chosen and
  tested a different off-Droplet backup for `/var/lib/dormouse`.
- `SECURITY.md` describes and audits the CI deployment path.

### Preflight

Inspect existing workflows, especially the exact workflow name in
`.github/workflows/ci.yml` (this runbook expects `CI`; use the actual name), and
whether Docker, `gh`, an SSH client, GitHub, and DigitalOcean are available.
Ask only for choices that cannot be derived:

1. DigitalOcean region.
2. Whether to enable DigitalOcean Droplet backups. Recommend yes; it is a paid
   option.
3. Which Tailscale user identity should retain interactive administrative SSH
   access to the Droplet.

Confirm that the user's phone runs Tailscale. A tailnet-only Pocket web app is
not reachable merely because the laptop is on the tailnet.

### Build order

Staged order for building this out. It is more operationally involved than the
local install and is not the recommendation for a single laptop that must
already be awake to be controlled.

### Step 1: author the repository deployment artifacts

Create and review the following files. Follow existing repository conventions
and do not commit yet:

```text
.dockerignore
server/Dockerfile
deploy/digitalocean/compose.yml
deploy/digitalocean/deploy.sh
.github/workflows/deploy-server.yml
```

Also update:

- `docs/specs/server.md`: promote the actual production self-host deployment
  behavior above the fold, with `Source of truth:` pointers to these files.
- `SECURITY.md`: document the `dormouse-production` environment, its two
  environment-scoped Tailscale WIF values, its `main`-only deployment policy,
  the least-privilege tailnet path, and why the workflow has `id-token: write`.
  Amend mechanical `FAIL IF` rules where necessary so this production path is
  audited rather than merely described.
- `docs/specs/deploy.md` only if its exhaustive Files/Code Map or release scope
  actually claims these files. Do not conflate self-host server deployment with
  signed desktop releases.

#### Dockerfile contract

`server/Dockerfile` must:

- Use a multi-stage Debian-based Node image pinned to the exact Node version in
  root `package.json`; do not use `latest` or a bare major.
- Use the root repository as build context.
- Enable the exact pnpm version from root `packageManager` through Corepack.
- Install with `pnpm install --frozen-lockfile`.
- Run `pnpm --filter dormouse-lib build:pocket` and
  `pnpm --filter server build`.
- Produce a production-only server tree. With the current pnpm workspace,
  `pnpm --filter server deploy --prod --legacy /out/server` is required unless
  the repository intentionally adopts injected workspace packages. Do not
  silently change pnpm workspace semantics just for this image.
- Copy `lib/dist-pocket` into the runtime layout expected by
  `server/src/config.ts`.
- Run as a fixed unprivileged UID/GID such as `10001:10001` and document that
  the Droplet state directory must have matching ownership.
- Expose port 3000, include a health check against `/api/hello`, and start
  `node dist/index.js`.
- Add the OCI source label and accept a build argument for the Git commit SHA.
- Contain no Tailscale client, setup password, auth key, source-control
  credential, or build output copied from the developer's workstation.

`.dockerignore` must at minimum exclude `.git`, all `node_modules`, all local
`dist`/build outputs, `.env*`, state/data directories, editor/agent metadata,
and native build targets. Check that it does not exclude source or package
manifests required by the build.

#### Compose contract

`deploy/digitalocean/compose.yml` must define one service and:

- Use `${DORMOUSE_IMAGE:?DORMOUSE_IMAGE is required}` as its image.
- Use a stable container name such as `dormouse-server`.
- Load `/etc/dormouse/server.env`.
- Bind `/var/lib/dormouse:/data`.
- Publish `127.0.0.1:3000:3000`, never `3000:3000`.
- Set `restart: unless-stopped`, `init: true`, a reasonable stop grace period,
  bounded local log rotation, and use the image health check.
- Set a read-only root filesystem, a small `/tmp` tmpfs, drop all Linux
  capabilities, and set `no-new-privileges` unless testing proves a specific
  relaxation is required.
- Declare no database and no second server replica.

#### Deployment script contract

`deploy/digitalocean/deploy.sh` must be a strict Bash script and must be tested,
not sketched. It must:

- Accept only a local image reference of the form
  `dormouse-server:<40-hex-main-sha>`.
- Serialize deployments with `flock`.
- Verify the image exists and its OCI revision label equals the requested SHA.
- Validate the candidate Compose configuration before changing the live one.
- Atomically record the candidate image in a non-secret env file under
  `/opt/dormouse`.
- Run `docker compose up -d --wait` with a bounded timeout, then independently
  request `http://127.0.0.1:3000/api/hello`.
- On failure, restore the previous image/configuration, wait for it to become
  healthy, and exit nonzero. Never report success merely because rollback
  succeeded.
- On success, record current and previous image references and remove older
  `dormouse-server:<sha>` images while retaining those two for rollback.
- Provide a documented manual rollback invocation using the recorded previous
  image.
- Never read, print, copy, rewrite, or back up the setup password.

If the workflow also updates `compose.yml` or `deploy.sh`, stage them in a
SHA-specific incoming directory, syntax-check and Compose-validate them, and
retain the last working copies. Do not replace the working deployment controls
before validation. A simpler acceptable initial implementation is to require
manual reinstallation of changed deployment-control files, but then state that
limitation clearly; changes to application code and `server/Dockerfile` must
still autodeploy.

#### GitHub workflow contract

`.github/workflows/deploy-server.yml` must:

- Trigger from `workflow_run` only after the existing main-branch `CI` workflow
  completes successfully, plus `workflow_dispatch` for recovery/testing.
- Check out exactly `github.event.workflow_run.head_sha` for a workflow-run
  event, and `github.sha` for manual dispatch. Never build an implicit moving
  branch tip.
- Use `environment: dormouse-production`.
- Grant only `contents: read` and `id-token: write`. In particular, do not add
  `packages: write`, `actions: write`, or repository write access.
- Use a single production concurrency group. Do not cancel a deployment while
  it may be replacing the container. Immediately before remote activation,
  detect a stale SHA relative to `origin/main` and skip it; if main advances
  just after that check, allow the newer queued run to deploy afterward.
- Build `linux/amd64` from `server/Dockerfile`, tag it
  `dormouse-server:<sha>`, and set its OCI revision label.
- Compress `docker save` output and stream it over `tailscale ssh` to
  `deploy@dormouse-relay`, where it is decompressed into `docker load`. Do not
  publish it to a registry or upload it as a long-lived Actions artifact.
- Join the tailnet using the official Tailscale GitHub Action, pinned to a full
  commit SHA, workload identity federation, `tag:dormouse-ci`, and the `ping`
  input for `dormouse-relay`.
- Invoke `/opt/dormouse/deploy.sh` with the immutable SHA-tagged image.
- Apply sensible timeouts and ensure secret values never appear in logs.

Use shell quoting that treats all GitHub context values as data passed through
environment variables, not interpolated shell source. Remember that a commit
on `main` can already alter this workflow and execute commands on the deployment
node; branch protection and the production environment are part of the trust
boundary.

#### Local verification

Before cloud changes:

1. Build the image for `linux/amd64` if the local Docker installation supports
   it. If emulation is unavailable, let the GitHub runner perform the first full
   build, but still lint the Dockerfile.
2. Start it with a temporary state directory and temporary generated setup
   password, bound to an unused loopback port.
3. Verify `/api/hello`, the Pocket index, health status, non-root UID, read-only
   root, and writes under `/data`.
4. Run the server tests and the repository's spec/security lint relevant to the
   changed files.
5. Run `pnpm lint:specs`, plus the proportional package tests. Run the full
   `pnpm test` if practical before proposing a commit.

### Step 2: create the protected GitHub environment

In GitHub repository settings, create the environment
`dormouse-production`:

- Configure deployment branches/tags to allow only `main`.
- Do not add required reviewers because the requested behavior is automatic
  deployment after CI. Explain this tradeoff to the user.
- Do not put the Dormouse setup password, a DigitalOcean token, an SSH private
  key, or a reusable Tailscale auth key in GitHub.

The environment will later contain:

- `TS_OAUTH_CLIENT_ID`
- `TS_AUDIENCE`

They are the Client ID and Audience of a narrowly scoped Tailscale federated
identity. Tailscale documents that these values are not secrets, but environment
scope ensures the deployment workflow and its OIDC subject remain coupled.

Verify the environment's branch policy through the GitHub UI or API. Re-read
the environment rules in `SECURITY.md` and update them if the new environment
would otherwise fail the repository's security audit.

### Step 3: configure Tailscale policy, Service, and CI identity

Use the Tailscale admin console and preserve the existing policy.

#### Tags and least-privilege policy

Create `tag:dormouse-server` and `tag:dormouse-ci`. Make the user's chosen
Tailscale admin identity their owner. Merge policy entries equivalent to:

```jsonc
{
  "tagOwners": {
    "tag:dormouse-server": ["<TAILSCALE-ADMIN-LOGIN>"],
    "tag:dormouse-ci": ["<TAILSCALE-ADMIN-LOGIN>"],
  },

  "autoApprovers": {
    "services": {
      "svc:dormouse": ["tag:dormouse-server"],
    },
  },

  "grants": [
    // Tailnet members can use the Pocket/relay HTTPS endpoint.
    {
      "src": ["autogroup:member"],
      "dst": ["svc:dormouse"],
      "ip": ["tcp:443"],
    },

    // The ephemeral CI node can reach only SSH on the deployment node.
    {
      "src": ["tag:dormouse-ci"],
      "dst": ["tag:dormouse-server"],
      "ip": ["tcp:22"],
    },

    // Keep one human recovery path. Narrow this to the chosen identity.
    {
      "src": ["<TAILSCALE-ADMIN-LOGIN>"],
      "dst": ["tag:dormouse-server"],
      "ip": ["tcp:22"],
    },
  ],

  "ssh": [
    {
      "action": "accept",
      "src": ["tag:dormouse-ci"],
      "dst": ["tag:dormouse-server"],
      "users": ["deploy"],
    },
    {
      "action": "check",
      "src": ["<TAILSCALE-ADMIN-LOGIN>"],
      "dst": ["tag:dormouse-server"],
      "users": ["deploy"],
      "checkPeriod": "1h",
    },
  ],
}
```

This is an entry-level example, not a complete replacement policy. Adapt it if
the tailnet uses groups or policy tests. Add tests proving that:

- `tag:dormouse-ci` reaches `tag:dormouse-server:22`.
- `tag:dormouse-ci` does not reach the server tag on other ports or unrelated
  tagged nodes.
- The intended user reaches `svc:dormouse:443`.

#### Define the Service

On the Tailscale **Services** page, define:

- Name: `dormouse` (`svc:dormouse` in policy).
- Endpoint: `tcp:443`.
- Description: the private Dormouse Pocket/relay endpoint.

Record its MagicDNS hostname and set the worksheet origin to exactly:

```text
https://dormouse.<tailnet-dns-suffix>
```

Do not use the Droplet machine name in `DORMOUSE_ORIGIN`.

#### Create the GitHub workload identity

In Tailscale **Trust credentials**, create an OpenID Connect federated
credential:

- Issuer: GitHub Actions (`https://token.actions.githubusercontent.com`).
- Subject: restrict it to this repository's `dormouse-production` environment.
  For the repository's current default GitHub OIDC format this is expected to
  be `repo:<OWNER>/<REPO>:environment:dormouse-production`.
- If GitHub immutable OIDC subjects have been enabled, use the actual
  owner-ID/repository-ID form instead. Inspect the repository OIDC settings or
  a safely decoded token claim; do not guess and do not print the signed token.
- Scope: only `auth_keys`.
- Allowed tag: only `tag:dormouse-ci`.
- Description: `Dormouse production deploy from GitHub Actions`.

Copy the resulting Client ID and Audience directly into the two
`dormouse-production` GitHub environment values. Do not paste them into chat.

The subject restriction matters more than the confidentiality of these values:
a feature-branch workflow must not be able to exchange its OIDC token for a
tailnet node.

### Step 4: provision the DigitalOcean Droplet

Use a regular Ubuntu 24.04 LTS Droplet, not DigitalOcean App Platform or a
one-click application image.

Recommended starting shape:

- Basic shared CPU, amd64.
- At least 1 GiB RAM; 2 GiB is the conservative choice. Builds occur in GitHub,
  so the Droplet only runs Docker, Tailscale, and one Node process.
- A region near the user.
- SSH-key authentication, not a root password.
- Monitoring enabled.
- Droplet backups enabled if the user approved the cost.
- No block volume is necessary for two tiny JSON files.

Create a DigitalOcean Cloud Firewall attached to the Droplet:

- Initially allow TCP 22 only from the user's current public IP, as a bootstrap
  path.
- Allow UDP 41641 from IPv4/IPv6 if the user wants better odds of direct
  Tailscale connectivity. Tailscale can still use DERP without it.
- Allow normal outbound traffic required for Ubuntu, Docker image transfer,
  Tailscale, DNS, and time synchronization.
- Do not allow inbound TCP 80, 443, 3000, or unrestricted 22.

After creation, connect over the temporary public SSH rule and:

1. Apply Ubuntu security updates.
2. Install Docker Engine and the Compose plugin from Docker's current official
   Ubuntu repository; do not use an unreviewed convenience image.
3. Install the current stable Tailscale client from Tailscale's official Ubuntu
   repository.
4. Create local user `deploy` with no password and a normal shell. Add it to the
   `docker` group. Treat Docker-group membership as root-equivalent.
5. Create `/opt/dormouse`, owned by `deploy`.
6. Create a system group that can read `/etc/dormouse/server.env`, add `deploy`
   to it, and keep that file mode `0640`. Docker Compose must be able to read the
   env file. Do not make it world-readable.
7. Create `/var/lib/dormouse` mode `0700`, owned by the fixed runtime UID/GID
   from `server/Dockerfile`.

Generate a one-off, pre-approved Tailscale auth key carrying only
`tag:dormouse-server`. Have the user enter it into a hidden shell variable on
the Droplet, then run Tailscale with hostname `dormouse-relay` and Tailscale SSH
enabled. Unset the variable immediately and confirm it did not enter shell
history. Prefer a one-off key over a reusable key.

Verify:

```sh
tailscale status
tailscale set --ssh
docker version
docker compose version
id deploy
```

From the user's tailnet-connected workstation, verify an interactive
`tailscale ssh deploy@dormouse-relay` succeeds and that Tailscale checked the
host key. Only after that succeeds, remove public TCP 22 from the DigitalOcean
Cloud Firewall and test Tailscale SSH again. Keep DigitalOcean's Recovery
Console as the break-glass path.

### Step 5: install runtime configuration and deployment controls

On the Droplet, generate the setup password locally with a cryptographically
secure generator; do not transport it through chat or GitHub. Write:

```dotenv
DORMOUSE_SETUP_PASSWORD=<generated-on-the-Droplet>
DORMOUSE_ORIGIN=https://dormouse.<tailnet-dns-suffix>
DORMOUSE_STATE_DIR=/data
PORT=3000
NODE_ENV=production
```

to `/etc/dormouse/server.env` with the ownership and `0640` mode established
above. Avoid commands that expose the value in process listings or shell
history. The user will need to retrieve this password locally for initial
passkey setup and Host enrollment; show it only in their terminal when needed.

Install the reviewed `compose.yml` and executable `deploy.sh` under
`/opt/dormouse`. Validate as `deploy`:

```sh
bash -n /opt/dormouse/deploy.sh
docker compose --env-file /opt/dormouse/deploy.env \
  -f /opt/dormouse/compose.yml config
```

For pre-deploy validation, use a syntactically valid placeholder image in
`deploy.env`; do not start the service before an image has been transferred.

### Step 6: enable the first automatic deployment

Show the user the full repository diff, including the security boundary and
workflow permissions. Run the required tests. Then ask whether they want you to
commit and push/open a PR according to their normal workflow.

When the deployment files reach `main`:

1. The existing `CI` workflow must finish successfully.
2. The deployment workflow must obtain an environment-scoped GitHub OIDC token.
3. Tailscale must exchange it for an ephemeral `tag:dormouse-ci` node.
4. The job must build and stream `dormouse-server:<main-sha>`.
5. The Droplet must load it, start one healthy container, and report the same
   revision.

If the first `workflow_run` does not fire because the deployment workflow was
introduced by that same commit, use its `workflow_dispatch` trigger once. Do
not weaken the event or environment restrictions.

Inspect the Actions log and the Droplet together. Verify the running image's
OCI revision label equals the intended `main` SHA.

Once port 3000 is healthy on loopback, configure and advertise the stable
Tailscale Service on the Droplet using the current equivalent of:

```sh
sudo tailscale serve --service=svc:dormouse --https=443 3000
```

Approve the HTTPS/Service prompt in the Tailscale admin console if required.
Confirm the Service is advertised by `tag:dormouse-server`, not by the CI node,
and inspect `tailscale serve status` / `tailscale serve get-config --all`.

### Step 7: end-to-end validation

From a tailnet-connected device:

1. Request `https://dormouse.<tailnet>/api/hello`; expect HTTP 200 and the
   documented JSON response.
2. Open `https://dormouse.<tailnet>/`; expect the Pocket application, not the
   missing-build fallback message.
3. Confirm the certificate and hostname match the exact `DORMOUSE_ORIGIN`.
4. Temporarily disconnect a test device from Tailscale and verify the origin is
   no longer reachable. Do not disable Tailscale on the deployment node.

On the Droplet:

```sh
docker ps --filter name=dormouse-server
docker inspect dormouse-server
ss -lntp
sudo tailscale serve status
sudo ls -la /var/lib/dormouse
```

Check specifically that:

- Docker reports `healthy`.
- The process UID is the fixed non-root UID.
- The root filesystem is read-only.
- Host port 3000 listens only on `127.0.0.1`.
- There is exactly one server container.

Complete initial Pocket setup, then enroll a custom self-host standalone or VS
Code build. After `account.json`, `hosts.json`, and `vapid.json` exist (and
`push-subscriptions.json` too if push was enabled):

1. Record ownership and checksums of every present state file without printing
   contents.
2. Manually dispatch the deployment workflow or restart/replace the container.
3. Verify the files and registered passkey/Host survive.
4. Establish a real Host and Pocket WebSocket session through the Service.

This is the point at which HTTPS proxying, WebSocket upgrade handling, and the
application security flow have actually been tested together.

### Step 8: prove deploy and rollback behavior

The first merge containing the deployment workflow normally proves automatic
deployment from `main`. Also test these cases without manufacturing meaningless
production commits:

- Use `workflow_dispatch` to prove an idempotent redeploy.
- If a real subsequent server change is available, observe that its successful
  main CI run deploys the exact new SHA.
- Exercise rollback deliberately with a temporary image whose health check
  fails, or test the deployment script against an isolated Compose project on
  the Droplet. Do not intentionally break the live Pocket origin without the
  user's approval.
- Confirm that after a failed candidate, the old image is healthy, the workflow
  is red, and current/previous metadata is truthful.
- Run the documented manual rollback command and then restore the desired
  current image.

Because server restarts drop in-memory sessions and WebSockets, verify that the
Host reconnects and that Pocket can reconnect after a normal deploy. A few
seconds of reconnect time is expected; pretending this deployment is
zero-downtime is not.

### Step 9: backup and recovery

Verify DigitalOcean backups are active if selected. Explain that a Droplet
backup is the off-instance durability layer for `/var/lib/dormouse`; Docker's
bind mount only protects the data from container replacement.

If the user declines Droplet backups, configure a concrete encrypted backup of
`/var/lib/dormouse` to storage outside the Droplet and perform a restore test.
Do not call a second directory on the same Droplet a backup. These state files
include Host bearer credentials and a VAPID private key, so protect backup
access accordingly.

Document recovery:

1. Provision a replacement tagged Droplet.
2. Restore `/var/lib/dormouse` with the fixed runtime UID/GID and mode.
3. Restore `/etc/dormouse/server.env`, preserving the exact
   `DORMOUSE_ORIGIN` and setup password.
4. Deploy a known-good image.
5. Drain `svc:dormouse` from the old host if it is still present.
6. Advertise `svc:dormouse` from the replacement.
7. Verify HTTPS, WebSockets, passkey sign-in, and Host enrollment state.

The Service hostname remains stable; no WebAuthn origin migration should be
needed.

### Handoff

Include the Droplet name and DigitalOcean region (not its public IP
unless useful), how to view container and deployment workflow logs, and the
automatic deployment trigger. Do not describe the laptop's LaunchAgent or
Scheduled Task as if it were installed.

### References

- [Create a DigitalOcean Droplet](https://docs.digitalocean.com/products/droplets/how-to/create/)
- [DigitalOcean Cloud Firewall rules](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/)
- [DigitalOcean Droplet backups](https://docs.digitalocean.com/products/backups/how-to/create-and-restore/)
- [Tailscale GitHub Action](https://tailscale.com/docs/integrations/github/github-action)
- [Tailscale workload identity federation](https://tailscale.com/docs/features/workload-identity-federation)
- [GitHub Actions OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
- [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh)
- [Tailscale Services](https://tailscale.com/kb/1552/tailscale-services)
- [Install Tailscale on Linux](https://tailscale.com/docs/install/linux)
- [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)

### Troubleshooting boundaries

- **The CI node joins Tailscale but SSH fails:** inspect both the `grants` entry
  for TCP 22 and the separate `ssh` rule. Tagged-node-to-tagged-node automation
  must use `action: accept`, not interactive check mode.
- **OIDC exchange fails:** compare the actual GitHub `sub`, `aud`, repository,
  environment, and workflow claims with the Tailscale trust credential. Do not
  broaden the subject to every branch as a shortcut.
- **Service returns 502/connection refused:** verify the container health and
  loopback binding first, then inspect the Service host's Serve configuration.
- **Deploy succeeds but old code runs:** compare the requested SHA, image OCI
  label, Compose image value, and running container image ID. Never rely on a
  mutable `latest` tag.
- **State disappears:** verify the host bind mount and `DORMOUSE_STATE_DIR=/data`.
  Do not initialize a new account until old state has been located or restored.
- **Workflow violates the security audit:** do not suppress the audit. Rework
  permissions and secret placement to satisfy `SECURITY.md`, and update its
  explicit invariants where the new production path legitimately expands them.
