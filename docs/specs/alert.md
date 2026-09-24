# Alert Spec

> See `docs/specs/glossary.md` for Session / Pane / Door vocabulary.
>
> Owns the Session Activity layer — the ring and its three sources, engagement, TODO, notification text and its sanitization, the two alarm sinks, and the Workspace union projection. `docs/specs/layout.md` defers here for all alert/TODO behavior.
>
> Defers placement and sizing to `docs/specs/layout.md`, the renderer ↔ host wire (`alert:command` and the `alert:*` events) to `docs/specs/transport.md`, and push sealing to `docs/specs/remote-security-model.md`; the await's own messages are stated here.

**Must preserve Activity across minimize/reattach** (glossary I3). **A browser Surface has no Activity machine** — it can never ring, and carries only a user-set TODO flag, destroyed with that Surface.

Dormouse can owe the user attention in three ways. Each is a **source** of the Session's one **ring**, a latch held until cleared (Clearing And TODO):

| Source | Rings when | Detail |
|---|---|---|
| `watching` (WATCHING Track) | a watched command's output went busy, then quiet | `WATCHING`: `<watch key> went quiet` |
| `report` (Terminal reports) | the PTY emitted `BEL`, `OSC 9`, `OSC 99`, or `OSC 777`, or ended an `OSC 9;4` cycle | the sanitized report |
| `exit` (Command-exit Track) | a seen command exited after at least `cfg.alert.commandExitMinRuntime` | `COMMAND_EXIT` |

Only `watching` requires WATCHING. **Every source obeys one engagement rule — a completion on an engaged Session is held, never rung** (Engagement), applied at the single seam every completion passes through (Completion events). The output/silence detector (`QuiesceDetector`) is not a source: it is an always-on observer WATCHING reads.

## Non-goals

- **No process heuristics.** WATCHING applies only to command names the user explicitly asked for — never a guess that `vim`, `npm dev`, agents, or test runners deserve alerts.
- **No native OS notifications on the machine Dormouse runs on**, and no progress-bar widget. The one local audible channel is the opt-in spoken alarm below, which says a Pane name and nothing else; Dormouse plays no sound effects. Push is the exception and goes only to a *remote* paired phone.
- **No process-tree introspection** for command-exit alerts; normalized terminal semantic events are the reliable input.
- No HTML, Markdown, ANSI styling, clickable actions, custom icons, or remote-controlled buttons in notification previews.
- No Door-specific alert menu that changes the Door actions in `docs/specs/layout.md`.

## Public State

Public `status` is a projection — first match wins:

1. `ALERT_RINGING` if the ring is active.
2. `OSC_NOTIF_BUSY` if a progress cycle is active.
3. The output/silence detector's own state if WATCHING is on. The detector runs regardless; the rule only makes its state public. **Never reorder 3 and 4** (rationale).
4. `COMMAND_EXIT_ARMED` if command-exit alerting is armed.
5. Otherwise `WATCHING_DISABLED`.

**Must identify each uninterrupted ringing interval with an `episode` id and start time.** Opening the ring creates it; the ring clearing ends it. A source joining an active ring joins its episode and never starts another delivery episode. **Never persist episodes.** Tests: `a second source joining mid-episode keeps the episode id` and `re-latching after the ring clears starts a new episode` in `lib/src/lib/alert-manager.test.ts`.

`awaited` sits beside `status`: true while at least one `dor await` is parked on the Session (Await). It is derived from live waiters and **never persisted**.

**Persist only** `todo` and the sanitized `notification` (plus `status` for diagnostics); **an unacknowledged ring persists as the TODO a look would leave**, with its detail (pinned by `persists an unacknowledged %s ring as the TODO a look would leave` in `lib/src/lib/alert-manager.test.ts`). Every spawn starts the id's alert state over; **a cold restore carries those two on the pane's spawn** (`SpawnPtyOptions.alert`), seeded **before the PTY spawns**; a live resume keeps the host's. Restore **must not** recreate a ring, a progress cycle, or a command-exit arm. Pinned by `restores a pane's persisted TODO through its spawn` in `lib/src/lib/terminal-registry.alert.test.ts`. **Must read a notification this build cannot validate as none, keeping the pane** (pinned by `keeps a pane whose notification this build cannot read, seeding its TODO without the detail` in `lib/src/lib/session-restore.test.ts`), and **never write a source outside `STRICT_READER_NOTIFICATION_SOURCES`** until no strict pre-tolerant build reads the file (rationale). **WATCHING is never persisted per Session** — it is re-derived from the rule set below at the next command start. Replay filtering in `docs/specs/terminal-escapes.md` keeps old terminal output from firing notification side effects again.

**Must retain host Activity before xterm initialization and clear it on Session disposal.** Test: `preserves pre-registration activity through terminal creation and orphaning` in `lib/src/lib/terminal-registry.alert.test.ts`.

Source of truth: `AlertState` / `ActivityNotification` / `SessionStatus` in `lib/src/lib/alert-manager.ts`; `QuiesceStatus` in `lib/src/lib/quiesce-detector.ts`; `ActivityState` in `lib/src/lib/session-activity-store.ts`; `toPersistedAlertState` / `normalizePersistedAlert` in `lib/src/lib/session-types.ts`; `respawn` in `lib/src/host/alert-host.ts`.

## Engagement

Three separate signals, never one lease (rationale):

| Signal | Of | Holds while |
|---|---|---|
| **Presence** | a viewer — one renderer realm: a VS Code webview, a standalone window, the fake adapter | its window is focused and visible, with typing, pointer (down or move), wheel, or IME composition anywhere in it within `inactivityTimeoutMs` |
| **Focus** | a viewer | the terminal Session its visible Wall points at: the passthrough pane, or the source of an open terminal context — **never** a command-mode selection, a Door, a browser Surface, or a hidden Workspace |
| **Acknowledge** | a Session | a human gesture on it, below |

**A Session is engaged while some present viewer focuses it**, and engagement alone decides holding over ringing.

- **Must compute presence in the renderer and report transitions only**: an input event only stamps a time, and the host keeps no presence timer. **An end of presence names its lapse** — `idle` when the timeout ran out, `leave` on a window blur or hide. **A blur is a leave only when `document.hasFocus()` is false** (`docs/specs/layout.md` → Corner cases #2). Focus or visibility returning counts as input. **An iframe Surface holding focus keeps presence from lapsing `idle`**, its input never reaching the window; a blur behind it is a `leave` at the next deadline (rationale).
- **Must keep engagement per viewer**, deduped at the renderer, so one viewer's leave never disengages a Session another viewer engages. **An absent viewer reports no focus change.**

| Gesture | Acknowledges |
|---|---|
| typing into the pane (CSI/SS3 key encodings included), a paste, a file drop, the mobile input bar or a gesture key, a remote Client's write | with input |
| a Pane body or header click, zoom or unzoom, the dev-server chip, entering passthrough by keyboard, a Door click or `Enter`, a mobile tap | without input |
| a terminal reply, a mouse-only report chunk, `d` reattach, a spawn, split, or promotion, a `dor` reveal, an embed focusing itself, DOM focus alone | nothing |

- **Must acknowledge at each gesture's handler, never in the passthrough entry the silent paths share.**
- **Never treat terminal replies or mouse-only report chunks as keyboard input** (rationale).
- **Must write all human-originated PTY input through `writeUserInput`**, the mobile input bar's included: it carries `userInput`, and **the host acknowledges it with input before the bytes reach the PTY**, in the one message (rationale). **A remote Client's write acknowledges the same way unless it holds only mouse reports**, the Burrow having dropped a mirror's terminal replies (rationale).
- **Never create an Activity entry to acknowledge**, the host's one check, so a browser Surface keeps its own TODO.
- **User input opens the echo window** (`cfg.alert.echoWindow`) even when acknowledging clears nothing, a helper's included. Output inside it is ignored entirely — detector, `outputSince`, the acknowledged state, awaits — and a completion inside it neither rings nor is held (rationale).

Source of truth: `setViewer` / `acknowledge` in `lib/src/lib/alert-manager.ts`; `createPresenceTracker` in `lib/src/lib/presence.ts`; `retainEngagementReporter` in `lib/src/lib/engagement.ts`; `writeUserInput` in `lib/src/lib/terminal-lifecycle.ts`; `alertedPty` in `lib/src/host/owner-pty.ts`. Pinned by `lib/src/lib/alert-engagement.test.ts`.

## Completion events

Every completion — a detector settle, a command finish, a direct notification, and the end of a protocol progress cycle (completion or error) — is **dispatched as a `CompletionEvent` before any suppression runs** (rationale).

Claimants get first refusal per Session in registration order; the first to return `true` claims the event and the rest are not offered it. **A claimed event never rings, never sets TODO, and never stores an `ActivityNotification`** — it stops before the ring rules, where the echo window, holding, and the command-exit seen and minimum-runtime checks live.

**Must hold a completion that would ring an engaged Session**: the sources it would raise and the richest detail (Clearing And TODO), repeated holds merging, never public. A deferred report that comes due while engaged is held too, and **never deferred again on escalation** (rationale). **Presence lapsing `idle` with focus unchanged rings what was held**, each source by its unengaged path; any other end drops it — a user verb (Clearing And TODO), focus moving away, the viewer leaving, seeding, removal, or teardown (rationale). **Dropping on an explicit disengage may be a mistake** (rationale). Resumed watched work and rule removal withdraw a held `watching` source as they withdraw a ringing one (WATCHING Track).

With `deferAlertsUntilQuiet` enabled:

- **Must defer an eligible unengaged terminal-notification ring while the private detector is fully armed** — `BUSY` or `MIGHT_NEED_ATTENTION`, including when WATCHING is off or a progress cycle masks that projection (rationale).
- **Never defer `MIGHT_BE_BUSY`, a detector settle, or a command-finish ring** — unconfirmed, already quiet, and authoritative respectively (rationale).
- **Must fold a pending terminal notification into an eligible command-finish ring immediately**, so protocol detail enriches that ring instead of publishing stale later.
- **Must defer after claimants and ring eligibility, never redispatch the historical `CompletionEvent`** (rationale).
- **Keep pending intent live-only and bounded** to one protocol notification, chosen by richness (Clearing And TODO). Meaningful output moves its quiet deadline; command-boundary detector resets do not drop it.
- **Cancel pending delivery on an acknowledgement, a dismissal that clears a ring, TODO changes, removal, seeding, or teardown.** A dismiss on a quiet Session keeps it: a cancelled deferral was never visible to dismiss. Disabling the setting releases it immediately; otherwise confirmed quiet raises one fresh ring, after which speech/push begin their own delays.
- **Must ring a deferral by `cfg.alert.deferCeiling` (30 s) after the first notification deferred**, quiet or not; a replacement keeps that start (rationale).

Two ordering rules:

- **Clear the progress cycle *before* dispatch**, so a completion or error ends the cycle whether or not the event is claimed and `OSC_NOTIF_BUSY` falls back either way.
- **Dispatch a command finish for every watch that existed**, including the short, unseen, and engaged ones the ring rule then discards or holds.

Source of truth: `registerCompletionClaimant` / `dispatchCompletion` / `holdOrDeliver` / `deferOrDeliverNotification` / `scheduleDeferredNotification` / `flushDeferredNotification` / `escalateHeld` in `lib/src/lib/alert-manager.ts`; `quietAt` in `lib/src/lib/quiesce-detector.ts`. Pinned by `held completions` in `lib/src/lib/alert-engagement.test.ts`.

## Await

An **await** parks on one Session until it finishes what it is doing, then reports why the wait ended — the claimant the Completion events seam exists for. **Where a human and a program want different things, an await serves the program and leaves the human's channels alone.**

`until` (`dor await`'s required `--until`) names how much evidence of completion the caller accepts — a permissiveness ladder.

| `until` | Resolves on | `cause` | For |
|---|---|---|---|
| `quiet` | The Session settled, **or** the foreground command exited, **or** the Session emitted a notification | `quiet` / `exit` / `bell` | Agents that never exit — `claude`, `codex` |
| `exit` | The foreground command exited. Nothing else | `exit` | Builds, test runs, migrations |

- **Never narrow `quiet` to silence alone, and never let `exit` resolve on a bell** (rationale).
- **`--until` has no default and is never inferred from the WATCHING rule set** (rationale).
- **Silent is not settled.** Settling comes from the always-on detector (WATCHING Track), which needs no shell integration and cannot fire until it has been BUSY (rationale).

**Is there anything to wait for?**

| At await time | Behavior |
|---|---|
| A foreground command is running (`commandExitWatch`) | Park, no grace window. |
| Nothing running | Park for one grace window. A *command start* cancels it under either `until`; under `quiet` so does *output*, under `exit` output alone does not. Either way the await then waits for a real signal. Neither → resolve `cause: idle`. |

**`idle` is a resolution, not a failure** (rationale). Absent shell integration "is a command running" is unanswerable, so an `exit` await there falls back to the grace window and resolves `idle` rather than erroring.

**Resolution consumes only the ring source it resolved on**, its `cause` from *that source*: `report` → `bell`, `exit` → `exit`, `watching` → `quiet`. An await arriving mid-ring resolves immediately; under `exit` only the `exit` source counts and the await keeps waiting on the others. Two are gated:

- **Skip the `exit` source while a foreground command is running** (rationale).
- **Skip the `watching` source once output has resumed since it joined the ring** (`outputSince`), and **never stand the detector in for that flag** (rationale).
- **Never skip a report** — an `OSC 9` stays true until it is answered.
- **Consuming withdraws that one source and never acknowledges**; a ring it leaves empty is withdrawn (Clearing And TODO).

**Absorption: absorb the summons, keep the receipt.**

- **A consumed completion never latches a ring** — no alarm treatment, no spoken alarm, no push; nothing quieter is substituted (rationale).
- **Absorption is per-signal, not per-Session** — a human's own WATCHING rule on that Session still rings on the next settle.
- **A failed await absorbs nothing.** A timeout, a death, or a cancel claims no completion, so a crashed orchestration cannot silently eat the human's signal.
- **An await never leaves a TODO, and never clears a pre-existing one**, whether it parked before the report or after (rationale). Pinned by `leaves no TODO whether the report arrived before or after the await parked` in `lib/src/lib/alert-manager.test.ts`.
- **Claiming is delivery.** Once handed to an await the wait is settled and a later `cancel()` is a no-op — no release-after-claim, so the claim-to-read window is unacknowledged (rationale).

**Timing.** Every window derives from `cfg.alert`:

| Window | Value | Source |
|---|---|---|
| Grace — "did anything start?" | 2000ms | `AWAIT_GRACE_MS` = `busyCandidateGap` + `busyConfirmGap`, the detector's floor for reaching BUSY |
| Settle — "has it stopped?" | 5000ms | `mightNeedAttention` + `needsAttentionConfirm` |
| Ceiling | `timeoutMs` | `dor await`'s `--timeout` (seconds, default 600), the only number not derived from `cfg.alert` |

- **Enforce all three host-side**, so no hop reaps a parked await early and no caller parks forever by lying about its deadline.
- The host's `MAX_AWAIT_TIMEOUT_MS` matches the CLI's 1–86400 whole-second range (`docs/specs/dor-cli.md`) (rationale).
- **Reject a non-finite, non-positive, or over-ceiling request rather than clamping it** — it settles `cancelled`, absorbing nothing; the webview handler rejects the same values with a visible error.

**Several awaits may park on one Session**, sharing one claimant: a completion goes to every await whose condition it satisfies, each resolving on the first qualifying signal after it registered.

**An await crosses from the renderer to the host process that holds the manager**, and the wait itself never leaves the host:

- The renderer asks to park (`await`, under an `awaitId` its client mints) and, if it gives up, to cancel (`awaitCancel`); **the host answers exactly one `alert:awaitResult {awaitId, outcome}` per await, to the realm that parked it**, a cancel included. **A realm's repeated `awaitId` is ignored, never answered twice**; a malformed `id` or `until` is answered `cancelled`.
- **A realm that ends — a disposed or recreated webview, a reloaded or closed window — has everything it parked cancelled and answered by the host, *synchronously*** (rationale); a disposing adapter settles its own.
- `cancelled` has no wire outcome of its own: the renderer reports it to `dor` as an error, which is also what forgets the in-flight control request.
- The fake adapter runs the same host in process. The Pocket phone adapter has no `dor` and protocol-v1 carries no await, so it settles every request `cancelled` at once.
- **An await survives a Workspace transfer**: the manager never moves (Live Workspace transfer).

**A PTY exit or Session removal resolves every waiter still parked as `died`**, after command-finish dispatch gets first chance to resolve normally. Manager disposal resolves every waiter as `cancelled`.

Source of truth: `awaitCompletion` in `lib/src/lib/alert-manager.ts`; `AlertCommand` / `AlertAwaitResult` in `lib/src/host/alert-protocol.ts`; `alertAwait` in `lib/src/host/alert-client.ts`; `createAlertHost` in `lib/src/host/alert-host.ts`. Pinned by `lib/src/host/alert-host.test.ts` and `lib/src/host/alert-client.test.ts`.

## WATCHING Track

**Must key WATCHING by the foreground command's watch key** (Rules, below). A Session is watched exactly while a rule covers that key; edits reach every matching Session. **Never add per-Session enable or mute** (rationale).

**The output/silence detector is always on.** Every Session runs one `QuiesceDetector` for its whole lifetime, fed by every output chunk outside the echo window and reset at every command boundary. It never latches and knows nothing about engagement or rules; the rule set decides only whether its state is publicly visible and whether a settle — a busy Session that stayed quiet — may *ring*.

**A retired id must stay retired.** A host removes the alert entry in the same turn as its kill, ahead of any output still in flight. **Raw output and resizes never revive a retired id**; a semantic or protocol event may (rationale).

Rules:

- **The key is `commandWatchKey(rawCommandLine)`**: the last command of a list (`&&`, `||`, `;`, `&`, newline) and the first stage of its pipeline, grouping dropped, leading `VAR=value` words and transparent wrappers (`sudo`, `npx`, …) skipped, then argv[0]'s basename minus any launcher suffix (`docs/specs/terminal-state.md`). **Reserved words are grammar, fish's included**: a leading `do`, `then`, `if`, `!`, `and`, `not`, `begin`, … is stripped, a segment a closer (`done`, `fi`, `esac`, `end`) leads is skipped with its redirection or pipe, and a `for` header, a case pattern, and fish's `case` line are dropped, so `for f in *; do make; done` keys on `make` (rationale). **A redirection is never the program or a runner's script**, a separate target skipped with it (rationale). **An unknown wrapper flag stops the skip**, keying the wrapper itself. **A script runner keys as `<runner> <script>`**, a leading `run` dropped, so `cd web && pnpm run dev` keys on `pnpm dev`; a script that is no valid key (a path) keys the runner (rationale). Where bash's `E` falls back to a line's first simple command (`docs/specs/terminal-escapes.md` → Shell-integration injection), that command keys. Pinned by `WATCHING key` in `lib/src/lib/terminal-state.test.ts`.
- **A rule covers a key it equals, and a bare runner rule covers every `<runner> <script>` key of that runner** (rationale). `watchRuleFor` is the one matcher, for WATCHING, rule-removal silencing, and the terminal context's row.
- **Every command boundary resets the detector** — `commandStart`, `commandFinish`, `promptStart`, `promptEnd`, and PTY exit — even without a command watch. Pinned by `resets unwatched output history on %s without a command watch` in `lib/src/lib/alert-manager.test.ts`.
- **Editing the rule set re-derives WATCHING across every live Session immediately**, never restarting the detector (rationale).
- **A WATCHING ring outlives the command that raised it.** Watching switches off when the watched command exits; the ring's `watching` source keeps the originating key.
- **Removing a rule withdraws the `watching` source it raised**, even after the command has exited, unless another rule still covers that key; other clearing paths follow Clearing And TODO. A command merely ending never clears the ring.
- **Must seed an absent `dormouse:watched-commands` key with `DEFAULT_WATCHED_COMMANDS` from `lib/src/lib/coding-agents.ts`.** **Must preserve saved lists, including empty lists**; malformed saved data falls back to empty. Pinned by `lib/src/lib/watched-defaults.test.ts`. **The host is authoritative** for this app-global rule set; the seed / delta / broadcast wire is `docs/specs/transport.md` → Message protocol.

**Limitation:** WATCHING needs the shell to report its command line — `OSC 633 ; E`, or `cmdline_url` / `cmdline` on `OSC 133 ; C` (fish ≥ 4) — beside the boundaries. A shell reporting bare `OSC 133` boundaries, or none (`docs/specs/terminal-escapes.md`), never names a command, so WATCHING never engages and the terminal context reports `No command running`. Terminal reports still work; command-exit alerting also requires semantic command boundaries. **Never route the keystroke fallback in `docs/specs/terminal-state.md` into the `AlertManager`** (rationale).

| State | Meaning |
|---|---|
| `WATCHING_DISABLED` | No rule matches, so the detector's state is not shown. |
| `NOTHING_TO_SHOW` | A rule matches, but no reminder is owed. |
| `MIGHT_BE_BUSY` | Output may be turning into ongoing work. Debounce. |
| `BUSY` | Enough output to treat the Session as doing work. |
| `MIGHT_NEED_ATTENTION` | A busy Session went quiet. Debounce. |
| `ALERT_RINGING` | Likely completion observed while the Session was not engaged. |

Meaningful output excludes resize redraw noise during `T_RESIZE_DEBOUNCE`, **a grace the host opens before it resizes the PTY**, a Client's resize included; theme changes, remounts, DOM reparenting, selection, and focus changes are not output. Invariants:

- Output drives the detector up `NOTHING_TO_SHOW` -> `MIGHT_BE_BUSY` -> `BUSY`; silence drives it down `BUSY` -> `MIGHT_NEED_ATTENTION` -> settled. The `MIGHT_*` states are debounce windows in both directions.
- First output starts candidate tracking without changing status; unconfirmed `MIGHT_BE_BUSY` returns to `NOTHING_TO_SHOW`.
- **Must discard unconfirmed candidate history after an output gap beyond `busyCandidateGap + busyConfirmGap`, including when a timer runs late** (rationale). Pinned by `forgets stale candidate history` and `expires candidate history even when the confirmation timer has not run` in `lib/src/lib/quiesce-detector.test.ts`.
- **The detector never holds `ALERT_RINGING`.** It reports each settle once and returns to `NOTHING_TO_SHOW`; the ring latches instead.
- **With `deferAlertsUntilQuiet`, withdraw the `watching` source, ringing or held, when watched work resumes confirmed BUSY.** Preserve the detector and other sources; a ring left empty is withdrawn (Clearing And TODO). The next unengaged settle restarts speech/push delays. Short redraws and post-exit output retain the ring (rationale).
- **A settle rings only if** a rule matches the foreground command; an engaged Session holds it (Completion events).
- **Never reset the detector for engagement alone**; settles must reach awaits. **Must reset to `NOTHING_TO_SHOW` when a user verb or an await clears a ring with a `watching` source**, preventing its output tail from settling again; resumed work and rule removal leave it running.
- **Rings must be caused by a fresh transition** — a settle the detector just reported — never by rerender, theme change, remount, minimize, or reattach.

Source of truth: `commandWatchKey` / `watchRuleFor` in `lib/src/lib/terminal-state.ts`; `QuiesceDetector` in `lib/src/lib/quiesce-detector.ts`; `onSettled` / `withdrawResumedWatchingRing` in `lib/src/lib/alert-manager.ts` (pinned by `lib/src/lib/alert-resumed-output.test.ts`); renderer mirror `lib/src/lib/watched-commands.ts`, multi-renderer coordinator `lib/src/lib/watched-command-host.ts`.

## Terminal reports

**Terminal notifications are independent of WATCHING** and follow the deferral policy in Completion events. **An engaged Session holds a report** (Completion events); holding leaves a progress cycle alone. A report raises the ring's `report` source (Clearing And TODO).

**Must apply a parse batch's reports and command boundaries in stream order, timestamping its semantic events once** for both the `AlertManager` and the terminal-state store, at the host's parse site in both hosts. Pinned by `judges a notification written after a command finish against the reset detector` in `lib/src/lib/alert-manager.test.ts`.

Sequence syntax lives in `docs/specs/terminal-escapes.md`; what each means here:

- **Standalone `BEL`** — stripped from visible output and creates `TERMINAL_BELL_NOTIFICATION`. **Drop the generic bells only beside a text-bearing notification in the same parse batch, never for a progress event** (rationale). Multiple bells in one batch collapse to one notification. Pinned by `keeps a bell that shares its batch with %s` in `lib/src/lib/terminal-protocol.test.ts`.
- **`OSC 9`** — the message becomes the body, title null. Empty sanitized messages are ignored. It also feeds title-candidate derivation (`docs/specs/terminal-state.md`), with no alert effect. **A number, alone or before `;`, is a ConEmu subcommand** (`9;12`, a bare `9;9`) yielding neither notification nor title — except `9;4` below and `9;9;<cwd>` (`docs/specs/terminal-state.md`).
- **`OSC 777`** — only the `notify` subcommand is supported; unsupported subcommands and empty sanitized notifications are ignored.
- **`OSC 99`** (kitty) — chunked notifications keyed by `i`; completion rings once if the sanitized title or body is nonempty. **Management payloads (`p=?`, `p=close`, `p=alive`) contribute no content.** Incomplete chunk state is capped and expired.
- **`OSC 9;4` progress** — progress only: no title, body, urgency, id, app name, or action fields. **A cycle is an independent sub-state: it never touches the ring, and the ring never touches it** (rationale).

  | Input | Behavior |
  |---|---|
  | active normal / warning / indeterminate | starts or updates the cycle, no TODO; never rings from silence |
  | `state=1, progress=100` | ends the cycle; a report completion |
  | `state=2` | ends the cycle; a report error |
  | clear | a report completion only if a cycle was active, else ignored |
  | completing a *warning* cycle | a report completion with the warning title |
  | invalid state, missing percent for `1`/`4`, out-of-range percent | ignored |
  | a command boundary — start, finish, prompt, PTY exit | ends the cycle silently |
  | completion or error while engaged | ends the cycle; the report is held |

  **Titles name the running command** — its watch key, else its display command — and fall back to a generic title with none running; the body is `Progress <percent>%`, or none.

Source of truth: the OSC 777 and OSC 99 grammars, parsing, sanitization limits, OSC 99 chunk state, and `applyTerminalEvents` in `lib/src/lib/terminal-protocol.ts`; `createOwnerPtyStream` in `lib/src/host/owner-pty.ts`; `updateProtocolProgress` / `finishProtocolProgressCycle` / `PROGRESS_TITLES` in `lib/src/lib/alert-manager.ts`. Pinned by `silently ends a progress cycle the program abandoned` and `names the running command in a progress %s title` in `lib/src/lib/alert-manager.test.ts`; `a Claude Code turn` in `lib/src/lib/alert-engagement.test.ts`.

## Command-exit Track

Command-exit alerting consumes normalized semantic command events from `docs/specs/terminal-state.md` (`OSC 133`, `OSC 633`, or equivalent) and **must not parse raw OSC itself**.

Rules:

- A command start creates `commandExitWatch` for the current foreground command. **Mark it seen** when the Session is engaged at its start, becomes engaged, or is acknowledged while it runs.
- **Armed is derived, never stored**: a seen command running while the Session is not engaged — public `COMMAND_EXIT_ARMED`, published on every engagement edge.
- When the same command finishes, or the PTY exits before a finish event, **ring only when** it was seen, ran at least `cfg.alert.commandExitMinRuntime` (15 s), and the Session is not engaged; engaged, the exit is held (Completion events). **Never tie that minimum to the inactivity timeout** (rationale).
- The `exit` source carries the `COMMAND_EXIT` notification (title "Command finished", body = summarized command + exit code).
- A quick finish, a different command start, or Session destruction clears the watch without ringing.

Command starts and finishes also drive the WATCHING rule above, so both sources share one `commandExitWatch` record and one `resolveCommandStart` helper with the terminal-state reducer.

Source of truth: `dispatchCompletion` / `setViewer` / `formatCommandExitBody` in `lib/src/lib/alert-manager.ts`; `resolveCommandStart` in `lib/src/lib/terminal-state.ts`.

## Clearing And TODO

`todo` is a boolean reminder. **A ring never sets it**: a look at a ring without typing turns it into a TODO carrying the ring's detail, and dealing with it — typing, the pill — clears it (rationale). **`notification` is the ring's detail while ringing, else the TODO's.** Pinned by `a %s ring shows its own detail and never sets TODO` and `acknowledging without input, dismissing, or toggling TODO on a %s ring leaves a TODO with its detail` in `lib/src/lib/alert-manager.test.ts`.

**Detail follows one richness order:** a text report (`OSC 9`, `OSC 99`, `OSC 777`) > `COMMAND_EXIT` > `OSC 9;4` > `WATCHING` > `BEL`. A new ring shows its own detail; a source joining an active ring, a deferred notification, and an acknowledged receipt each replace the detail only at an equal or higher rank (rationale). Pinned by `detail joining a ring` in `lib/src/lib/alert-manager.test.ts`.

| Verb | Effect |
|---|---|
| acknowledge without input (Engagement) | clears the ring, leaving `todo` on with its detail |
| acknowledge with input — any keystroke, paste, or drop — or clear TODO (pill click) | clears the ring; `todo` off, notification dropped, even if already off |
| dismiss (`a`, Pane Header) | clears the ring, leaving `todo` on with its detail. **With nothing ringing: no change, no notify, a deferred notification kept** |
| toggle TODO (`t`) | clears the ring; `todo` flips, on keeping the ring's detail, off dropping the notification |
| an await consumes a source (Await) | withdraws that source |
| watched work resumes (WATCHING Track) | withdraws `watching` |
| a rule stops covering the `watching` key | withdraws `watching` |

- **The user verbs acknowledge; a withdrawal never does.** Each also drops whatever was held or deferred, except a dismiss with nothing ringing, and **a dropped hold or deferral leaves no TODO**. A ring a withdrawal empties goes with its detail, leaving `todo` and its notification as they stood.
- **Any keystroke into the pane clears TODO** (rationale).
- **Never summon twice for an acknowledged state.** After a user verb clears a ring or drops a held completion, a report arriving before any output opens no ring: it sets `todo`, updates the notification, and publishes. Settles and exits ring as usual, and opening a ring or starting a command forgets the acknowledgement (rationale). Pinned by `a report about a state acknowledged by %s updates the TODO without summoning again` and `rings a report again once a command starts after the acknowledgement` in `lib/src/lib/alert-manager.test.ts`.
- Command-mode `Enter` that only enters passthrough does not clear TODO.
- Removing a WATCHING rule turns watching off wherever it matched. It does not stop the detector, nor clear a progress cycle or a command-exit arm.
- Destroying the Session clears all alert, TODO, notification, held, progress, and command-exit state.

Source of truth: `raiseRing` / `withdrawRingSource` / `clearRingForUser` / `ringToTodo` in `lib/src/lib/alert-manager.ts`; `toPersistedAlertState` in `lib/src/lib/session-types.ts`.

## Live Workspace transfer

**A Session's alert state never moves**: the host's one manager and its delivery scheduler hold it (`docs/specs/standalone.md` → Alerts), and a transfer moves only where its `alert:state` and `alert:speak` are routed — the source until the mark, then the target, whose collection is answered with every listed Session's state (rationale).

- **Never spawn or kill over a departure, a refused arrival, or a hand-back**: a spawn starts the host's entry over and a kill or reap removes it, and releasing a Session is neither. Pinned by `never spawns or kills over an arrival's live Sessions` in `standalone/src/workspace-move.test.ts`.
- **A replay never feeds the manager**, whose host parse already did.
- **Awaits survive a transfer**; a seen command stays seen, so it arrives armed; the destination's viewers establish their own engagement.
- **Must discard this window's Activity copy on any target failure**, mount or no mount: the source goes on showing the Session. Pinned by `discards this window's copy of the alert state when adopt_done is refused before the Wall mounts` in `standalone/src/workspace-move.test.ts`.

Source of truth: `teardownSession` in `lib/src/lib/terminal-lifecycle.ts`; `planArrival` / `discardArrival` in `standalone/src/workspace-move.ts`. Pinned by `lib/src/lib/terminal-lifecycle.release.test.ts` and `standalone/src/workspace-move.test.ts`.

## Alarm settings

Application alarm defaults live beside the WATCHING rule set, edited in **Settings** (below). **Every other store reached from Settings stays its own — never fold one into `AlertSettings`**, which is relayed wholesale to the host. Both stores run the same two classes in either host (`lib/src/lib/watched-command-host.ts`, `lib/src/lib/alert-settings-host.ts`), bound to its manager by `createAlertHost`; the shape, its defaults and its validation are the platform-free `lib/src/lib/alert-settings-model.ts`.

| Field | Meaning |
|---|---|
| `inactivityTimeoutMs` | The presence window (Engagement), and nothing else; only the renderer's presence tracker reads it. |
| `deferAlertsUntilQuiet` | Gates animation deferral (Completion events) and resumed-ring withdrawal (WATCHING Track). Default on. (rationale) |
| `speakEnabled` / `speakDelayMs` | Spoken alarms, below. |
| `pushEnabled` / `pushDelayMs` | Push notifications, below. |

The speech row's managed-voice link follows
[website-docs.md](./website-docs.md) -> `/hosted` preview.

Rules:

- **Validate and clamp every field on read *and* on write, the host included** (`normalizeAlertSettings`), so a hand-edited `localStorage` blob or a hostile message can never install a `NaN` or absurd timer. Unknown keys are dropped and missing keys defaulted, so the blob evolves additively with no version field. `cfg.alert` owns the inactivity default; `DEFAULT_ALERT_SETTINGS` owns the sink and boolean defaults.
- **Distribution follows the WATCHING rule set's seed/broadcast shape** (rationale), except that an edit **relays the whole blob** rather than a per-command delta, so every webview resolves workspace overrides against the same defaults. Wire contract and host revalidation: `docs/specs/transport.md`.
- **Must keep detection settings application-wide**, applied to each host's one manager.

**Must resolve delivery policy from application defaults, then sparse Workspace overrides.** Speech/push enable and delay can override independently; `speakVoice` selects a local engine voice URI, missing inherits the system-voice default, and explicit null selects the system voice. Missing or unavailable voices fall back to the engine default without erasing the saved choice. Unknown/invalid overrides are dropped; finite delays share the application clamp.

**Must persist overrides in the Workspace's `PersistedSession.alertDelivery` in both hosts**, preserving them through rename, reorder, save, and live move. Reset removes overrides, restoring inheritance. A pane resolves its current parent Workspace; a pane without membership uses application defaults.

**The host decides when to deliver, in `createAlertHost` beside the manager** (rationale):

- **Must deliver at most once per sink per episode**, due at the episode's start plus the Session's delay; a source joining the episode delivers nothing, and the ring clearing consumes what it had pending.
- **Must recheck at the deadline, and consume a deadline that fails, never retrying it**: **speech only while the Session is not engaged** (Engagement); **push only while no viewer is present**, VS Code's focused, active window counting as one (`docs/specs/vscode.md` → Workspaces; rationale).
- **Disabling consumes pending work immediately; enabling never replays an episode**, one that began disabled included. Delay edits never move a deadline; speech reads the current voice at engine admission.
- **Each realm publishes every Session it shows** — Pane label and Workspace overrides — as one `sessions` op: membership and override changes at the end of their task, label changes on a `LABEL_PUBLISH_THROTTLE_MS` trailing throttle (rationale), nothing unchanged resent. **A publication overwrites each Session it names, whichever realm published it last, and never drops one the manager holds state for**; one its realm omits with none is forgotten (rationale). **The host keeps each Session's entry until the Session is removed**, through its realm's end and a respawn under its id; an unpublished Session uses the defaults.
- **A due push goes from the host's own Burrow** (Push notifications), titled by the published label, whether or not a realm still shows the Session; **a due spoken alarm goes to the realm showing it** as `alert:speak`, and with none is not spoken.

Source of truth: `normalizeAlertDeliveryOverrides` / `resolveAlertDeliveryPolicy` in `lib/src/lib/alert-delivery-model.ts`; `createAlertDeliveryScheduler` in `lib/src/lib/alert-delivery-scheduler.ts`; `startAlertDelivery` / `LABEL_PUBLISH_THROTTLE_MS` in `lib/src/lib/alert-delivery.ts`; `getSessionAlertPolicy` in `lib/src/lib/alert-delivery-policy.ts`; `setWorkspaceAlertDelivery` in `lib/src/lib/workspace-store.ts`. Pinned by `lib/src/lib/alert-delivery-scheduler.test.ts`, `lib/src/lib/alert-delivery.test.ts`, and `delivery` in `lib/src/host/alert-host.test.ts`.

Neither sink ever carries the ringing `ActivityNotification`.

| Contract | Speech | Push |
|---|---|---|
| Performed by | The realm showing the Session; a missing backend is a silent no-op. | The host's own Burrow, only while enrolled. |
| Payload | Pane label via `toSpokenText`; fallback `terminal`. | The label the realm last published, via `toPushText`, plus a fixed body; fallback `terminal`. |
| Delivery identity | The episode the host named, rechecked at engine admission, plus native attempt identity; renderer-local `speaking` / `spoken`. | HTTP push tagged by Session id, so a newer ring replaces the prior notification. |
| After delivery | Clearing the ring cuts off speech. | **Never recall** — another push would only replace one stale notice with another. |
| Failure | A refused or unavailable engine produces no marker. | Warn on non-2xx, partial, or zero delivery; **never retry** stale alarms. |
| Authority | The renderer invokes `window.speechSynthesis`. | The host names Session and title; the Burrow selects active ACL devices, the Relay intersects subscriptions. |

Source of truth: `AlertSettings` in `lib/src/lib/alert-settings.ts` (renderer mirror, persisted at `dormouse:alert-settings`); `lib/src/lib/alert-settings-host.ts`.

### Spoken alarms

- **Must replace high-entropy ASCII tokens with `REDACTED` locally before punctuation cleanup and truncation**, including trailing padding but preserving `=` separators (rationale). Hex candidates include embedded hyphen/underscore groups. False positives and negatives remain possible; word-passphrase detection is excluded. Pinned by `lib/src/lib/redact-high-entropy.test.ts` and `redacts whole tokens before punctuation cleanup and truncation` in `lib/src/lib/alert-speech.test.ts`.
- **The label must be sanitized before it reaches the engine** (`toSpokenText`): all Unicode punctuation, symbols, and `Other` characters (including controls, bidi controls, and zero-width formats) become spaces, except apostrophes, which are elided so contractions survive; letters, numbers, and their combining marks from every script remain. Whitespace collapses, the result is capped in code points, and an empty result falls back to `terminal`. **Security, not tidiness** (rationale).
- **Delivery state follows actual engine callbacks, not queue admission.** `AlertSpeechState` is a renderer-local `speaking | spoken` map keyed by Session: `start` publishes `speaking`; `end`, or `error` after a real start, publishes `spoken`; an utterance that never starts publishes neither. **Must check delivery identity before accepting `start` or completion**, including after cancellation, timeout, or teardown. Pinned by `ignores an older ring starting after a newer ring has begun speaking` and `recovers from a callback-less engine without accepting its later callbacks` in `lib/src/lib/alert-speech.test.ts`.
- **Nothing in the settle path may assume the callback arrives after `speak()` returns** — an engine may dispatch `start` then `end`/`error` *synchronously* inside `speechSynthesis.speak()` (rationale). Handlers therefore close over the utterance itself and registration happens before dispatch. A dispatch the engine refuses outright settles too.
- **Clearing the ring mid-sentence cuts the utterance off** — silence the engine, not merely un-render the overlay. "Mid-sentence" is the sink's own record that an utterance started — its generation token — never the rendered `speaking` state.
- **Must admit only one utterance at a time to Web Speech per renderer**, Settings tests included, and **must remove resolved or disabled pending jobs before engine admission**, a delivery that crossed either included, without cutting another pane's current utterance. Pinned by `never admits a resolved queued alarm to the speech engine` in `lib/src/lib/alert-speech.test.ts`.
- **Must bound pending jobs and cancel a stalled engine attempt**, advancing the queue and revoking callback identity before every cancel, and **never retry a failed, expired, or overflowed delivery**. Teardown cancels the current engine utterance and drops pending jobs. The bound, the timeout, and the revocation mechanism live at `SpeechQueue`.
- `speaking` / `spoken` remains only while the originating Session is still `ALERT_RINGING`: any action that resolves the ring (Clearing And TODO) clears it, killing the Session included, while visibility, hover, and command-mode selection do not. **Never persist it or send it to the host**, so restore/reconnect cannot recreate it.

Source of truth: `toSpokenText` / `startAlertSpeech` in `lib/src/lib/alert-speech.ts`, armed by `lib/src/components/wall/use-alert-delivery.ts`; `SpeechQueue` in `lib/src/lib/speech-queue.ts`; `redactHighEntropyTokens` in `lib/src/lib/redact-high-entropy.ts`; label derivation in `lib/src/lib/session-label.ts`; `AlertSpeechState` in `lib/src/lib/alert-speech-state.ts`.

### Push notifications

**A due push is one `BurrowService.push` call in the host's process** (VS Code: `docs/specs/vscode.md` → Workspaces). `sendPush` touches no DOM or store. **No webview sends a push or picks its recipients.** Without a Burrow nothing is sent; a failure is warned, never thrown. **The device-list fetch rides the lazily-imported `RemotePairingModalHost` chunk** (`activation.ts`); its store and refresh fence stay common (rationale).

- **The label is sanitized by `toPushText` at send time, in the Burrow, and not by `toSpokenText`'s rule** (rationale). It keeps angle brackets and instead strips control characters and the Unicode bidi and zero-width format characters (including the Arabic letter mark); the cap counts code points, so a cut never ships half a surrogate pair. `toPushText` is only this sink's limit and fallback over `boundedPushText` in `remote-lib-common/src/security/push.ts`.
- **The Burrow bounds, then seals; the worker re-bounds at the render sink.** Title, body, and tag are sealed to each recipient's own Client static and the Relay forwards ciphertext, so the second pass runs in `lib/src/remote/pocket-app/sw.ts`, which imports the *same* `boundedPushText` rather than mirroring it (`docs/specs/remote-security-model.md` -> Push sealing).
- **The Burrow names its targets; the Relay rejects a send that does not.** Targets are the Burrow's *active* ACL records, read at send time so a revocation during the delay takes effect, and the Relay intersects them with its own subscriptions (rationale). **One sealed envelope per recipient** — a Client static is not a group key — so a send names each `deliveryId` beside the ciphertext only that phone can open, **clamped to `MAX_PUSH_QUERY_DELIVERY_IDS`** because the route refuses the whole POST past it. The Burrow does **not** ask which devices are subscribed first (rationale).
- **The settings dialog re-reads the device list when it opens; the transient preview never refreshes.** The list is the Burrow's join of the Relay's subscriptions against its own ACL labels. **A disarmed enrolled gate invalidates every in-flight refresh and clears the list**, so nothing already on the wire can repopulate the dialog with phones there is no longer anything to push to.

Source of truth: `push` in `lib/src/host/remote/service.ts`; `pushAlert` in `vscode-ext/src/burrow.ts`; `sendPush` / `toPushText` in `lib/src/remote/burrow/push-delivery.ts`; `commitPushDevices` / `refreshPushDevicesNow` / `clearPushDevices` / `resetPushDevices` in `lib/src/lib/push-devices.ts`.

### Settings dialog

Reached from the baseboard sliders; `docs/specs/layout.md` owns placement. The alarm sections sit under the theme and shell rows; when both are hidden (VS Code owns the theme and the shells), the rule list is first and drops its section divider.

- **Must toggle only the clicked baseboard alarm setting**, as an override for that Workspace, showing the effective value. Components without a Workspace scope edit application defaults. **Must show its shared settings section for 2 seconds, then fade for 250ms**, anchored to the button and bounded by the viewport. The preview is inert, announces the resulting state, preserves keyboard focus and command dispatch, and omits test actions. Each click replaces the preview and restarts its lifetime; opening Settings or unmounting clears it. Reduced motion skips the fade. Pinned by `Baseboard.test.tsx`.
- Lists every watched command with a remove control, and **cannot add one** — WATCHING is keyed on a running command's watch key, so creating a rule stays the terminal context of a Pane running it, and the empty state says so. **It is the only place a rule set on a since-closed Pane can be removed**, the terminal context reaching only the command its own Pane is running.
- The watcher group carries the **Defer alerts until animation stops** switch and explains that a fully armed watcher delays terminal notifications and withdraws a ring once watched work resumes.
- **Delays are committed on blur or `Enter`, never per keystroke** — typing `3` on the way to `30` must not briefly install a 3-second timer. They are shown in seconds; an out-of-range or empty entry snaps back to whatever the store clamped it to.
- **The push group's device line names every device a push would reach**, and otherwise says why there is none — no Burrow enrolled, nothing subscribed yet, or the server could not be asked (rationale).
- **Must separate application defaults from this Workspace’s overrides** and offer per-field inheritance plus reset-all. The local voice picker follows engine voice availability. Pinned by `lib/src/components/WorkspaceAlarmSettings.test.tsx`.
- Each alarm sink carries a **try it now** control outside the switch's dimming; both report inline and clear after a few seconds.

  | Control | Path and result |
  |---|---|
  | **Play test sound** | Fixed sanitized phrase through the shared speech queue and selected voice; reports queue admission or an unavailable backend, never Session delivery state. |
  | **Send test push** | Real Burrow→ACL→Relay path; does not swallow failures and distinguishes no targets, zero delivery, partial delivery, and success. Hidden without a Burrow service. |

Source of truth: `lib/src/components/SettingsDialog.tsx`; `WorkspaceAlarmSettings` in `lib/src/components/WorkspaceAlarmSettings.tsx`; `SettingsPreview` in `lib/src/components/SettingsPreview.tsx`; `Baseboard` in `lib/src/components/Baseboard.tsx`; `lib/src/components/WatchedCommandList.tsx`; `lib/src/components/AlarmTestButtons.tsx`.

## Workspace union

**Must derive these fields from member Surface Activity:**

| Field | Meaning |
|---|---|
| `ringing` | Any member Session is `ALERT_RINGING`. |
| `todo` | Any member Surface has `todo === true`. |
| `count` | Number of members ringing or TODO; each Surface counts once. |
| `ringingSince` | The earliest ringing member's episode start, else `null`. |

**Must key the hidden tab's arrival burst on `ringingSince`**, held only for that ringing interval, so no later member, acknowledged member, or Workspace switch replays it (rationale). Pinned by `keeps one burst while a Workspace stays ringing` and `clocks the burst from the ring that began while the Workspace was visible` in `lib/src/components/WorkspaceStrip.test.tsx`.

**Must keep the projection display-only:** it never enters the Activity machine or fires its own ring. A Surface with no activity entry contributes nothing. Callers **must include** minimized (`Doored`) Surfaces.

**Must project every Workspace, active or not.** The Activity store spans the whole Window, so what scopes it to one Workspace is the membership each mounted Wall publishes — panes ∪ doors, on every layout commit.

Source of truth: `computeWorkspaceUnion` in `lib/src/lib/workspace-union.ts`; `setWorkspaceSurfaces` in `lib/src/lib/workspace-surfaces.ts`; `lib/src/lib/workspace-union.test.ts`.

Where it surfaces is host-specific:

- **VS Code** reflects the terminal portion onto native chrome — `docs/specs/vscode.md`, which also owns why browser-surface TODO stays webview-local.
- **Standalone** shows terminal rings/TODOs on panes and doors, and a browser Surface's `todo` on its own door. A **hidden** Workspace's tab additionally carries its union's TODO pill and, while ringing, the alarm inset, with `count` in the tab's accessible name; the visible Workspace's tab carries none, its panes and doors already saying it (`WorkspaceStrip` in `lib/src/components/WorkspaceStrip.tsx`).

**Must use `alarm-vs-header-inactive` for the hidden Workspace tab's inset**, matching its inactive-header background.

## UI Contract

### Pane Header

The header shows a fixed-text `TODO` pill when `todo === true`, a hover/focus notification preview when TODO has `notification`, and the terminal context opened by right-click or by `a`. **Never tint a ringing Session's header**: the Pane overlay already outlines it. Placement, sizing, and width tiers belong to `docs/specs/layout.md`.

- **`a` on the selected Pane in command mode dismisses a ringing Session and opens the terminal context, whatever the status; it never edits a WATCHING rule.**
- **Must offer user additions to WATCHING only in the terminal context** ("Watch all `<key>` commands"), whenever a foreground command has a watch key — naming the bare runner rule instead when one already covers the running script — and removals there or in Settings. Removing a rule drops it for every Session running that command.
- Right-click always opens the context. Pressing `t` toggles TODO.
- **The mobile composition dismisses by acknowledgement alone** — a tap, leaving a TODO, or a keystroke, clearing it — and wears its ring as the alarm inset, never an icon (`docs/specs/mobile-terminal-ui.md`). In Pocket only the keystroke reaches the host, as a Client's write (Engagement); a Client cannot dismiss yet (`docs/specs/remote-api.md` → Future).

**Must keep context alert controls scoped to the source**, with TODO, running-command WATCHING, and notification detail. Settings owns the global watched-command list. **Must suppress helper alerting until promotion, including after exit**: no completion dispatch (await, ring, TODO, speech, push), protocol report, acknowledgement, or TODO control, and only the default state published. **A helper still tracks its command and feeds its detector**, so one promoted mid-command is WATCHING what it runs; promotion publishes that state and never replays a suppressed event (rationale). Pinned by `helper Sessions` in `lib/src/lib/alert-manager.test.ts`.

Source of truth: `TerminalContext` in `lib/src/components/wall/TerminalContext.tsx`; `setHelper` in `lib/src/lib/alert-manager.ts`, which every host calls at helper spawn and promotion.

The TODO pill always displays `TODO`; remote notification text belongs in preview/detail surfaces, not inside the pill. Clicking the pill clears TODO, and on clear the pill briefly shows the success flourish before unmounting.

**Must wear the alarm treatment on every ringing terminal Pane**, labelled only once the speech sink acts. **Must bound the unlabelled pulse to one finite burst per episode, never replayed by a remount; `SPEAKING` pulses for its utterance, `SPOKEN` never** (rationale). **`prefers-reduced-motion` keeps the strong static treatment and suppresses only the pulse**, as does `cfg.alert.ringingPaused` (rationale). The three rows, their layers, strengths, and sizing are inventoried by `docs/specs/layout.md` → Alarm overlay.

Source of truth: `raiseRing` in `lib/src/lib/alert-manager.ts`; `dismissSessionAlert` in `lib/src/lib/session-activity-store.ts`; `TerminalContext` in `lib/src/components/wall/TerminalContext.tsx`; `lib/src/components/TodoPillBody.tsx`; `AlertRingIndicator` in `lib/src/components/wall/AlertRingIndicator.tsx`; `alertRingRow`, `useAlertRingBurst`, `AlertRingInset` in `lib/src/components/alert-ring.tsx`.

### Door

A Door is display-only for alert state:

- show the TODO pill when `todo === true`
- while ringing with no speech state, wear the ring `spoken` uses, unlabelled, named `needs attention`
- while its Session is `speaking`, replace the compact TODO cluster with the explicit `SPEAKING` label and invert + pulse the whole Door — that state lasts one utterance. `spoken` persists until the ring clears, so it keeps a static high-contrast inset and adds a speaker icon *beside* any TODO pill instead of replacing it; those are the baseboard's persistent signals and **must not go dark for an unbounded window**
- do not expose a Door-specific alert menu
- scrolled out of view, its overflow arrow carries its ring and TODO (`docs/specs/layout.md` → Baseboard responsive sizing)

Reattaching by click or `Enter` acknowledges; `d` does not (Engagement).

## Text And Security

Notification text is untrusted terminal output.

- Treat all text as plain text: never interpret ANSI, OSC, HTML, Markdown, URLs, paths, or emoji shortcodes as markup.
- **Sanitize at protocol-parse time** (`sanitizeText` in `lib/src/lib/terminal-protocol.ts`), bounded and control-stripped like every retained value (`docs/specs/terminal-escapes.md` → Parsing location); every notification stored from a live PTY has been through that pass, generated `WATCHING` and progress titles included via the sanitized command line. `normalizeActivityNotification` in `lib/src/lib/alert-manager.ts` is only a *shape* check on top — known `source`, string-or-null fields, trimmed, at least one non-empty — so the cold-restore path (`seed`) re-accepts a persisted blob without re-applying the cap or the control strip (rationale).
- Keep only one `ActivityNotification` rather than unbounded history, and cap/expire incomplete OSC 99 parser state.
- **Never** execute commands, open URLs, copy to clipboard, read files, focus outside Dormouse, or render protocol-supplied icons/buttons/actions.
- Wherever notification text appears in visible UI or accessible labels, it is plain text, and layout must tolerate long text, CJK, RTL, combining marks, and emoji without pushing fixed controls out of bounds. Sanitized terminal-supplied `OSC 0` / `OSC 2` / `OSC 9` text also participates in normal Pane-label derivation, and that label may reach the opt-in speech and push channels — **each after its own second pass**, since the two fail in different ways (`toSpokenText` under Spoken alarms, `toPushText` under Push notifications).

Robustness: Sessions ring independently; an exited Session may keep ringing until acknowledged, dismissed, or destroyed; ringing must not rely on color alone.

## Future

- **Presence across VS Code windows.** A window's presence holds back only its own extension host's pushes; the peer link could share it.
- **OS-level idle time.** A user working in another application counts as away; the machine's input idle time could hold a push until they leave the computer.
