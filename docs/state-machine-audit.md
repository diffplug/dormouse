# State-machine audit

This is the working inventory and evidence ledger for the November 2026 audit, starting at `a9630b630`. Behavioral authority stays in the linked owning specs; this file records coverage and findings, not a second contract. No GitHub issues are created. Fixes are grouped by root cause in separate commits within one PR.

## Method and coverage

Inventory means a lifecycle was identified, traced means its state and callers were read, and verified means the named adversarial sequences were exercised. None means exhaustive verification of a subsystem. Independent axes stay separate; the audit checks the constraints between them. A suspicious combination is a hypothesis until a reachable caller sequence and an observable violation establish it. A regression must fail on the original implementation and pass with its fix. Unchanged existing tests are evidence only once run.

| Machine or interacting group | Owning spec | Starting point | Coverage |
|---|---|---|---|
| Session Process / Registry / View / Link / Activity / Snapshot | `docs/specs/glossary.md` → Layers, Invariants | `lib/src/lib/terminal-lifecycle.ts` | Inventory; cross-axis vocabulary read |
| Dirty generations, Wall save queue, Window persistence | `docs/specs/layout.md` → Session persistence | `lib/src/components/wall/use-session-persistence.ts` | Tracing |
| PTY collection, retry, resume versus restore | `docs/specs/transport.md` → Reconnection protocol | `lib/src/lib/reconnect.ts` | Tracing |
| Workspace transfer, adoption, hand-back | `docs/specs/standalone.md` → Arrival queue | `standalone/src/workspace-move.ts` | Tracing |
| Workspace close, pending kill, reopen | `docs/specs/reopen.md` | `lib/src/components/wall/workspace-lifecycle.ts` | Tracing |
| Quit votes, per-window close, teardown arbitration | `docs/specs/standalone.md` → Quit flow | `standalone/src/quit.ts` | Inventory; Rust state model sampled |
| Update check, approval, download, install, notice | `docs/specs/auto-update.md` | `standalone/src/updater.ts` | Tracing |
| Tool declaration, serving, navigation, dirty saves | `docs/specs/dor-tool.md` | `lib/src/components/wall/use-tool-serving.ts` | Inventory |
| Tool stop, reap, rehydrate | `docs/specs/dor-tool.md` → Reaping | `lib/src/components/wall/tool-reaper.ts` | Tracing |
| Helper creation, promotion, reset, source close | `docs/specs/terminal-context.md` | `lib/src/lib/helper-terminal.ts` | Inventory |
| Alert interacting machines, await, delivery | `docs/specs/alert.md` → State machines | `lib/src/lib/alert-manager.ts` | Existing complete model read; implementation unverified |
| Command lifecycle and terminal escape parsing | `docs/specs/terminal-state.md`; `docs/specs/terminal-escapes.md` | `lib/src/lib/terminal-state.ts` | Inventory |
| Lath structure, parking, selection and input mode | `docs/specs/tiling-engine.md`; `docs/specs/layout.md` | `lib/src/components/wall/lath-wall-engine.ts` | Inventory |
| Browser provider lifetime and render swaps | `docs/specs/dor-browser.md` | `lib/src/components/wall/browser-surface.ts` | Inventory |
| Burrow service lifecycle, policy, revocation saves | `docs/specs/remote-security-model.md` | `lib/src/host/remote/service.ts` | Inventory; disposal guards sampled |
| Pairing, connection, presence and session authorization | `docs/specs/remote-security-model.md` | `lib/src/remote/burrow/` | Inventory |
| Direct-path negotiation and transport switching | `docs/specs/remote-api.md`; `docs/specs/remote-security-model.md` | `lib/src/remote/direct/` | Inventory |
| One-time connection lifetime | `docs/specs/one-time.md` | `lib/src/remote/one-time-app/` | Inventory |
| Pocket connection and remote PTY lifecycle | `docs/specs/pocket-app.md` | `lib/src/remote/client/` | Inventory |
| Relay routing and Hosted account lifecycle | `docs/specs/relay.md`; `docs/specs/hosted.md` | `relay/`; `hosted/` | Inventory |

Directories in inventory-only rows are discovery boundaries, to be narrowed to entrypoints when traced. Security changes also defer to the owning `security*.md` checks; this audit does not independently rewrite their properties.

## Findings

No confirmed findings yet. Candidates are being checked against callers and deterministic interleavings before classification.

## Validation

Pending. The audit uses package tests for deterministic schedules and the worktree-specific innerdogfood harness for supported UI behavior. The browser harness cannot validate native multi-window transfer or quit voting.
