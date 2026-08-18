# Run the Dormouse server behind Tailscale

> This is an assistant-run setup playbook. Start a fresh Claude instance in
> this repository and say: `read @SELF_HOST.md and walk me through it`.

This installs the Dormouse coordinating server on the user's own Mac, reachable
only from their tailnet at `https://<laptop>.<tailnet>.ts.net`. That is the
whole self-host story today. An always-on cloud relay is designed but not
built; it lives under `## Future`.

## Instructions to the assistant

Your job is to guide the user through this runbook one checkpoint at a time,
performing the repository and command-line work you safely can and pausing only
for browser-console actions, secrets, or explicit approval of external or
destructive changes. Do not dump the entire runbook back at the user.

Before acting:

1. Read `AGENTS.md`, `SECURITY.md`, `docs/specs/server.md`,
   `docs/specs/remote-security-model.md`, and the CSP section of
   `docs/specs/standalone.md` completely.
2. Inspect the worktree and preserve unrelated user changes. Determine whether
   any files from this runbook already exist; resume and verify rather than
   overwriting a partial setup.
3. Recheck the linked official documentation. This runbook was updated on
   2026-08-17; dashboards and CLI syntax can change.
4. Explain the current checkpoint, carry it out, verify it, and only then move
   to the next checkpoint.
5. Never ask the user to paste the setup password or any other bearer
   credential into chat. Generate the setup password on the laptop and leave it
   in the installer-owned mode-`0600` config file.
6. Do not commit, push, merge, or delete installed state without first showing
   the exact change and obtaining the user's approval.
7. If the user needs a relay that stays up while this laptop is asleep, stop and
   read `## Future` with them rather than improvising cloud infrastructure.

Keep a small worksheet in the conversation and fill it in as values become
known:

| Value | Default / example |
| --- | --- |
| Laptop OS | must be macOS |
| Laptop Tailscale DNS name | derive from `tailscale status --json` |
| External origin | `https://<laptop-name>.<tailnet-dns-suffix>` |
| Install root | `~/Library/Application Support/Dormouse Server` |
| State directory | `~/Library/Application Support/Dormouse Server/state` |
| LaunchAgent | `~/Library/LaunchAgents/sh.dormouse.server.plist` |
| Loopback port | `3100` |

## Prerequisites

- **A tailnet.** The user needs a Tailscale account with MagicDNS and HTTPS
  certificates enabled, Tailscale running on this Mac, and Tailscale on the
  phone that will run Pocket. A tailnet-only origin is not reachable merely
  because the laptop is on the tailnet.
- **macOS.** The installer below is macOS-only. On another OS, stop and design
  the native service manager with the user rather than translating LaunchAgent
  commands blindly.
- **A Host build that can reach a `*.ts.net` origin.** The shipped standalone
  binary pins its webview `connect-src` to the SaaS origin, so a self-host relay
  needs a local build:

  ```sh
  DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:standalone
  ```

  `standalone/scripts/tauri.mjs` reads that variable and overrides the
  checked-in CSP for that build only.

  The Host must be the standalone app. Remote hosting is standalone-only today:
  `enableRemoteHost` is passed just by `standalone/src/main.tsx`, so the shared
  webview entrypoint `lib/src/main.tsx` — the one the VS Code extension renders
  — never loads the relay, enrollment, or pairing modules at all. That, not the
  webview CSP in `vscode-ext/src/webview-html.ts`, is why `pnpm dogfood:vscode`
  cannot produce a Host for a self-host relay. Do not offer the user a CSP
  override as a fix; supporting a VS Code Host is a feature, not a build flag.

## Architecture

### What gets installed

```text
user runs ./deploy/local/install-macos.sh
        |
        v
build exact current checkout into a self-contained release
        |
        v
macOS LaunchAgent (RunAtLoad + KeepAlive)
        |
        v
Dormouse Node server on 127.0.0.1:3100
        |
        v
tailscale serve --bg terminates private HTTPS
        |
        v
https://<laptop>.<tailnet>.ts.net

~/Library/Application Support/Dormouse Server/state
  account.json
  hosts.json
```

The LaunchAgent starts after the user logs in and restarts the process if it
crashes. Tailscale's background Serve configuration survives Tailscale and
machine restarts. The service is unavailable while the laptop sleeps, is shut
down, or has no logged-in user; that is normally fine because there is then no
local Dormouse Host to control.

### Invariants

- Run exactly one server replica. Challenges, sessions, WebSocket bindings, and
  relay state are in memory. Multiple uncoordinated replicas are incorrect.
- An update is a short intentional restart. Existing Host and Pocket WebSockets
  disconnect and reconnect; do not attempt a zero-downtime swap for this
  protocol.
- Persist both `account.json` and `hosts.json` outside the installed release.
  Code replacement must never replace state.
- Bind the server only to loopback. Do not make plain HTTP port 3100 reachable
  from the LAN or the tailnet. Tailscale terminates HTTPS.
- Port 3100 is deliberately not 3000: `pnpm dev:server` and
  `pnpm dev:pocket-server` both run the server on 3000, and the installed
  service shares this laptop with that dev loop.
- Treat `DORMOUSE_ORIGIN` as durable WebAuthn identity. It is the laptop's
  Tailscale DNS name; renaming or re-registering that node can require passkey
  and Host re-enrollment.
- The installed release must contain both `server/dist` and `lib/dist-pocket`.
  Building the `server` package alone is insufficient.
- The setup password remains only in a mode-`0600` local configuration file.

## Definition of done

- `https://<laptop>.<tailnet>.ts.net/api/hello` succeeds from a tailnet device
  and is unreachable when that device leaves the tailnet.
- The Pocket app is served at the same HTTPS origin.
- Port 3100 is bound only to `127.0.0.1`.
- `account.json` and `hosts.json` survive replacement of the running release.
- One installer invocation builds and installs the exact current checkout.
- The LaunchAgent is loaded, starts at login, and restarts the server after an
  intentional process kill.
- `tailscale serve --bg` is configured for the laptop's HTTPS name.
- Rerunning the installer updates the release and preserves state; a failed
  update restores the prior release.
- `manage verify` exits zero and reports every check above that it can observe
  locally.
- The repository specs describe the installed behavior.

## Phase 0: preflight

Inspect and report:

- `git status --short`, current branch, and origin.
- The exact Node version in root `package.json` under
  `devEngines.runtime.version`, and the pnpm version in `packageManager`.
  `SECURITY.md` keys a mechanical `FAIL IF` to the `devEngines` field, so read
  that field specifically rather than `engines`.
- The host OS and architecture. If this is not macOS, stop; see Prerequisites.
- Whether `tailscale` is installed, signed in, and on `PATH`; on macOS also
  check the known application-bundle CLI paths.
- Whether HTTPS and MagicDNS are enabled for the tailnet.
- The laptop's stable Tailscale DNS name.
- That port 3100 is available on loopback.
- That the user wants the currently checked-out worktree installed. Report the
  Git SHA and whether it is dirty; do not silently switch or pull branches.

Confirm that the user's phone runs Tailscale.

## Install on this Mac

This runbook is intentionally independent of GitHub and cloud hosting. Its only
remote dependency is the user's existing Tailscale account. The current checkout is
the release source; rerunning the installer is the update mechanism.

### 1: author the local installer

Create and review:

```text
deploy/local/install-macos.sh
```

The installer may generate stable helper files inside its install root, but do
not require the user to maintain hand-edited plists or shell wrappers. The
normal command is exactly:

```sh
./deploy/local/install-macos.sh
```

Running that command a second time updates the installed release from the
current checkout. It must not run `git pull`, switch branches, fetch a release,
or install a scheduled updater.

The server already supports an explicit loopback bind: `DORMOUSE_BIND_HOST` is
read by `server/src/config.ts` and passed through the `@hono/node-server` listen
option, with the unset default still binding every interface. The local
configuration must set:

```dotenv
DORMOUSE_BIND_HOST=127.0.0.1
```

Do not reintroduce a generic `HOST` variable for this, and do not change the
unset default — `server/test/bind-host.test.mjs` asserts both halves.

Update `docs/specs/server.md` above the fold with the installation behavior,
using `Source of truth:` pointers. Add `deploy/local/install-macos.sh` to that
spec's exhaustive Files/Code Map if it has one. Update `SECURITY.md` only if the
installer changes an invariant it audits; this path adds no GitHub workflow or
deployment secret.

### 2: installer contract

The script must be idempotent, strict Bash and safe with spaces in paths. It
must refuse non-macOS hosts with a clear message. It should require no `sudo`
and install only into the current user's home directory:

```text
~/Library/Application Support/Dormouse Server/
  bin/
    run-server
    manage
  config/
    server.env
  current -> releases/<release-id>
  previous -> releases/<release-id>
  releases/
    <release-id>/
      runtime/node
      server/
      lib/dist-pocket/
      RELEASE
  state/
    account.json
    hosts.json

~/Library/LaunchAgents/sh.dormouse.server.plist
~/Library/Logs/Dormouse Server/
```

On each invocation it must:

1. Confirm `tailscale` is installed, signed in, and reports a stable DNS name.
   Detect both a CLI on `PATH` and supported macOS application-bundle CLI
   locations. Do not install or reauthenticate Tailscale without the user.
2. Derive the external origin from `tailscale status --json`, remove any
   trailing dot, and show it to the user. If an existing installation's origin
   differs, stop and explain the WebAuthn migration consequence rather than
   silently rewriting it.
3. Report the current Git SHA, branch, architecture, and dirty/clean status.
   Ask for confirmation before installing a dirty worktree, but allow it: the
   whole point is to install exactly what is currently checked out.
4. Read the exact Node version from root `package.json` under
   `devEngines.runtime.version` and the pnpm version from `packageManager`; use
   Corepack and the repository versions rather than global floating versions.
5. Install with `pnpm install --frozen-lockfile`, build `lib/dist-pocket`,
   `server-lib-common`, and `server`, then create a production-only server tree.
   With the current workspace, use the verified `pnpm deploy --prod --legacy`
   flow unless injected workspace packages are intentionally adopted.
6. Copy the exact `process.execPath` Node executable used for the build into the
   release. The LaunchAgent must not depend on Homebrew, nvm, Volta, pnpm's
   cache, the source checkout, or the user's interactive shell `PATH` after
   installation. Verify the copied runtime's version and macOS architecture.
7. Copy `lib/dist-pocket` into the layout expected by `server/src/config.ts`
   (or point `DORMOUSE_POCKET_DIR` at it).
8. Write a `RELEASE` metadata file containing at least Git SHA, dirty status,
   build timestamp, Node version, and source checkout path. Do not claim a dirty
   build is reproducibly identified by its SHA alone.
9. On first install, generate a high-entropy hexadecimal setup password on the
   Mac and create mode-`0600` `config/server.env` containing:

   ```dotenv
   DORMOUSE_SETUP_PASSWORD=<generated-locally>
   DORMOUSE_ORIGIN=https://<laptop-name>.<tailnet-dns-suffix>
   DORMOUSE_STATE_DIR="<absolute-install-root>/state"
   DORMOUSE_BIND_HOST=127.0.0.1
   PORT=3100
   NODE_ENV=production
   ```

   Preserve this file byte-for-byte on updates. Do not print the password
   during routine install/update. Provide an explicit `manage show-password`
   operation that warns before displaying it locally for setup or enrollment.
   Keep the `config` and `state` directories mode `0700`; they contain the setup
   password and Host bearer credentials.
10. Install a stable mode-`0700` `bin/run-server` wrapper outside the release.
    It must safely load only the installer-owned env file and `exec` the copied
    Node runtime with `current/server/dist/index.js`. It must not invoke a
    shell-dependent package manager at service startup.
11. Install `~/Library/LaunchAgents/sh.dormouse.server.plist` with absolute
    paths and `RunAtLoad` plus `KeepAlive`. Use `ProgramArguments`, a valid
    `WorkingDirectory`, bounded restart throttling, and stdout/stderr paths
    under `~/Library/Logs/Dormouse Server`. Do not embed the setup password in
    the plist. Validate it with `plutil -lint`.
12. Stage the new release without touching `current`, run a disposable
    loopback health check against the candidate, and only then switch the
    symlink atomically.
13. Use modern `launchctl bootout`, `bootstrap`, and `kickstart` commands in the
    current `gui/$UID` domain. Treat “not currently loaded” during a first
    install as benign; treat other launchd errors as failures.
14. Wait for `http://127.0.0.1:3100/api/hello` and the Pocket index. If the new
    release fails, restore `current` to `previous`, restart it, verify it is
    healthy, and exit nonzero. Never report an update successful merely because
    rollback worked.
15. Retain the current and previous releases and remove older releases only
    after success. Never remove `state` or `config` during cleanup.
16. Inspect the node's existing Serve configuration, then configure the current
    equivalent of `tailscale serve --bg 3100`. This is a node-scoped Serve
    endpoint, not a Tailscale Service. Do not reset or overwrite unrelated Serve
    paths; if another app already owns the root HTTPS mapping, stop and resolve
    the hostname/path conflict with the user. Allow Tailscale's HTTPS consent
    flow to open if the tailnet has not enabled certificates.
17. Verify Serve reports the same HTTPS origin written to `server.env`.

The installed `bin/manage` helper should support at least:

```text
status          show LaunchAgent, process, health, Serve origin, and release
verify          run the Definition of done checks and exit nonzero on any failure
logs            tail the local server logs
restart         kickstart the LaunchAgent and wait for health
show-password   warn, then display the setup password locally
rollback        switch to the retained previous release, preserving state
uninstall       remove LaunchAgent and installed code only after confirmation
```

Uninstall must default to preserving `config` and `state`, explicitly report
their locations, and turn off only the Serve mapping owned by this installer.
Provide a separate explicit purge operation for irreversible state deletion;
require the user to type a confirmation phrase. Never make purge part of a
normal reinstall or uninstall.

### 3: test before installing

Before the user runs the installer against their real state:

1. Run `bash -n` and a shell linter if one is already available.
2. Run `pnpm lint:specs` and the server tests.
3. Exercise installation with a temporary `HOME` or an installer test mode so
   path quoting, plist generation, release switching, and cleanup can be tested
   without loading a real LaunchAgent. Do not fake the final live validation.
4. Confirm the release starts without the repository or package-manager paths
   on `PATH`.
5. Confirm plain HTTP is reachable at `127.0.0.1:3100` and not at the laptop's
   LAN or Tailscale IP on port 3100.

Show the exact repository diff and test results. Ask before committing; installing the
current checkout does not require a commit.

### 4: install and validate

With the user's approval, run:

```sh
./deploy/local/install-macos.sh
```

The script may require the user to approve Tailscale HTTPS in a browser. It
must otherwise finish without a checklist of manual service-manager commands.

Verify:

```sh
"$HOME/Library/Application Support/Dormouse Server/bin/manage" verify
```

That command must perform, at minimum, the equivalent of:

```sh
launchctl print "gui/$UID/sh.dormouse.server"
curl --fail http://127.0.0.1:3100/api/hello
tailscale serve status
lsof -nP -iTCP:3100 -sTCP:LISTEN
```

Then, from another tailnet-connected device:

1. Request the HTTPS `/api/hello` endpoint.
2. Open the Pocket application at the same origin.
3. Temporarily leave Tailscale on that test device and verify it becomes
   unreachable.

Kill the server process once and verify LaunchAgent restarts it. Restart the
laptop only if the user approves the interruption; otherwise explain that
`RunAtLoad` plus the loaded LaunchAgent has been verified but the reboot test
was skipped. After a real login/reboot, verify both the process and background
Serve mapping return without rerunning the installer.

Complete Pocket passkey setup and Host enrollment using a standalone build
whose `DORMOUSE_REMOTE_CONNECT_SRC` includes `https://*.ts.net wss://*.ts.net`.
After `account.json` and `hosts.json` exist:

1. Record ownership and checksums without printing contents.
2. Rerun the same installer from the same or a newer checkout.
3. Confirm the release changed as expected and state/checksums survived.
4. Exercise the retained-release rollback and return to the desired release.

### 5: operational expectations and backup

Make these limitations explicit:

- The relay is unavailable while the Mac sleeps, is shut down, Tailscale is
  disconnected, or the user is logged out. A LaunchAgent is a per-login agent,
  not a pre-login system daemon.
- The installer does not follow `main`. To update: choose the checkout, inspect
  it, and rerun `./deploy/local/install-macos.sh`.
- The HTTPS origin is tied to the laptop's Tailscale node name. Do not rename or
  delete/re-enroll the node casually after registering passkeys.
- Tailscale network policy still controls which tailnet members can reach the
  laptop. Review existing grants if the tailnet contains other users.

Confirm that the install root, especially `config` and `state`, is covered by
Time Machine or another encrypted backup outside the laptop. A second directory
on the same disk is not a backup. Perform a small restore rehearsal without
overwriting live state.

Give the handoff and stop.

## Final handoff

Give the user a concise final report. Include:

- The Pocket URL and its WebAuthn-origin significance.
- The exact installed Git SHA and whether the build was dirty.
- Where runtime config, state, release metadata, and logs live.
- The rollback command.
- Backup status and restore location.
- Any skipped acceptance test or remaining manual Host/Pocket setup.
- That updates happen only when the user reruns
  `./deploy/local/install-macos.sh`, plus the sleep/shutdown/logout
  availability limitation.
- The installed `manage status`, `manage verify`, `manage logs`, and
  `manage restart` commands.

Do not print the setup password or any credential in the handoff.

## Official references

- Dormouse runtime and state contract: `docs/specs/server.md`
- Dormouse trust model: `docs/specs/remote-security-model.md`
- Standalone CSP override: `docs/specs/standalone.md`
- [Install Tailscale on macOS](https://tailscale.com/docs/install/mac)
- [Tailscale variants on macOS](https://tailscale.com/docs/concepts/macos-variants)
- [Manage scripts with launchd](https://support.apple.com/guide/terminal/script-management-with-launchd-apdc6c1077b/mac)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)

## Troubleshooting boundaries

- **Local install works only while the source checkout exists:** the LaunchAgent
  was pointed into the repository instead of the self-contained install root.
  Fix the installer; do not paper over it with a permanent checkout path.
- **Local LaunchAgent loops or will not load:** run `plutil -lint`, inspect
  `launchctl print gui/$UID/sh.dormouse.server`, and read the configured stdout
  and stderr files. Check absolute paths and permissions; launchd does not run
  the user's interactive shell startup files.
- **Local HTTPS URL returns 502:** first check the loopback health endpoint,
  then `tailscale serve status`. The LaunchAgent and Serve configuration have
  separate lifecycles.
- **Port 3100 is visible on LAN or the Tailscale IP:** stop and fix
  `DORMOUSE_BIND_HOST=127.0.0.1` before continuing. Tailscale access control is
  not a reason to expose the plaintext backend.
- **Local origin changed:** do not overwrite the stored origin and continue.
  Determine whether the Tailscale node was renamed/re-enrolled and plan passkey
  and Host re-enrollment explicitly.
- **Pocket loads but passkey setup fails:** compare the browser URL byte-for-byte
  with normalized `DORMOUSE_ORIGIN`; confirm HTTPS and the chosen node/Service
  hostname.
- **Host cannot connect while Pocket can:** the standalone Host likely lacks the
  `*.ts.net` `connect-src` custom build setting.
- **State disappears:** verify the absolute Application Support state path and
  the installed config. Do not initialize a new account until old state has been
  located or restored.

## Future

**Scope: always-on-relay** — run the coordinating server on a cloud host
instead of the laptop, so the relay stays reachable while the Mac is asleep,
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

Complete initial Pocket setup, then enroll a custom self-host standalone build.
After `account.json` and `hosts.json` exist:

1. Record their ownership and checksums without printing their contents.
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
Do not call a second directory on the same Droplet a backup. The two JSON files
contain Host bearer credentials even though passkey public keys are not secret,
so protect backup access accordingly.

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
automatic deployment trigger. Do not describe the laptop LaunchAgent as if it
were installed.

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
