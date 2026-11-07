# State-machine audit

This is the inventory and evidence ledger for the November 2026 audit, starting at `a9630b630`. Behavioral authority stays in the linked owning specs; this file records coverage and findings, not a second contract. No GitHub issues are created. Fixes are grouped by root cause in separate commits within one PR.

## Method and coverage

Inventory means a lifecycle was identified, traced means its state and callers were read, and verified means the named adversarial sequences were exercised. None means exhaustive verification of a subsystem. Independent axes stay separate; the audit checks the constraints between them. A suspicious combination is a hypothesis until a reachable caller sequence and an observable violation establish it. A regression must fail on the original implementation and pass with its fix. Unchanged existing tests are evidence only once run.

| Machine or interacting group | Owning spec | Starting point | Coverage |
|---|---|---|---|
| Session Process / Registry / View / Link / Activity / Snapshot | `docs/specs/glossary.md` → Layers, Invariants | `lib/src/lib/terminal-lifecycle.ts` | Inventory; cross-axis vocabulary read |
| Dirty generations, Wall save queue, Window persistence | `docs/specs/layout.md` → Session persistence | `lib/src/components/wall/use-session-persistence.ts` | Traced; relevant existing tests passed in the full gate |
| PTY collection, retry, resume versus restore | `docs/specs/transport.md` → Reconnection protocol | `lib/src/lib/reconnect.ts` | Traced; relevant existing tests passed in the full gate |
| Workspace transfer, adoption, hand-back | `docs/specs/standalone.md` → Arrival queue | `standalone/src/workspace-move.ts` | Traced; relevant existing tests passed in the full gate |
| Workspace close, pending kill, reopen | `docs/specs/reopen.md` | `lib/src/components/wall/workspace-lifecycle.ts` | Verified SM-02 interleavings; lifecycle table added |
| Quit votes, per-window close, teardown arbitration | `docs/specs/standalone.md` → Quit flow | `standalone/src/quit.ts` | Webview arbitration traced; Rust model sampled; existing tests passed |
| Update check, approval, download, install, notice | `docs/specs/auto-update.md` | `standalone/src/updater.ts` | Verified SM-01 interleavings; approval/download table added |
| Tool declaration, serving, navigation, dirty saves | `docs/specs/dor-tool.md` | `lib/src/components/wall/use-tool-serving.ts` | Inventory; editor save/consent fences traced in `lib/src/lib/tool-editor.ts` |
| Tool stop, reap, rehydrate | `docs/specs/dor-tool.md` → Reaping | `lib/src/components/wall/tool-reaper.ts` | Traced; relevant existing tests passed in the full gate |
| Helper creation, promotion, reset, source close | `docs/specs/terminal-context.md` | `lib/src/lib/helper-terminal.ts` | Traced; existing tests passed; no new failure established |
| Alert interacting machines, await, delivery | `docs/specs/alert.md` → State machines | `lib/src/lib/alert-manager.ts` | Existing complete model read; implementation unverified |
| Command lifecycle and terminal escape parsing | `docs/specs/terminal-state.md`; `docs/specs/terminal-escapes.md` | `lib/src/lib/terminal-state.ts` | Inventory |
| Lath structure, parking, selection and input mode | `docs/specs/tiling-engine.md`; `docs/specs/layout.md` | `lib/src/components/wall/lath-wall-engine.ts` | Inventory |
| Browser provider lifetime and render swaps | `docs/specs/dor-browser.md` → Browser Connection | `lib/src/components/wall/agent-browser-surface-controller.ts` | Sampled explicit phase model and host viewport serialization; existing tests passed |
| Burrow service lifecycle, policy, revocation saves | `docs/specs/remote-security-model.md` | `lib/src/host/remote/service.ts` | Inventory; disposal guards sampled |
| Pairing, connection, presence and session authorization | `docs/specs/remote-security-model.md` | `lib/src/remote/burrow/` | Inventory |
| Direct-path negotiation and transport switching | `docs/specs/remote-api.md`; `docs/specs/remote-security-model.md` | `lib/src/remote/direct/` | Inventory |
| One-time connection lifetime | `docs/specs/one-time.md` | `lib/src/remote/one-time-app/` | Inventory |
| Pocket connection and remote PTY lifecycle | `docs/specs/pocket-app.md` | `lib/src/remote/client/remote-adapter.ts` | Attach generations and serial detach sampled; connection ceremony unreviewed |
| Frame request admission and cancellation | `docs/specs/remote-api.md` → Frames | `lib/src/remote/client/frame-client.ts` | Verified SM-03 interleavings and tunnel integration; admission table added |
| Relay routing and Hosted account lifecycle | `docs/specs/relay.md`; `docs/specs/hosted.md` | `relay/`; `hosted/` | Inventory |

Directories in inventory-only rows are discovery boundaries, to be narrowed to entrypoints when traced. Security changes also defer to the owning `security*.md` checks; this audit does not independently rewrite their properties.

## Findings

| Priority within this audit | Finding | Fix commit |
|---|---|---|
| 1: teardown and persistence ordering | SM-02 | `168cf353c` |
| 2: cancellation can remain unresolved indefinitely | SM-03 | `042d72bc3` |
| 3: stale update status hides a valid action | SM-01 | `c95b8d97f` |

### SM-01: an obsolete manual check replaces an approved update notice

Impact: misleading update status and loss of the visible Restart now action; the approved download itself remains pending. Confirmed by two failing regressions on the original implementation in `standalone/src/updater.test.ts`.

Sequence: Check now returns no update → app-version lookup waits → a second Check now finds an update → approve and finish its download → the first lookup resolves → the old completion replaces `downloaded` with `up-to-date`. Dismissing during the lookup is also undone. The async continuation in `runManualCheck` did not check whether it still owned the notice.

Fix: use the checking notice's identity to fence its empty-result and error continuations. The timestamp still records a successful check; approval and install state are independent. Contract: `docs/specs/auto-update.md` → Update notice in the Baseboard. Status: fixed; all 79 updater tests pass, including both regressions.

### SM-02: quit overlooks a Workspace finalizer already running

Impact: teardown can capture or persist work whose pending close has not settled; a refused close can restore a Workspace after quit has begun. The countdown removes its record before awaiting `closeAll`; `finalizePendingKills` sees an empty queue and resolves while that close is outstanding. The original regression in `lib/src/lib/pending-kills.test.ts` fails because drain completes before the deferred finalizer.

Callers: `expire` → `finalizePendingKill`; `runQuitTeardown` / `runCloseTeardown` → `finalizePendingKills`; `pendWorkspace` supplies the asynchronous finalizer. Contract: `docs/specs/reopen.md` → Labs: No-confirm delayed kill. Fix: retain finalizing entries separately from the undo list, let drains join their promises, and promote their context to teardown before awaiting them. `pendWorkspace` reads that context after its close answers. Scoped drains leave unrelated Workspaces alone. Status: fixed; 88 pending-kill/Workspace/overlay tests and 45 standalone teardown tests pass.

### SM-03: a cancelled queued frame request waits for unrelated traffic

Impact: a remote page's abandoned requests can remain unresolved indefinitely behind another frame's stalled HTTP responses, including after their own frame closes. Fill the shared HTTP slots → queue a request → abort it, or close its frame while the slots belong to a different frame. `Gate.acquire` had no cancellation path, and the request checked cancellation only after a slot was released. Two regressions in `lib/src/remote/client/frame-client.test.ts` fail on the original code before any occupied slot is released.

Fix: remove aborted waiters from the admission queue and connect queued requests to their frame's lifetime. Admission removes cancellation listeners; cancellation consumes no slot and sends no HTTP request. Contract: `docs/specs/remote-api.md` → Frames. Status: fixed; all 15 frame-client tests pass, including real HTTP/WebSocket tunnel tests and both cancellation regressions.

## Reviewed candidates without a confirmed defect

- A late Wall save after Surface ownership changes: the Workspace revision fence suppresses publication; the move publishes both ownership records synchronously. Dirty generations preserve observed changes during capture. The capture model is in `docs/specs/layout.md` → Session persistence.
- Retrying a failed native save with unchanged JSON: the store compares the cache and last successful value separately, so it retries after failure. Queued writes remain serialized and drain includes follow-ups. The pipeline model is in `docs/specs/standalone.md` → Persistence.
- Concurrent PTY collectors or replies from before reload: request tokens distinguish collections and each retry; the absence of a list differs from an accepted empty one. `lib/src/lib/reconnect.test.ts` already exercises these schedules. The outcome table is in `docs/specs/transport.md` → Reconnection protocol.
- Out-of-order viewport writes: the webview alone looked vulnerable, but `writeViewport` in `lib/src/host/browser-host.ts` serializes provider writes and checks lifecycle generations before and after them. No confirmed failure was inferred from the webview alone.
- Tool stops that finish after Session replacement: `stopTool` checks registry-entry identity before reaping. Editor close acknowledgements are separately fenced by prompt identity; a cancelled save cannot settle the next prompt. Existing regression tests passed.

## Validation and limits

- Root `pnpm test` passed: repository checks and lint isolation self-tests, audit tooling tests, package suites, and library typecheck/tests; the library suite reports 6,863 passing tests and 24 skipped tests in 2 skipped files.
- Standalone `pnpm --filter dormouse-standalone exec tsc --noEmit -p .` passed separately; its ordinary test script does not type-check.
- Each confirmed finding has a regression observed failing on the original implementation, then passing after its fix. The Workspace integration test also checks late refusal both with and without teardown; scoped drains and failed finalizers are covered.
- Innerdogfood smoke check: enable delayed kill, touch a terminal, close its Workspace, restore from the pending overlay; both original panes return. Native multi-window transfer/quit and packaged updater installation were not exercised; the browser harness cannot validate them.
- Spec/Markdown checks and the advisory prose audit cover the documentation changes. The `docs/stories/*.mdx` walkthroughs contain no changed flow requiring an edit.

This pass inventories the main lifecycle domains, verifies selected adverse schedules, and fixes all three confirmed findings. It is not a whole-application proof: pairing/authentication, cryptographic transitions, account/Relay lifecycle, the complete alert graph, and native OS failure schedules remain outside the new adversarial coverage. Passing their existing suites is not equivalent to independently auditing them. No unresolved confirmed finding is omitted from this ledger, and no design backlog is introduced here.
