# VS Code Host — Rationale

> Informative companion to [vscode.md](vscode.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Surfacing union status on native chrome

**Why `view.title` cannot carry the status.** The view's own title never surfaces on a single-view bottom-panel container, which leaves the badge as the only runtime indicator this hosting primitive exposes — hence presence-only where the editor tab can spell out `🔔` and `[TODO]`.

## Serialization and restore

**The shutdown budget is not ours.** VS Code kills the extension host on a deadline the extension does not control, and in practice it has never once let `[deactivate] done` print (2026-08).

**Why the recovery record is not `workspaceState`.** Writing it there was tried and measured (2026-08): detection completed and the record was never written — the state store's SQLite flush is already tearing down while `deactivate()` runs.

## Capturing agent recovery

**Why `^C` and not a signal.** SIGTERM to the pty leader is inert against both claude and codex, and the foreground-process-group signal that does reach claude leaves codex silent (2026-08). `^C` is the one gesture both agents answer; it needs no `tcgetpgrp` and no master fd node-pty does not expose, takes the same path on ConPTY, and leaves the shell alive.

**Why every live PTY is interrupted.** Gating on "is this pane running an agent" would need per-pane foreground-command knowledge the host does not have, and every one of these processes is killed seconds later regardless.

**Why the clocks start at the ack.** The ~600 ms fallback and the ~200 ms silence window are statements about the agent, not about the round trip; measuring from step entry folds the interrupt's own latency into the window and shortens it by an amount that varies with load.

**Why the ask gate keys on an English UI string.** `Press Ctrl-C again` is claude's wording and could change. That failure is visible and recoverable — claude's recovery is lost for that shutdown — where a mistimed second press destroys codex's hint every single time.

**Two settle-on-quiet heuristics died on the same fact.** Codex says nothing for ~250 ms and then prints its entire shutdown at once, so a poll that treats silence as completion exits before codex has spoken; both attempts to settle early on quiet lost the hint that way. Polling to the ceiling instead costs nothing, the record being written the moment each command is found.

**Why widening the scan is not a free optimisation.** Scanning the whole buffer let a stale hint or an old launch echo win. The narrow scan also fails in the safe direction: buffer eviction can only discard fresh output, never promote stale output as fresh.

**Where a missing hint comes from.** A Dormouse launched from inside a Claude Code session inherits `CLAUDE_CODE_CHILD_SESSION`, which disables transcript saving in claude, so it legitimately prints nothing to record.

**The timing measurements** (real pty, codex, 2026-08). Codex is the constraining case because its `^C` is consumed by the input line first:

| State when interrupted | Gesture | Hint | At |
| --- | --- | --- | --- |
| idle after a pause | one `^C` | yes | 262 ms |
| idle after a pause | two `^C`, 150 ms apart | **no** | — |
| idle after a pause | `^C`, 800 ms, `^C` | yes | 855 ms |
| unsent text in the input | one `^C` | **no** | — |
| unsent text in the input | two `^C`, 150 ms apart | yes | 464 ms |
| unsent text in the input | `^C`, 800 ms, `^C` | yes | 1061 ms |
| freshly launched, no conversation | one `^C` | no — correctly, nothing to resume | — |

Rows 1–2 are why a blanket second press is wrong; `Press Ctrl-C again` was absent from every codex cell, so an ask-gated second press can only ever serve claude. The 262 ms idle case leaves the retry set before the ~600 ms fallback fires. Confirmed end to end in a real pane: fallback press at +625 ms, hint at +789 ms, applied on the next activation.

## CSP policy

**Why Vite stamps the nonce rather than a post-hoc rewrite.** Vite walks its own output with a real HTML parser, so coverage follows the shape it actually emitted — a regex over the document only covers the tags whoever wrote it thought of.

**How a CSP failure presents, and what caught the last one** (2026-08). Remote from its cause: a blank panel, or a render error naming a chunk that is sitting on disk. Nothing reaches an extension-host log and the extension activates normally, so the only direct evidence either way is a CSP violation in the webview console (**Developer: Open Webview Developer Tools**) — which is all the code-split failure produced, `script-src-elem` violations and a blank panel. Reproducing that pre-fix document makes `webview-boot.smoketest.ts` fail on all four of its assertions with exactly those violations.

**Why a fixture is not enough.** `webview-html.test.ts` can prove the transform right only for the Vite output it was handed; it cannot notice Vite emitting a shape nobody anticipated. That is the gap `webview-boot.smoketest.ts` exists to cover.

**`'strict-dynamic'` could not be shown load-bearing by experiment.** With the `<meta property="csp-nonce">` in place, Vite's runtime preload helper nonces the `<link>` it injects ahead of a lazy `import()`, which populates the module map and lets the import resolve — including with `build.modulePreload` disabled (2026-08). That is an emergent interaction between a bundler's preload helper and the module map, not a policy guarantee.

## Webview message authentication

**What a forged message would buy.** A `writePty`: `dor:controlRequest` becomes a `dormouse:control-request` event that `use-dor-control.ts` can turn into one, and the `pty:*` family drives what the user sees in a terminal.

**Why a token rather than `event.source` / `event.origin`.** A source check would have to assert something about VS Code's internal webview frame topology, which is undocumented and can change between releases. A token depends on nothing but itself.

**Why not reuse the CSP nonce.** The two answer different questions — the nonce authorizes script execution, the token authenticates a message sender — and conflating them makes both harder to reason about, though both are minted the same way, live in the same injected markup, and are equally unreachable from a cross-origin frame.

## Remote Host: a service in the extension host

**Why every enrolled window cannot just start a Host.** They would all connect `/ws/host` against the same enrollment; the server closes the displaced socket (`server/src/relay.ts`), whose `close` handler reconnects and displaces the next one — and each window arms its own alarm push meanwhile.

**Why the socket path is hashed.** macOS caps a unix socket path near 104 bytes, and `context.globalStorageUri.fsPath` is most of that on its own — joining a name onto it overflows.

**Why the store's interface is async.** The service reads enrollment and ACL in-process, but the places that state lives — `SecretStorage`, `globalState` — are async, so `HostStateStore` is too. The enrollment memo exists because `SecretStorage` is a keychain round trip and both the activation probe and the service want the same answer.

**Why the memo must be dropped on any window's change.** Without it a window promoted to broker could resurrect an enrollment another window had cleared, or never see one another window had just created — `SecretStorage` is shared across all of an extension's windows.

**Why roles never flip downward.** A TTL lease has a class of mid-transition race that has to be handled rather than excluded: start serving, lose the lease, tear down, win it back while still tearing down.

**Why the reclaim is jittered and re-dialled.** Every client of a dead broker reaches the `ECONNREFUSED` at the same instant. Unlinking immediately means several of them unlink, and unlinking a *live* broker's socket — one that rebound the path while we waited — strands every window dialling it.

**Why `stillOurs` compares full filesystem identity.** Two windows can find the same corpse, both unlink, and the second bind silently displaces the first, leaving the loser serving a socket no client can reach; nothing on the bind path detects that. Inode alone is reused too readily to distinguish "still ours" from "replaced".

**What an unverified bind would cost.** During `RECLAIM_VERIFY_MS` the socket is bound but may still be given up. A command landing inside that window and told "broker" would start a service the stand-down path never tears down — two Hosts under one hostId, and the endless relay displacement above.

**Why `listen`-time errors are logged rather than thrown.** The sockets already accepted are unaffected by an accept-time failure, and a listener that has genuinely died is noticed by the windows that can no longer reach it.

**Why an empty token read must be waited out.** An empty `serverToken` fails the hello check for every peer, and a broker never re-reads the token, so a window that adopted `''` would refuse the whole installation for its lifetime while every other window retried at `RETRY_MS` forever.

**Why exhausting that wait latches a permanent stand-down.** The exclusive create answers `EEXIST` for a token path that is a *directory* or unreadable as readily as for one another window owns, so the remaining cases are a crash-left zero-length file or a `globalStorageUri` this process cannot read — and retrying either would make every command wait out its queue budget on every attempt.

**What squatting the socket path buys.** One HMAC over a nonce the squatter chose — which is not the token — and nothing else.

**Why a mid-contention command waits rather than being refused.** While the contention runs the window is neither broker nor client, and a bind plus a handshake is not instant. Refusing there would tell an enrolled machine's webview it has no Host seconds before it gets one, and the gates that arm on that answer (`enrolled-gate.ts`) would stay down.

**Where the `WebSocket` boundary falls.** `globalThis.WebSocket` arrived in Node 22, and VS Code 1.85 — the floor `engines.vscode` declares — shipped Node 18, so an older extension host has no global to use.

## Peer surfaces

**Why installing the responder is keyed by the link.** Each install adds a `status` subscription, and each arming under it adds pane-state, activity, and focus listeners with no handle left to remove them. A flag would be wrong because the platform adapter, not the module, is what owns a link.

**Why a late answer invalidates instead of being dropped** (the rule is `docs/specs/remote-api.md` → Directory; every ask bridge shares it). It arrives after the Host has already rendered a directory missing whatever that answerer owns — an empty picker on a machine that does have terminals — and nothing can re-open a settled request. Without the invalidation an idle machine has no other reason to re-collect, so the phone's picker stays wrong indefinitely.

## Peer surfaces across windows

**Why a raw `ptyId` cannot key a route.** "Duplicate Workspace in New Window" cold-restores identical surface and PTY ids into several windows; a `ptyId → latest answering peer` table would then acknowledge the first surface answer while streaming and writing to the last.

**Why the route outlives the last unsubscribe.** Re-attaching an already-attached surface resolves the new route first and only then tears the old attachment down, so dropping the route on unsubscribe would delete the fresh one and strand every later write.

**Why a result is never broadcast when a route exists.** Ids are globally unique, so broadcasting another window's answer settles nothing anywhere — and it puts that window's Host state in front of webviews that never asked for it.

**Why `pushDevices` answers `null` instead of refusing.** When an un-enrolled window refused the read-only commands, the Settings dialog reported an unreachable server on machines that had simply never enrolled.

## Build and development

**Why the separate typecheck is wired into `test`.** A reference to a deleted function once reached a commit and surfaced only as a runtime throw during `deactivate()`, which — having no `try`/`catch` — skipped every teardown step behind it. `tsc` is the package's only automated check for that class of error.
