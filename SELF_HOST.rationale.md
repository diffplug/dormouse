# Run the Dormouse Relay behind Tailscale — rationale

> Informative companion to [SELF_HOST.md](SELF_HOST.md): evidence keyed by that
> file's headings. Nothing here is normative.

## Prerequisites

Why the Linux operator grant is the only step that needs root: `tailscaled`
exposes its local API over a root-owned socket, so an unprivileged
`tailscale serve` is refused outright. `--operator=$USER` widens that socket to
one account, which is a one-time administrative act rather than something an
installer should take on itself.

## What the installer does

Why the logs sit outside the install root on macOS and Linux: each platform has
a conventional log location a user already knows to look in
(`~/Library/Logs/...`, `$XDG_STATE_HOME/dormouse-relay`), and `manage logs`
would otherwise train people to look somewhere the OS's own tooling ignores.
Windows has no such convention for a per-user service, so `logs` stays inside
the root — which is why `purge` has to name the log directory separately on the
other two.

Why `$XDG_STATE_HOME` rather than the install root on Linux: the install root
is `$XDG_DATA_HOME` data that should survive and be backed up, while logs are
regenerable state. Backing up the data directory then does not drag a log
archive with it, which matters because checkpoint 6 asks the user to back that
directory up.

## Checkpoint 1: preflight

Why the dev-Relay note no longer names a port: `relay/scripts/dev.mjs` reads an
unset, blank, or `0` `PORT` as "any free port", so a developer running
`pnpm dev:relay` does not contend for 3100 at all unless they ask to. The older
text claimed `PORT=3000 pnpm dev:relay` pinned the dev Relay to 3000, which is
true of that exact invocation but not of the default, and read as though 3100
existed to dodge 3000.

## Checkpoint 3: verify

Why the Windows kill block selects by path rather than by `Name='node.exe'`: a
developer machine routinely has several unrelated `node.exe` processes, and the
`Dormouse Relay` command-line substring is not on the supervisor's own
`powershell.exe`. Matching the install root against both `ExecutablePath` and
`CommandLine` is the same predicate `Get-DormouseProcess` uses inside the
installer, and the traps below say why image name is never enough.

## Invariants

Why 3100 rather than 3000: the number only has to be one a casual dev server is
unlikely to take, and 3000 is the most contended port on a developer's machine.
Nothing depends on the value — `config/relay.env` carries it and every consumer
reads it back — so this is a default, not a constraint.

Why a failed restore must not clear `previous`: `rollback_release` re-reads
`current` before deciding, and its call sites use `|| true`, which disables
`errexit` for that command. Without the re-read a restore that never landed
would still strip the rollback pointer, leaving an install running the rejected
release with nothing to roll back to.

## Mechanism map

Both Windows deviations are mechanism constraining one file, so the reasoning
lives at the code: the comment above `Set-ReleasePointer` in
`deploy/local/install-windows.ps1` for why the pointer is a file swapped with
`rename(2)` semantics, and the header of the `run-relay.ps1` here-string in the
same file for why Task Scheduler's restart-on-failure is not KeepAlive. What
belongs here is only the consequence for the runbook: both rows of the
mechanism map read as arbitrary Windows trivia unless you know neither has an
unprivileged equivalent of the macOS mechanism, and `manage verify` reads the
supervision loop out of the wrapper rather than trusting the task settings
because the task setting is defence in depth rather than the mechanism.

## Mechanical traps

Why the pnpm workspace-state file has to be snapshotted: `pnpm deploy --prod
--legacy` rewrites it to production mode, so an install run from a developer's
checkout leaves that checkout unable to resolve dev dependencies until the next
full `pnpm install`. A failed install does the same damage as a successful one,
which is why the restore is on every exit rather than on the success path.

Why `mv -f tmp link` cannot swap `current`: with `link` an existing symlink to a
directory, `mv -f` moves the source *into* that directory rather than replacing
the link, and the old release stays selected with no error anywhere.

Why `(Get-Command pnpm).Source` is the wrong resolution: PowerShell prefers the
`.ps1` shim, which is a script rather than an image and cannot be launched as a
process, so every invocation failed with a message about the shim rather than
about pnpm.

Why the `DBUS_SESSION_BUS_ADDRESS` failure is caught in preflight: under `su`,
or anywhere no user manager runs for this uid, `systemctl --user` fails with a
message that names the missing variable and nothing a user can act on — after
the unit has already been written.

Why systemd 240 is the floor: `StandardOutput=append:` arrived in 240. Older
versions accept the unit and truncate the log on every restart, so `manage
logs` would show only the current run and a crash loop would look like a single
clean start.

Why the Windows cmdlet lint exists at all: no job in CI has a PowerShell, so
`deploy/local/install-windows.ps1` has no syntax gate but
`scripts/ps1-cmdlet-lint.mjs`. A repo-wide rename of the project's vocabulary
once rewrote all 147 `Write-Host` calls in that file to `Write-Burrow`, which
nothing caught until someone ran the installer.
