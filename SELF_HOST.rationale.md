# Run the Dormouse Relay behind Tailscale — rationale

> Informative companion to [SELF_HOST.md](SELF_HOST.md): evidence keyed by that file's headings. Nothing here is normative.

## Prerequisites

Why the Linux operator grant is the only step that needs root: `tailscaled` exposes its local API over a root-owned socket, so an unprivileged `tailscale serve` is refused outright. `--operator=$USER` widens that socket to one account, which is a one-time administrative act rather than something an installer should take on itself.

## What the installer does

Why the logs sit outside the install root on macOS and Linux: each platform has a conventional log location a user already knows to look in (`~/Library/Logs/...`, `$XDG_STATE_HOME/dormouse-relay`), and `manage logs` would otherwise train people to look somewhere the OS's own tooling ignores. Windows has no such convention for a per-user service, so `logs` stays inside the root — which is why `purge` has to name the log directory separately on the other two.

Why `$XDG_STATE_HOME` rather than the install root on Linux: the install root is `$XDG_DATA_HOME` data that should survive and be backed up, while logs are regenerable state. Backing up the data directory then does not drag a log archive with it, which matters because checkpoint 6 asks the user to back that directory up.

## Checkpoint 3: verify

Why the Windows kill block selects by path rather than by `Name='node.exe'`: a developer machine routinely has several unrelated `node.exe` processes, and the `Dormouse Relay` command-line substring is not on the supervisor's own `powershell.exe`. Matching the install root against both `ExecutablePath` and `CommandLine` is the same predicate `Get-DormouseProcess` uses inside the installer, and the Mechanism map's "Stopping it" row says why image name is never enough.

## Invariants

Why 3100 rather than 3000: the number only has to be one a casual dev server is unlikely to take, and 3000 is the most contended port on a developer's machine. Nothing outside the installers depends on the number — `config/relay.env` carries it and every consumer reads it back.

## Mechanism map

Both Windows deviations are mechanism constraining one file, so the reasoning lives at the code: the comment above `Set-ReleasePointer` in `deploy/local/install-windows.ps1` for why the pointer is a file swapped with `rename(2)` semantics, and the header of the `run-relay.ps1` here-string in the same file for why Task Scheduler's restart-on-failure is not KeepAlive. What belongs here is only the consequence for the runbook: both rows of the mechanism map read as arbitrary Windows trivia unless you know neither has an unprivileged equivalent of the macOS mechanism, and `manage verify` reads the supervision loop out of the wrapper rather than trusting the task settings because the task setting is defence in depth rather than the mechanism.

## Mechanical traps

Why the pnpm workspace-state file has to be snapshotted: `pnpm deploy --prod --legacy` rewrites it to production mode, so an install run from a developer's checkout leaves that checkout unable to resolve dev dependencies until the next full `pnpm install`. A failed install does the same damage as a successful one, which is why the restore is on every exit rather than on the success path.

Why `mv -f tmp link` cannot swap `current`: with `link` an existing symlink to a directory, `mv -f` moves the source *into* that directory rather than replacing the link, and the old release stays selected with no error anywhere.
