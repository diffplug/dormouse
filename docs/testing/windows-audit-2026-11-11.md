# Windows verification, November 2026

## Disposition

The November red team's Windows verification finding ([embargo issue 90](https://github.com/diffplug/dormouse-embargo/issues/90)) is resolved by native evidence, removal of the hypothesized helper execution route, and the maintainer's acceptance of the host/runtime boundary in `docs/specs/security.md` -> "What is not defended". No Dormouse security break was demonstrated. Closure follows the evidence/tooling PR merging; this is not a claim of zero packets from the machine or exhaustive verification of every Windows configuration.

The original report was informational: five questions remained unverified, not five demonstrated vulnerabilities. The disposition accepts the measurement limits below, including the unavailable packet-level SMB negative. Those limits alone do not require another investigation. New behavior or evidence of a contract violation can reopen the relevant question; another auditor lacking a Windows machine, or seeing unattributed host traffic, does not invalidate this run. Examples of new evidence include a second account reaching protected state, a guarded Git operation reaching a share, restoration of automatic helper execution, or a Dormouse-initiated request bypassing Nowhere.

## Results

| Original concern | What was observed | Disposition and limit |
| --- | --- | --- |
| Peer and dor pipe DACLs across accounts | Each live source server accepted its own account's connection and returned a challenge. A different standard account's duplex opens failed with Windows access denied (error 5), for both pipes under pinned Node and VS Code's Electron runtime. | Passed for the tested runtime/token defaults. No second-account write or handshake-relay route was demonstrated. This does not add a custom pipe ACL or change the documented Windows pipe risks. |
| Installer ACLs | The real installer's `Protect-Path` ran repeatedly without elevation. Both `Test-OwnerOnly` readers accepted explicit and inherited owner-only ACLs and rejected an extra Users ACE. The second account could neither read nor write protected files, but could do both to an intentionally accessible control. | Passed for the actual ACL helpers and native enforcement. Not a full installer or Task Scheduler execution. |
| Git for Windows contacting a share | The owner read a sentinel over a synthetic SMB share, and direct Git followed a planted gitfile to its repository. The actual `localGitRepository` guard refused a UNC cwd, planted gitfile, config include, and native directory symlink to the share. | Native functional checks passed. The local SMB positive control was invisible to PktMon, so the capture cannot establish a packet-level negative. The maintainer accepted the functional evidence together with removal of the automatic helper route. |
| cmd with an integrated prompt | Commit `e797b0c82` removed Terminal Context autorun. The current helper has no automatic PTY-write path, and the stored-command regression passed. | The report's automatic bare-Git execution hypothesis is superseded. Clink and the C1 prompt experiment were not separately exercised; the user's own prompt programs are outside this route. |
| Packaged apps under Nowhere | The user observed Nowhere in fresh-profile Standalone and an activated Dormouse VS Code pane. WebView2-owned outbound TCP sockets matched captured traffic. The extension-free VS Code baseline already performed update downloads; VS Code-owned network activity also occurred with Dormouse. | No Dormouse policy bypass was demonstrated. Apply the accepted boundary in `docs/specs/security.md` -> "What is not defended". Individual runtime packets were not all attributed to a service or purpose, and snapshots cannot exclude short-lived sockets. |

## Provenance

The native run began on 2026-11-11 at 23:33 UTC and continued into November 12 UTC, on Windows 11 Pro x64, version 10.0.26300. Two new standard local accounts supplied distinct owner and adversary identities. The collection completed with no recorded cleanup errors; the temporary accounts and share were removed. Both Nowhere confirmations were supplied by the operator after observing the app.

The source fixture used commit `9a7a1610267ee596780bcd64b056b0f58b781dd9` plus the then-uncommitted audit tooling. It bundled the actual peer transport, dor control server, and Git guard; only VS Code's output-channel API was replaced. The prepared kit retains its provenance and SHA-256 manifest. Its runtime was Node 24.22.2; the Electron repeat used Node 24.18.1. The installer source SHA-256 was `e5cb9326006fa0add9928880b6a14c9b7fb363ed91c1b0740b298a225bcf335f`.

Packaged checks used installed Standalone 1.3.0, VS Code 1.137.0, and Dormouse extension 1.3.0, copied into the isolated runner. These were fresh-account/profile launches, not fresh installer executions. They are separate evidence from the source fixture, not proof that the older packaged extension contains every source change. The following artifact hashes were unchanged after collection:

| Artifact | SHA-256 |
| --- | --- |
| Standalone `dormouse.exe` | `716EEC5E5E641B68D73BD2DD4951C27122D05E0F94CD1A94423406F11E98C4F5` |
| VS Code `Code.exe` | `C933B1301979ABB102DED0B5C28C5C417FCB09411B15F5FF2484C8BB896CF9EF` |
| Extension `package.json` | `0A9493CCA4DDF95D0CAF1B241B4CACD7C56E2298E6CC19EDAF97BDFFB5963F98` |
| Extension `dist/extension.js` | `8BD895CFC05B1B46F1CE82EB1531D38FE1D6679A0A2703D7E73F7DC547ED9DD6` |

## Evidence and capture limits

Raw evidence remains private in `C:\ProgramData\DormouseAudit-f993881225`; no raw capture was uploaded. `summary.json` deliberately says collection finished but the issue is not yet cleared: the runner cannot make the review/disposition decision. This report records that subsequent decision.

- Pipe and ACL records: `owner/pinned-node-pipes.json`, `owner/electron/pipes.json`, `owner/acl.json`, `other/cross-account.json`, `other/electron-cross-account.json`, and the accompanying identity/completion records.
- Git records: `owner/git.json`, `smb*.pcapng`, and the SMB start/stop and segment records. The positive-control window was 23:33:44.827–44.866 UTC; guarded calls ran at 23:33:46.375–46.389. None of the 304 captured component events showed decoded TCP/445 or an SMB header, and the last preceded the guarded window. This is a capture-visibility limit, not a passing no-contact measurement.
- Packaged records: `artifacts.json`, `windows.json`, phase process timelines, app logs, and all numbered `standalone-first-launch*`, `vscode-baseline*`, and `vscode-first-launch*` capture segments. The final `vscode-activated-processes.jsonl` follows the explicit activation and Nowhere observation.

PktMon had no filters and reported no lost collection events; every numbered ETL segment was converted. Captured frames are truncated to 128 bytes and can repeat across components. Offline review checked PCAPNG block lengths and timestamps and matched process-owned TCP tuples to captured SYN and payload events. Not every frame representation was decoded. No destination hostname or exact WebView2 service was established; calling those particular packets telemetry or component updates would exceed the evidence. No outbound socket was observed for the Standalone executable or its Node sidecar in snapshots, which is not proof that none could exist between samples.

The original sampler's per-process owner lookups left substantial gaps (60 samples took roughly 17 minutes). The checked-in runner now caches identities by PID and creation time and bounds collection by elapsed seconds; a three-second local check completed in 3.2 seconds. That improvement does not retroactively increase this run's sampling resolution.

See [the Windows audit runbook](./windows-audit.md) for reproduction and the distinction between collection, review, and closure. The dated observations above establish this investigation's scope; the security specs remain the current contracts.
