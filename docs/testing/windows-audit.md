# Windows audit evidence

This runbook collects the remaining native evidence for [embargo issue 90](https://github.com/diffplug/dormouse-embargo/issues/90), from the November 2, 2026 red team's `verify/local-exec/VERIFIED.md` sections 7a–7d and `verify/remote-other/VERIFIED.md`. The completed investigation and accepted disposition are in [Windows verification, November 2026](./windows-audit-2026-11-11.md). The runner does not close issues automatically. The security contracts remain in `docs/specs/security-local.md` and `docs/specs/security-remote.md`.

## What the runner measures

| Question | Measurement | Limit |
| --- | --- | --- |
| Can another account write the live dor or peer pipe? | Start the actual source modules as a new standard account, prove same-account challenge receipt, then open each pipe for duplex access as a different standard account. Repeat with VS Code's Electron runtime when packaged capture is requested. | Only Windows access denied is a passing denial. A timeout or missing pipe is inconclusive. A successful open needs handshake/relay investigation; it is not by itself authenticated access. The fixture has no real terminals. |
| Do the installer's ACLs exclude another account? | Extract `Protect-Path` and both `Test-OwnerOnly` implementations from the shipped installer text. Exercise repeated protection unelevated, a file inheriting the directory ACL, an explicitly protected file, and rejection of an extra Users ACE. The second account tries read and write, with an intentionally accessible file as its positive control. | This tests the real ACL helpers and native enforcement, not Task Scheduler, a full installer run, or every persisted credential. |
| Does Git reach a share? | Create a synthetic local SMB share restricted to the owner account. Read its sentinel and run real Git against a planted gitfile as positive controls, then run `localGitRepository` on a UNC cwd, gitfile, include path, and symlink to that share. Save timestamps and a packet capture. | All refusals must pass, and the positive control must be visible in the capture before absence during the guarded window counts. Loopback SMB can evade capture on some Windows configurations; the packet-level negative remains inconclusive. A second-machine listener is needed only when that stronger measurement is required, not to negate successful functional checks. No off-machine share or real credential is used. |
| Does cmd prompt integration revive helper autorun? | The route was removed in `e797b0c82` (Terminal Context autorun removal). Existing helper regressions cover a stored command reaching no PTY write; the renderer has no autorun path. | This supersedes the report's automatic bare `git` hypothesis. It does not claim to have run Clink, nor to constrain programs the user's own prompt runs. |
| Do packaged hosts send traffic under Nowhere? | Copy installed Standalone, VS Code, and extension artifacts; use a new account and fresh VS Code profiles; capture Standalone first launch, an extension-free VS Code baseline, and VS Code with an explicitly activated Dormouse pane. Record process identities and TCP/UDP endpoints. | These are fresh-profile launches of packaged artifacts, not fresh installer executions. Record their versions/hashes separately from the source fixture. Capture review and both observed Nowhere settings are required; polling can miss short-lived sockets, and engine/system-service traffic can require further ETW attribution. |

The source fixture bundles the real control server, peer-link transport and Git guard. Its only replaced host API is VS Code's output channel. The kit records its source commit, dirty status, runtime and hashes; a source fixture does not establish that an older installed extension contains the same code.

## Prepare without elevation

From the worktree root, after `pnpm install`:

```powershell
$kit = Join-Path $env:TEMP ('dormouse-90-kit-' + [Guid]::NewGuid().ToString('N'))
pnpm exec node scripts/windows-audit/prepare.mjs $kit
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-audit/selftest.ps1 -Kit $kit
```

Preparation requires a new directory and does not overwrite another run. The self-test makes no account, share, capture, or app-state changes. It runs the ACL functions with the current token and proves the pipe/file probes succeed as that same account, so an always-deny probe cannot pass unnoticed. It also runs the child wrapper with native exits 0 and 7 and checks that a missing parent exit status is resolved only through the explicit worker result; missing, null or error records fail closed. It retains its synthetic evidence under the printed temporary directory.

## Run once as Administrator

Use Windows PowerShell 5.1. The prepared kit needs no package install or download. Supply absolute paths to Git for Windows and the three already-installed artifacts; the extension directory is the one containing `package.json` and `dist/extension.js`.

```powershell
& '<kit>\run.ps1' -GitExe 'C:\Program Files\Git\cmd\git.exe' -CapturePackaged -StandaloneDirectory '<directory containing dormouse.exe>' -CodeDirectory '<directory containing Code.exe>' -ExtensionDirectory '<installed diffplug.dormouse-version directory>'
```

The runner creates two expiring standard accounts named `dm90o<random>` and `dm90x<random>` and a `C:\ProgramData\DormouseAudit-<random>` evidence directory. It loads each account's own profile and resets inherited app/environment identity before launches. The source fixture's peer secret stays in an owner-only subdirectory; only pipe names are intentionally given to the other account. No real user's session, enrollment, or extension settings are used. It copies application directories without following junctions, changes no firewall rule, and removes its temporary SMB share, accounts, profiles and processes in `finally`. Evidence and copied artifacts remain in the printed directory. If interrupted forcibly or cleanup fails, `summary.json` identifies what remains; do not delete a profile or stop a process merely by a guessed name.

PktMon is machine-wide. The runner refuses existing filters and will not stop a collector it did not start. Filter-list recognition accepts the complete English empty-list replies `Packet Filters: None` and `No filters`, and fails closed on an unknown response, extra rows or a command error. Multi-file captures convert every phase-matching ETL segment and record their names in a segments manifest. Captures retain up to 128 bytes per packet and may include unrelated machine traffic; keep the raw evidence private. There is no automatic upload. If SMB setup fails, the report preserves its operation, source line and stack, marks that phase inconclusive, and proceeds to the independent packaged captures. Creating the directory symlink uses the Win32 directory flag without first inspecting the owner-only share as Administrator. If sharing is disabled or another collector is active, fix the test environment deliberately and rerun; the script does not alter those settings.

During the packaged phase, use only the newly opened temporary-account windows. Confirm Standalone's Settings → Network is Nowhere. In the second VS Code window, run **Dormouse: Focus**, then confirm Dormouse's network setting is Nowhere. The console asks for `NOWHERE` after each observation. Leave shells idle and do not enable networking features. VS Code's earlier baseline window has extensions disabled and is closed by the runner before the Dormouse window opens.

Omitting `-CapturePackaged` runs the source pipe, ACL and SMB checks only, and explicitly records packaged coverage as not run. A zero exit means collection finished with the checked pipe/file denials; it does not mean the issue is resolved.

## Review before closure

1. Require `summary.json` with no collection or cleanup error, different recorded owner/other SIDs, passing same-account controls, two cross-account pipe denials for each runtime, both cross-account read/write denials for protected files, and both accessible-file controls succeeding. Inspect `owner/acl.json` for the native DACLs and both readers' negative controls.
2. Require `owner/git.json` with the positive control completing and every guarded case refused. In the `smb*.pcapng` and ETL segments, identify the positive-control SMB traffic and compare the recorded guarded time window. A capture with no positive-control traffic cannot establish a packet-level negative; record the native functional results separately. The investigation’s disposition decides whether the narrower measurement is sufficient.
3. Require both Nowhere observations and the packaged artifacts' versions/hashes. Inspect all first-launch and activated captures against their process timelines and the extension-free VS Code baseline. Record destinations, owning processes, activation times and any attribution limits. Apply `docs/specs/security.md` -> "What is not defended" to independently initiated host/runtime activity. A suspected Dormouse request needs attribution; an empty capture without capture-health evidence is not a passing negative.
4. Record the source commit, packaged versions, Windows build, command, outcomes and limitations in a dated private verification report. Fix any demonstrated break and rerun the relevant check. Merge the evidence/tooling PR, then close the finding with the PR and recorded disposition. Do not convert an unrun or inconclusive item into a pass.

## Development checks

```powershell
node --test standalone/sidecar/helper-terminal.test.js standalone/sidecar/dor-control-server.test.js
pnpm --filter dormouse-lib exec vitest run src/lib/helper-terminal.test.ts
node scripts/md-unwrap.mjs
```

Run the prepared kit's self-test after changing the fixture, account probe or installer extraction. Parse every PowerShell script with `System.Management.Automation.Language.Parser` before handing off an elevated run. The full elevated path must still be run on Windows; a parser check and same-account test do not validate cross-account process creation, SMB availability, packaged activation or cleanup after a privileged run.
