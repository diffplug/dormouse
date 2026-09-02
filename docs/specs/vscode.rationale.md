# VS Code Host — Rationale

> Informative companion to [vscode.md](vscode.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Serialization and restore

**The shutdown budget is not ours.** VS Code kills the extension host on a deadline the extension does not control, and in practice it has never once let `[deactivate] done` print (2026-08). That is why every wait in the sequence is bounded and why the one step whose data cannot be reconstructed afterwards runs first.

**Why the recovery record is not `workspaceState`.** Writing it there was tried and measured (2026-08): detection completed and the record was never written — the state store's SQLite flush is already tearing down while `deactivate()` runs.

## Capturing agent recovery

**Why `^C` and not a signal.** SIGTERM to the pty leader is inert against both claude and codex, and the foreground-process-group signal that does reach claude leaves codex silent (2026-08). Writing `^C` into the pty is the one gesture both agents answer.

**Two settle-on-quiet heuristics died on the same fact.** Codex says nothing for ~250 ms and then prints its entire shutdown at once, so a poll that treats silence as completion exits before codex has spoken. Both attempts to settle early on quiet lost the hint that way; the only sound early exit is having nothing left to wait for.

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

Rows 1–2 are why a blanket second press is wrong; `Press Ctrl-C again` was absent from every codex cell, which is why an ask-gated second press can only ever serve claude. Press-wait-press with a ~600 ms fallback is the only gesture that covers both, and the 262 ms idle case leaves the retry set before that fallback fires. Confirmed end to end in a real pane: fallback press at +625 ms, hint at +789 ms, applied on the next activation.

## CSP policy

**What the smoketest caught** (2026-08). The code-split CSP failure was invisible to string inspection and produced only a blank panel plus `script-src-elem` violations in the webview console. `webview-boot.smoketest.ts` is the check that would have caught it: reproducing the pre-fix document makes it fail on all four of its assertions with exactly those violations.

**Why a fixture is not enough.** `webview-html.test.ts` feeds the transform a fixture of real Vite output, which is the limit of what it can prove: it cannot notice Vite emitting a shape nobody anticipated. That is the gap `webview-boot.smoketest.ts` exists to cover.

**`'strict-dynamic'` could not be shown load-bearing by experiment.** With the `<meta property="csp-nonce">` in place, Vite's runtime preload helper nonces the `<link>` it injects ahead of a lazy `import()`, which populates the module map and lets the import resolve — including with `build.modulePreload` disabled (2026-08). The directive is kept anyway because that is an emergent interaction between a bundler's preload helper and the module map, not a policy guarantee.

## Webview message authentication

**Why a token rather than `event.source` / `event.origin`.** A source check would have to assert something about VS Code's internal webview frame topology, which is undocumented and can change between releases. A token depends on nothing but itself.

**Why not reuse the CSP nonce.** The two answer different questions — the nonce authorizes script execution, the token authenticates a message sender — and conflating them makes both harder to reason about, even though both are minted the same way and live in the same injected markup.

## Remote Host: a service in the extension host

**Where the `WebSocket` boundary falls.** `globalThis.WebSocket` arrived in Node 22, and VS Code 1.85 — the floor `engines.vscode` declares — shipped Node 18, so an older extension host has no global to use at all.

## Peer surfaces across windows

**Why `pushDevices` answers `null` instead of refusing.** When an un-enrolled window refused the read-only commands, the Settings dialog reported an unreachable server on machines that had simply never enrolled. Answering exactly what an idle service answers keeps "nowhere to push" distinguishable from "the server could not be asked".

## Build and development

**Why the separate typecheck is wired into `test`.** A reference to a deleted function once reached a commit and surfaced only as a runtime throw during `deactivate()`, which skipped every teardown step behind it. `tsc` is the package's only automated check for that class of error, so it has to run somewhere the root `pnpm test` reaches.
