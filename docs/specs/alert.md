# Alert Spec

> See `docs/specs/glossary.md` for Session / Pane / Door vocabulary.
>
> Owns the Session Activity layer — the three alert tracks, attention, TODO, notification text and its sanitization, the two alarm sinks, and the Workspace union projection. `docs/specs/layout.md` defers here for all alert/TODO behavior and owns placement and sizing.

**Must preserve Activity across minimize/reattach** (glossary I3). **A browser Surface has no Activity machine** — it can never ring, and carries only a user-set TODO flag, destroyed with that Surface.

Dormouse can owe the user attention in three ways, each an independent track that runs IDLE -> busy/armed -> ringing without entangling the others and latches its own ring until cleared:

| Track | Rings when | State |
|---|---|---|
| **WATCHING** | a watched command's output went busy, then quiet, unattended | `watchingRingingCommand`, `outputSinceWatchingRing` |
| **Terminal report** | the PTY emitted `BEL`, `OSC 9`, `OSC 9;4`, `OSC 99`, or `OSC 777` | `protocolStatus`, `progress` |
| **Command exit** | a command seen while attended kept running, attention was lost, and it exited after at least `T_USER_ATTENTION` | `commandExitStatus`, `commandExitWatch` |

The last two do not require WATCHING. **All three obey one suppression rule — never ring while the user is actively attending that Session** at the completion moment — applied at the single seam every completion passes through (Completion events). The output/silence detector (`QuiesceDetector`) is not a track: it is an always-on observer the WATCHING track reads.

## Non-goals

- **No process heuristics.** WATCHING applies only to command names the user explicitly asked for — never a guess that `vim`, `npm dev`, agents, or test runners deserve alerts.
- **No native OS notifications on the machine Dormouse runs on**, and no progress-bar widget. The one local audible channel is the opt-in spoken alarm below, which says a Pane name and nothing else; Dormouse plays no sound effects. Push is the exception and goes only to a *remote* paired phone — the point is reaching a user who walked away.
- **No process-tree introspection** for command-exit alerts; normalized terminal semantic events are the reliable input.
- No HTML, Markdown, ANSI styling, clickable actions, custom icons, or remote-controlled buttons in notification previews.
- No Door-specific alert menu that changes the Door actions in `docs/specs/layout.md`.

## Public State

Public `status` is a projection — first match wins:

1. `ALERT_RINGING` if any of the three tracks is ringing.
2. `OSC_NOTIF_BUSY` if protocol progress is active.
3. The output/silence detector's own state if WATCHING is on. The detector runs regardless; the rule only makes its state public. **Never reorder 3 and 4** (rationale).
4. `COMMAND_EXIT_ARMED` if command-exit alerting is armed.
5. Otherwise `WATCHING_DISABLED`.

**Must identify each uninterrupted ringing interval with an `episode` id and start time.** The first track to latch creates it; the last track clearing ends it. Additional track latches advance presentation-only `ringSeq` without starting another delivery episode. **Never persist episodes.** Older host snapshots receive a renderer-local identity on their first ringing transition.

`awaited` sits beside `status`: true while at least one `dor await` is parked on the Session (Await). It is derived from live waiters and **never persisted**.

**Persist only** `todo` and the sanitized `notification` (plus `status` for diagnostics); restore replays those two and **must not** recreate a ring, protocol progress, or a command-exit arm. **WATCHING is never persisted per Session** — it is re-derived from the rule set below at the next command start. Replay filtering in `docs/specs/terminal-escapes.md` keeps old terminal output from firing notification side effects again.

**Must retain host Activity before xterm initialization and clear it on Session disposal.** Test: `preserves pre-registration activity through terminal creation and orphaning` in `lib/src/lib/terminal-registry.alert.test.ts`.

Source of truth: `AlertState` / `ActivityNotification` / `SessionStatus` in `lib/src/lib/alert-manager.ts`; `QuiesceStatus` in `lib/src/lib/quiesce-detector.ts`; `ActivityState` in `lib/src/lib/session-activity-store.ts`.

## Attention

**Must set `attentionId` only for Pane body/header clicks, entering passthrough, typing in passthrough (including CSI/SS3 keyboard encodings), or a Door click or `Enter` on one** — both reattach into passthrough. **Never treat terminal replies or mouse-only report chunks as keyboard input or attention** (rationale).

**Never count** visibility, command-mode selection, hover, a Door existing in the baseboard, or reattaching a Door with `d` into command mode.

Attention is lost when the attention timer expires, the app loses focus, the attended Session is minimized or destroyed, or another Session becomes attended.

`T_USER_ATTENTION` is the user-facing **inactivity timeout** (Alarm settings) and also the **minimum runtime for a command-exit ring** — a command shorter than the walk-away window was probably watched. It is instance state on the `AlertManager`, not a module constant, and both uses follow the configured value; changing it re-arms a live attention timer from that moment, so a shortened window applies immediately.

Source of truth: `cfg.alert` in `lib/src/cfg.ts`; `setInactivityTimeoutMs` in `lib/src/lib/alert-manager.ts`; `wireXtermHandlers` in `lib/src/lib/terminal-lifecycle.ts`, pinned by `lib/src/lib/terminal-registry.alert.test.ts`.

## Completion events

Every completion — a detector settle, a command finish, a direct notification, and the end of a protocol progress cycle (completion or error) — is **dispatched as a `CompletionEvent` before any suppression runs**, so an observer sees even a completion that would never have rung anyone (rationale).

Claimants get first refusal per Session in registration order; the first to return `true` claims the event and the rest are not offered it. **A claimed event never rings, never sets TODO, and never stores an `ActivityNotification`** — it stops before the ring rules, where attention suppression and the command-exit armed and minimum-runtime checks live.

With `deferAlertsUntilQuiet` enabled:

- **Must defer an eligible unattended terminal-notification ring while the private detector is fully armed** — `BUSY` or `MIGHT_NEED_ATTENTION`, including when WATCHING is off or another track masks that projection (rationale).
- **Never defer `MIGHT_BE_BUSY`, a detector settle, or a command-finish ring** — unconfirmed, already quiet, and authoritative respectively (rationale).
- **Must fold a pending terminal notification into an eligible command-finish ring immediately**, so protocol detail enriches that ring instead of publishing stale later.
- **Must defer after claimants and ring eligibility, never redispatch the historical `CompletionEvent`** (rationale).
- **Keep pending intent live-only and bounded** to the latest protocol notification. Meaningful output moves its quiet deadline; command-boundary detector resets do not drop it.
- **Cancel pending delivery on attendance, a dismissal that clears a ring, TODO changes, removal, seeding, or teardown.** A dismiss on a quiet Session keeps it: a cancelled deferral was never visible to dismiss. Disabling the setting releases it immediately; otherwise confirmed quiet latches the protocol track in one fresh ring, after which speech/push begin their own delays. Continuous output may defer forever.

Two ordering rules:

- **Clear the progress cycle *before* dispatch**, so a completion or error ends the cycle whether or not the event is claimed and `OSC_NOTIF_BUSY` falls back either way.
- **Dispatch a command finish for every watch that existed**, including the short, unarmed, and attended ones the ring rule then discards.

Source of truth: `registerCompletionClaimant` / `dispatchCompletion` / `deferOrDeliverNotification` / `flushDeferredNotification` in `lib/src/lib/alert-manager.ts`; `quietAt` in `lib/src/lib/quiesce-detector.ts`.

## Await

An **await** parks on one Session until it finishes what it is doing, then reports why the wait ended — the claimant the seam above exists for, called by a program. **Where a human and a program want different things, an await serves the program and leaves the human's channels alone.**

`until` (`dor await`'s required `--until`) names how much evidence of completion the caller accepts — a permissiveness ladder, not orthogonal modes.

| `until` | Resolves on | `cause` | For |
|---|---|---|---|
| `quiet` | The Session settled, **or** the foreground command exited, **or** the Session emitted a notification | `quiet` / `exit` / `bell` | Agents that never exit — `claude`, `codex` |
| `exit` | The foreground command exited. Nothing else | `exit` | Builds, test runs, migrations |

- **Never narrow `quiet` to silence alone, and never let `exit` resolve on a bell** (rationale).
- **`--until` has no default and is never inferred from the WATCHING rule set** (rationale).
- **Silent is not settled.** Settling comes from the always-on detector (WATCHING Track), which needs no shell integration and cannot fire until it has been BUSY (rationale).

**Is there anything to wait for?** Silence cannot separate a peer that answered long ago from one working quietly.

| At await time | Behavior |
|---|---|
| A foreground command is running (`commandExitWatch`) | Park, no grace window; a silent build resolves on its exit rather than being guessed at. |
| Nothing running | Park for one grace window. A *command start* cancels it under either `until`; under `quiet` so does *output*, under `exit` output alone does not. Either way the await then waits for a real signal. Neither → resolve `cause: idle`. |

**`idle` is a resolution, not a failure** (rationale). Absent shell integration "is a command running" is unanswerable, so an `exit` await there falls back to the grace window and resolves `idle` rather than erroring.

**Resolution consumes only the ring it resolved on**, its cause named by *that ring's own source*: protocol → `bell`, command-exit → `exit`, WATCHING → `quiet`. An await arriving mid-ring resolves immediately; under `exit` only a command-exit ring counts, the others being the human's and the await keeps waiting. Two are gated, their latches outliving the fact they describe:

- **Skip a command-exit ring while a foreground command is running** (rationale).
- **Skip a WATCHING ring once output has resumed since it latched** (`outputSinceWatchingRing`), and **never stand the detector in for that flag** (rationale).
- **Never skip the bell**: an `OSC 9` is a discrete "I need input" that stays true until it is answered.
- **Consuming releases that one track's latch and nothing else** — `todo` is neither set nor cleared, no `ActivityNotification` is dropped, and `attentionId` is never set.

**Absorption: absorb the summons, keep the receipt.**

- **A consumed completion never latches a ring**, so it does not ring the bell, speak an alarm, or push to a paired phone; nothing quieter is substituted (rationale).
- **Absorption is per-signal, not per-Session** — a human's own WATCHING rule on that Session still rings on the next settle.
- **A failed await absorbs nothing.** A timeout, a death, or a cancel claims no completion, so a crashed orchestration cannot silently eat the human's signal.
- **An await never sets TODO, and never clears a pre-existing one** (rationale).
- **Claiming is delivery.** Once handed to an await the wait is settled and a later `cancel()` is a no-op — no release-after-claim, so the claim-to-read window is unacknowledged (rationale).

**Timing.** Every window derives from `cfg.alert`:

| Window | Value | Source |
|---|---|---|
| Grace — "did anything start?" | 2000ms | `AWAIT_GRACE_MS` = `busyCandidateGap` + `busyConfirmGap`, the detector's floor for reaching BUSY |
| Settle — "has it stopped?" | 5000ms | `mightNeedAttention` + `needsAttentionConfirm` |
| Ceiling | `timeoutMs` | `dor await`'s `--timeout` (seconds, default 600), the only number not derived from `cfg.alert` |

`timeoutMs` is the safety rail on a blocking call inside an agent loop, not an alert-tuning knob.

- **Enforce it host-side**, with the grace and settle windows, so no hop can reap a parked await early and no caller can park forever by lying about its deadline.
- The host's `MAX_AWAIT_TIMEOUT_MS` matches the CLI's 1–86400 whole-second range (`docs/specs/dor-cli.md`); a ceiling exists at all because `setTimeout` overflows past ~24.9 days (rationale).
- **Reject a non-finite, non-positive, or over-ceiling request rather than clamping it** — it settles `cancelled`, absorbing nothing; the webview handler rejects the same values with a visible error.

**Several awaits may park on one Session**, sharing one claimant: a completion goes to every await whose condition it satisfies, not only to whoever registered first, each resolving on the first qualifying signal after it registered.

**In VS Code an await crosses the webview -> extension-host boundary**, and the wait itself never leaves the host:

- The webview posts `alert:await` and, if it gives up, `alert:awaitCancel`; **the host answers exactly one `alert:awaitResult` per request**, a cancel included, so a claim is never released twice.
- **A disposing webview must cancel everything it had parked, and must answer those requests itself *synchronously*** (rationale).
- `cancelled` has no wire outcome of its own: the webview reports it to `dor` as an error, which is also what forgets the in-flight control request.
- Other hosts call `awaitCompletion` in-process. The Pocket phone adapter has no `dor` and protocol-v1 carries no await, so it settles any request `cancelled` at once.

**A PTY exit or Session removal resolves every waiter still parked as `died`**, after command-finish dispatch gets first chance to resolve normally. Manager disposal and live transfer suspension resolve every waiter as `cancelled`.

Source of truth: `awaitCompletion` in `lib/src/lib/alert-manager.ts`; `alertAwait` in `lib/src/lib/platform/types.ts` and `lib/src/lib/platform/vscode-adapter.ts`; `vscode-ext/src/message-router.ts`.

## WATCHING Track

**Must key WATCHING by foreground command name.** A Session is watched exactly while that name belongs to the watched set; edits reach every matching Session. **Never add per-Session enable or mute** (rationale).

**The output/silence detector is always on.** Every Session runs one `QuiesceDetector` for its whole lifetime, fed by every output chunk and reset at every command boundary. It never latches and knows nothing about attention or rules; the rule set decides only whether its state is publicly visible and whether a settle — a busy Session that stayed quiet — may *ring*.

**A retired id must stay retired.** `disposeSession` retires the alert state and only *then* kills the PTY. **Raw output and resizes never revive a retired id**; a semantic or protocol event may (rationale).

Rules:

- The key is `commandArgv0(rawCommandLine)`: everything before the first pipeline/compound boundary, skipping leading `VAR=value` assignments and a leading `env`, then argv[0] reduced to its basename minus any launcher suffix (`docs/specs/terminal-state.md`). So `foo | claude` keys on `foo`, matching what bash's `DEBUG` trap reports. Pinned by `lib/src/lib/watched-commands.test.ts`.
- **Every command boundary resets the detector** — `commandStart`, `commandFinish`, `promptStart`, `promptEnd`, and PTY exit — even without a command watch. Pinned by `resets unwatched output history on %s without a command watch` in `lib/src/lib/alert-manager.test.ts`.
- **Editing the rule set re-derives WATCHING across every live Session immediately**, so a mid-command enable shows what that command is doing *right now* rather than a fresh `NOTHING_TO_SHOW` (rationale).
- **A WATCHING ring outlives the command that raised it.** Watching switches off when the watched command exits; its ring and originating command key remain in `watchingRingingCommand`.
- **Removing a rule silences its WATCHING rings**, even after the command has exited; other dismissal paths follow Clearing And TODO. A command merely ending never clears the ring.
- **The rule set is app-global and persisted** (`dormouse:watched-commands`), starting empty, so WATCHING is off everywhere until the user turns it on. **The host is authoritative wherever one serves several webviews** — the VS Code extension host, and the standalone sidecar — so a stale webview can neither replace unrelated rules nor keep reporting an obsolete list: the first webview's persisted copy is taken as the seed, an edit is a delta, and the host broadcasts its canonical snapshot back. The seed/mutation/broadcast wire contract is `docs/specs/transport.md`.

**Limitation:** WATCHING needs the shell to report command boundaries (`OSC 633` / `OSC 133`). Shells without integration (`docs/specs/terminal-escapes.md`) never report a command name, so WATCHING never engages and the bell reports "nothing is running". Terminal reports still work; command-exit alerting also requires semantic command boundaries. **Never route the keystroke fallback in `docs/specs/terminal-state.md` into the `AlertManager`** (rationale).

| State | Meaning |
|---|---|
| `WATCHING_DISABLED` | No rule matches, so the detector's state is not shown. |
| `NOTHING_TO_SHOW` | A rule matches, but no reminder is owed. |
| `MIGHT_BE_BUSY` | Output may be turning into ongoing work. Debounce. |
| `BUSY` | Enough output to treat the Session as doing work. |
| `MIGHT_NEED_ATTENTION` | A busy Session went quiet. Debounce. |
| `ALERT_RINGING` | Likely completion observed while the Session lacked attention. |

Meaningful output excludes resize redraw noise during `T_RESIZE_DEBOUNCE`; theme changes, remounts, DOM reparenting, selection, and focus changes are not output. Invariants:

- Output drives the detector up `NOTHING_TO_SHOW` -> `MIGHT_BE_BUSY` -> `BUSY`; silence drives it down `BUSY` -> `MIGHT_NEED_ATTENTION` -> settled. The `MIGHT_*` states are debounce windows in both directions.
- First output starts candidate tracking without changing status; unconfirmed `MIGHT_BE_BUSY` returns to `NOTHING_TO_SHOW`.
- **Must discard unconfirmed candidate history after an output gap beyond `busyCandidateGap + busyConfirmGap`, including when a timer runs late** (rationale). Pinned by `forgets stale candidate history` and `expires candidate history even when the confirmation timer has not run` in `lib/src/lib/quiesce-detector.test.ts`.
- **The detector never holds `ALERT_RINGING`.** It reports each settle once and returns to `NOTHING_TO_SHOW`; rings latch in `watchingRingingCommand`.
- **With `deferAlertsUntilQuiet`, withdraw a WATCHING ring when watched work resumes confirmed BUSY.** Preserve the detector, TODO, notification detail, and other tracks. The next unattended settle restarts speech/push delays. Short redraws and post-exit output retain the ring (rationale).
- **A settle rings only if** a rule matches the foreground command *and* the Session lacks attention at the confirmation moment.
- **Never reset the detector for attention alone**; settles must reach awaits. **Must reset to `NOTHING_TO_SHOW` when attending or dismissing a WATCHING ring**, preventing its output tail from settling again.
- **Rings must be caused by a fresh transition** — a settle the detector just reported — never by rerender, theme change, remount, minimize, or reattach.

Source of truth: `commandArgv0` in `lib/src/lib/terminal-state.ts`; `QuiesceDetector` in `lib/src/lib/quiesce-detector.ts`; `onSettled` / `withdrawResumedWatchingRing` in `lib/src/lib/alert-manager.ts` (pinned by `lib/src/lib/alert-resumed-output.test.ts`); renderer mirror `lib/src/lib/watched-commands.ts`, multi-renderer coordinator `lib/src/lib/watched-command-host.ts`.

## Terminal reports

**Terminal notifications are independent of WATCHING** and follow the deferral policy in Completion events. **Never ring an attended Session**; suppression leaves unrelated protocol progress alone. A ring sets `todo = true`, stores the latest sanitized `ActivityNotification`, and sets `protocolStatus = ALERT_RINGING`; clearing returns it to `IDLE` and public status falls back to the other tracks.

Sequence syntax lives in `docs/specs/terminal-escapes.md`; what each means here:

- **Standalone `BEL`** — stripped from visible output and creates `TERMINAL_BELL_NOTIFICATION`. If the same parse batch also holds a richer OSC notification or progress event, **drop the generic bells** so they cannot overwrite useful preview text; multiple bells in one batch collapse to one notification.
- **`OSC 9`** — the message becomes the body, title null. Empty sanitized messages are ignored. It also feeds title-candidate derivation (`docs/specs/terminal-state.md`), with no alert effect.
- **`OSC 777`** — only the `notify` subcommand is supported. The first field after `notify` is the title; everything after the next semicolon is body, preserving semicolons there. Unsupported subcommands and empty sanitized notifications are ignored.
- **`OSC 99`** (kitty) — metadata keys are single ASCII letters separated by `:`; unknown keys are ignored. `i` groups chunks of one pending notification, `d` is the done flag (default `1`), `e` selects plain or base64 payload encoding, `p` selects the payload type (default `title`). `title`/`body` chunks append; completion rings once if the sanitized title or body is nonempty. Without `i`, only a complete single-sequence notification is meaningful. **Management payloads contribute no content and are consumed**: `p=?` sends `OSC99_SUPPORT_PAYLOAD`; `p=close` / `p=alive` are dropped outright, touching no pending notification. Any *other* unknown payload type still obeys the done flag: with the default `d=1` it completes a pending same-`i` notification, which may then ring on its accumulated title/body. Incomplete chunk state is capped and expired.
- **`OSC 9;4` progress** — progress only: no title, body, urgency, id, app name, or action fields.

  | Input | Behavior |
  |---|---|
  | active normal / warning / indeterminate | `protocolStatus = OSC_NOTIF_BUSY`, no TODO; never rings from silence |
  | `state=1, progress=100` | rings as completion, unattended only |
  | `state=2` | rings as error, unattended only |
  | clear | rings as completion only if a cycle was active, else ignored |
  | completing a *warning* cycle | rings with a generated warning title |
  | invalid state, missing percent for `1`/`4`, out-of-range percent | ignored |
  | completion or error while attended | clears the progress, no TODO or ring |

Source of truth: parsing, sanitization limits, and OSC 99 chunk state in `lib/src/lib/terminal-protocol.ts`; `completeProtocolProgress` / `finishProtocolProgressCycle` in `lib/src/lib/alert-manager.ts`.

## Command-exit Track

The command-exit track consumes normalized semantic command events from `docs/specs/terminal-state.md` (`OSC 133`, `OSC 633`, or equivalent) and **must not parse raw OSC itself**.

Rules:

- A command start creates `commandExitWatch` for the current foreground command. **Mark the command as seen** if the Session has attention then, or if the user attends while it is already running.
- If attention is later lost while that same seen command is still running, set `commandExitStatus = COMMAND_EXIT_ARMED`.
- If the same command finishes, or the PTY exits before a finish event, **ring only when all three hold**: it was armed, the Session still lacks attention, and runtime is at least `T_USER_ATTENTION`.
- A command-exit ring sets `todo = true` and stores the COMMAND_EXIT notification (title "Command finished", body = summarized command + exit code).
- Returning to the Session before finish disarms the watch. A quick finish, a different command start, or Session destruction clears it without ringing.
- **Race rule:** attention must be lost before the finish event is observed.
- **Precedence rule:** a protocol ring keeps its richer `ActivityNotification`; command-exit must not overwrite it.

Command starts and finishes also drive the WATCHING rule above, so the two tracks share one `commandExitWatch` record and one `resolveCommandStart` helper with the terminal-state reducer.

Source of truth: `applyCommandExitRinging` / `formatCommandExitBody` in `lib/src/lib/alert-manager.ts`; `resolveCommandStart` in `lib/src/lib/terminal-state.ts`.

## Clearing And TODO

`todo` is a boolean reminder. Protocol and command-exit rings create it immediately. **WATCHING rings create it when the user attends, dismisses, or marks TODO**, so a dismissed ring does not disappear without a trace.

Clearing behavior:

- Attending a ringing Session clears active rings on all three tracks and sets `todo = true`.
- Dismissing the ring from the alert button or `a` (Pane Header) sets `todo = true` and opens the terminal context. **Dismissing a Session with nothing ringing changes nothing and notifies no one.**
- Marking TODO clears any active ring and leaves the WATCHING rule in place for future cycles.
- **Must clear notification and active rings when clearing TODO, even if `todo` is already false.** Pinned by `clears a WATCHING ring before it has created a TODO` in `lib/src/lib/alert-manager.test.ts`.
- Passthrough `Enter` typed into the Session clears TODO. Command-mode `Enter` that only enters passthrough does not.
- Removing a WATCHING rule turns watching off wherever it matched and silences the WATCHING rings it raised. It does not stop the detector, nor clear protocol progress, command-exit arms, TODO, or notification detail.
- Destroying the Session clears all alert, TODO, notification, attention, protocol, and command-exit state.

## Live Workspace transfer

- **Must transfer live alert state separately from persisted reminders:** track latches, episode, command watch, deferred notification, and detector history/deadlines travel in the marked transfer content. **Never read this content on cold restore.**
- **Must suspend source delivery before handing ownership to the host and freeze its detector, rule walk, and controls at content capture.** The destination restores receipts after persisted seeding and before the runtime publishes, then enables delivery only after `adopt_done` succeeds. Refusal restores the source runtime and pending deadlines; source removal follows adoption. **Must await host hand-back after source content capture fails**, retaining delivery suspension until routing returns.
- **Must discard imported runtime, Activity, and pane state before releasing the delivery guards on any target failure**, mount or no mount, so a watcher never re-arms on a Workspace this window never owned. A receipt forgotten on an episode already observed is consumed, never fresh.
- **Must carry per-sink receipts with the episode:** pending/queued work retains its original deadline; engine-admitted speech and dispatched push are consumed and never replayed. Suspending cuts current speech; a partially heard utterance is not restarted after a move or refusal.
- **Must cancel parked await callers at suspension**, carrying no claimant closures or attention lease. Source attention loss arms a running command; destination interaction establishes its own attention.
- **Must process notification events and visible output from the one since-mark replay that carries the arrival's request token, once.** Any other replay, whatever its token, stays historical and silent; query responses are never replayed. The parser boundary limitation follows `docs/specs/transport.md` → Transferring a Workspace.

Source of truth: `pauseForTransfer` / `resumeFromTransfer` / `applyReplay` in `lib/src/lib/alert-manager.ts`; `snapshot` / `restore` in `lib/src/lib/quiesce-detector.ts`; `snapshotAlertDelivery` / `restoreAlertDelivery` in `lib/src/lib/alert-delivery-state.ts`; `planArrival` / `discardArrival` in `standalone/src/workspace-move.ts`. Pinned by `lib/src/lib/alert-runtime-transfer.test.ts`, `lib/src/lib/alert-delivery-policy.test.ts`, and `standalone/src/workspace-move.test.ts`.

## Alarm settings

Application alarm defaults live beside the WATCHING rule set, edited in **Settings** (below), which also carries the theme picker ([theme.md](./theme.md)), the shell picker ([standalone.md](./standalone.md)), and the remote-control section ([relay.md](./relay.md)). **Each of those keeps its own store — never fold one into `AlertSettings`**, which is relayed wholesale to the host. **A host revalidates the blob before installing it** (`normalizeAlertSettings`): a webview must never be able to hand it a NaN or an absurd timer. Both stores run the same two classes in either host (`lib/src/lib/watched-command-host.ts`, `lib/src/lib/alert-settings-host.ts`), bound for standalone by `lib/src/host/alert-store-host.ts`; the shape, its defaults and its validation are the platform-free `lib/src/lib/alert-settings-model.ts`.

| Field | Meaning |
|---|---|
| `inactivityTimeoutMs` | `T_USER_ATTENTION` — the walk-away window defined under Attention. |
| `deferAlertsUntilQuiet` | Gates animation deferral (Completion events) and resumed-ring withdrawal (WATCHING Track). Default on. (rationale) |
| `speakEnabled` / `speakDelayMs` | Spoken alarms, below. |
| `pushEnabled` / `pushDelayMs` | Push notifications, below. |

The speech row's managed-voice link follows
[website-docs.md](./website-docs.md) -> `/hosted` preview.

Rules:

- **Validate and clamp every field on read *and* on write** (`normalizeAlertSettings`), so a hand-edited `localStorage` blob or a hostile message can never install a `NaN` or absurd timer. Unknown keys are dropped and missing keys defaulted, so the blob evolves additively with no version field. `cfg.alert` owns the inactivity default; `DEFAULT_ALERT_SETTINGS` owns the sink and boolean defaults.
- **Distribution follows the WATCHING rule set's seed/broadcast shape** (rationale), except that an edit **relays the whole blob** rather than a per-command delta, so every webview resolves workspace overrides against the same defaults. Wire contract and host revalidation: `docs/specs/transport.md`.
- **Must keep detection settings application-wide.** Standalone and browser-sidecar renderers apply detector settings to their local manager; VS Code applies them in the extension host.

**Must resolve delivery policy from application defaults, then sparse Workspace overrides.** Speech/push enable and delay can override independently; `speakVoice` selects a local engine voice URI, missing inherits the system-voice default, and explicit null selects the system voice. Missing or unavailable voices fall back to the engine default without erasing the saved choice. Unknown/invalid overrides are dropped; finite delays share the application clamp.

**Must persist overrides in the Workspace's `PersistedSession.alertDelivery` in both hosts**, preserving them through rename, reorder, save, and live move. Reset removes overrides, restoring inheritance. A pane resolves its current parent Workspace; a pane without membership uses application defaults.

Both sinks use `watchUnattendedRings`:

- **Must deliver at most once per sink per episode**, independently per Session, with a deadline fixed when the fresh episode is observed.
- **Must recheck episode identity and effective policy before delivery.** Disabling consumes pending work immediately, suspended for a move included; enabling never replays the same episode. Delay edits do not move existing deadlines; speech reads the current voice at engine admission.
- **Must seed first-observed ringing snapshots silently**, except explicitly transferred pending receipts (Live Workspace transfer). Receipts outlive a watcher; a restarting watcher prunes those of Sessions that left unpaused.

Source of truth: `normalizeAlertDeliveryOverrides` / `resolveAlertDeliveryPolicy` in `lib/src/lib/alert-delivery-model.ts`; `getSessionAlertPolicy` in `lib/src/lib/alert-delivery-policy.ts`; `setWorkspaceAlertDelivery` in `lib/src/lib/workspace-store.ts`. Pinned by `lib/src/lib/alert-delivery-policy.test.ts`.

| Contract | Speech | Push |
|---|---|---|
| Gate | Desktop shell, after `speakDelayMs`; a missing backend is a silent no-op. | Desktop shell with an enrolled Burrow, after `pushDelayMs`. |
| Payload | Pane label via `toSpokenText`; fallback `terminal`. | Same label via `toPushText`, plus a fixed body; fallback `terminal`. |
| Never payload | The ringing `ActivityNotification`. | The ringing `ActivityNotification`. |
| Delivery identity | Episode receipt plus native attempt identity; renderer-local `speaking` / `spoken`. | HTTP push tagged by Session id, so a newer ring replaces the prior notification. |
| After delivery | Attending cuts off speech. | **Never recall** — another push would only replace one stale notice with another. |
| Failure | A refused or unavailable engine produces no marker. | Warn on non-2xx, partial, or zero delivery; **never retry** stale alarms. |
| Authority | The renderer invokes `window.speechSynthesis`. | The webview names Session/title; the Burrow selects active ACL devices, the Relay intersects subscriptions. |

Source of truth: `AlertSettings` in `lib/src/lib/alert-settings.ts` (renderer mirror, persisted at `dormouse:alert-settings`); `lib/src/lib/alert-settings-host.ts`; `watchUnattendedRings` in `lib/src/lib/alert-ring-watch.ts`.

### Spoken alarms

- **Must replace high-entropy ASCII tokens with `REDACTED` locally before punctuation cleanup and truncation**, including trailing padding but preserving `=` separators (rationale). Hex candidates include embedded hyphen/underscore groups. False positives and negatives remain possible; word-passphrase detection is excluded. Pinned by `lib/src/lib/redact-high-entropy.test.ts` and `redacts whole tokens before punctuation cleanup and truncation` in `lib/src/lib/alert-speech.test.ts`.
- **The label must be sanitized before it reaches the engine** (`toSpokenText`): all Unicode punctuation, symbols, and `Other` characters (including controls, bidi controls, and zero-width formats) become spaces, except apostrophes, which are elided so contractions survive; letters, numbers, and their combining marks from every script remain. Whitespace collapses, the result is capped in code points, and an empty result falls back to `terminal`. **Security, not tidiness:** WebKit wedges its synthesizer on angle brackets, and terminal-supplied text reaches Pane labels (rationale).
- **Delivery state follows actual engine callbacks, not queue admission.** `AlertSpeechState` is a renderer-local `speaking | spoken` map keyed by Session: `start` publishes `speaking`; `end`, or `error` after a real start, publishes `spoken`; an utterance that never starts publishes neither. **Must check delivery identity before accepting `start` or completion**, including after cancellation, timeout, or teardown. Pinned by `ignores an older ring starting after a newer ring has begun speaking` and `recovers from a callback-less engine without accepting its later callbacks` in `lib/src/lib/alert-speech.test.ts`.
- **Nothing in the settle path may assume the callback arrives after `speak()` returns** — an engine may dispatch `start` then `end`/`error` *synchronously* inside `speechSynthesis.speak()` (rationale). Handlers therefore close over the utterance itself and registration happens before dispatch. A dispatch the engine refuses outright settles too.
- **Attending mid-sentence cuts the utterance off** — silence the engine, not merely un-render the overlay. "Mid-sentence" is the sink's own record that an utterance started — its generation token — never the rendered `speaking` state.
- **Must admit only one utterance at a time to Web Speech per renderer**, including Settings tests; pending jobs remain in Dormouse. **Must remove resolved, disabled, or suspended pending jobs before engine admission**, without cutting another pane's current utterance. Pinned by `never admits a resolved queued alarm to the speech engine` in `lib/src/lib/alert-speech.test.ts`.
- **Must bound pending jobs at 64**, rejecting later admissions while full. **Must cancel an engine attempt after 60 seconds without completion** and advance the queue; detached late callbacks cannot change the new attempt. No automatic retry follows failed, expired, or overflowed delivery.
- **Must revoke callback identity before engine cancellation**, including synchronous callbacks. Teardown cancels the current engine utterance and drops pending jobs.
- `speaking` / `spoken` remains only while the originating Session is still `ALERT_RINGING`: any action that resolves the ring (Clearing And TODO) clears it, killing the Session included, while visibility, hover, and command-mode selection do not. **Never persist it or send it to the host**, so restore/reconnect cannot recreate it.

Source of truth: `toSpokenText` in `lib/src/lib/alert-speech.ts`, armed by `lib/src/components/wall/use-alert-speech.ts`; `SpeechQueue` in `lib/src/lib/speech-queue.ts`; `redactHighEntropyTokens` in `lib/src/lib/redact-high-entropy.ts`; label derivation in `lib/src/lib/session-label.ts`; `AlertSpeechState` in `lib/src/lib/alert-speech-state.ts`.

### Push notifications

**The two halves run in different processes.** Ring *detection* is webview state, so `watchPushRings` stays in the webview and fires one `push { sessionId, title }` command at the Burrow service. *Delivery* needs the enrollment and the ACL, which only the Burrow holds, so `sendPush` runs in the service's process and touches no DOM or store. **A webview cannot choose recipients:** it names the Session and what to call it; the service reads its own active ACL at send time. **Arm watching only while the service reports an enrollment** (`enrolled-gate.ts`), so an un-enrolled machine pays no activity-store subscription; a `push` arriving with no Burrow running is not sent. **Keep both halves under `remote/burrow/`**, inside the lazily-imported `RemotePairingModalHost` chunk, so a host without `enableBurrow` never fetches it (rationale).

- **The label is sanitized by `toPushText` at send time, in the delivery half, and not by `toSpokenText`'s rule** (rationale). It keeps angle brackets and instead strips control characters and the Unicode bidi and zero-width format characters (including the Arabic letter mark), which can visually reorder or hide text in an OS notification; the cap counts code points, so a cut never ships half a surrogate pair. `toPushText` is only this sink's limit and fallback over `boundedPushText` in `remote-lib-common/src/security/push.ts`.
- **The Burrow bounds, then seals; the worker re-bounds at the render sink.** Title, body, and tag are sealed to each recipient's own Client static and the Relay forwards ciphertext, so the second pass runs in `lib/src/remote/pocket-app/sw.ts`, which imports the *same* `boundedPushText` rather than mirroring it (`docs/specs/remote-security-model.md` -> Push sealing).
- **The Burrow names its targets; the Relay rejects a send that does not.** Targets are the Burrow's *active* ACL records, read at send time so a revocation during the delay takes effect, and the Relay intersects them with its own subscriptions. **One sealed envelope per recipient** — a Client static is not a group key — so a send names each `deliveryId` beside the ciphertext only that phone can open, **clamped to `MAX_PUSH_QUERY_DELIVERY_IDS`** because the route refuses the whole POST past it. Nothing propagates a revocation today (`docs/specs/remote-security-model.md` -> Future), so a Relay that chose recipients itself would keep pushing to a de-authorized phone (rationale). The Burrow does **not** ask which devices are subscribed first (rationale).
- **The settings dialog re-reads the device list when it opens** (`refreshPushDevicesNow`) — a phone can enable alerts long after this machine booted. **Must keep the transient preview on the cached list without refreshing.** The list is the Burrow's join of the Relay's subscriptions against its own ACL labels, arriving over the same bridge as a `pushDevices` command and answering `null` — rendered `no-burrow` — when no Burrow is running.
- **Writes are fenced on request order** (latest-request-wins), and the enrolled gate's disarm both invalidates in-flight refreshes and clears the list, so nothing already on the wire can repopulate the dialog with phones there is no longer anything to push to. `clearPushDevices` keeps the refresher installed — an un-enrolled machine may still ask and be told `no-burrow` — while `resetPushDevices` drops it too and is full teardown.

Source of truth: `watchPushRings` / `invalidatePushDeviceRefreshes` in `lib/src/remote/burrow/alert-push.ts`; `sendPush` / `toPushText` in `lib/src/remote/burrow/push-delivery.ts`; `refreshPushDevicesNow` / `clearPushDevices` / `resetPushDevices` in `lib/src/lib/push-devices.ts`.

### Settings dialog

Reached from the baseboard sliders; `docs/specs/layout.md` owns placement. The alarm sections sit under the theme and shell rows; when both are hidden (VS Code owns the theme and the shells), the rule list is first and drops its section divider.

- **Must toggle only the clicked baseboard alarm setting**, as an override for that Workspace, showing the effective value. Components without a Workspace scope edit application defaults. **Must show its shared settings section for 2 seconds, then fade for 250ms**, anchored to the button and bounded by the viewport. The preview is inert, announces the resulting state, preserves keyboard focus and command dispatch, and omits test actions. Each click replaces the preview and restarts its lifetime; opening Settings or unmounting clears it. Reduced motion skips the fade. Pinned by `Baseboard.test.tsx`.
- Lists every watched command with a remove control, and **cannot add one** — WATCHING is keyed on a running command's name, so creating a rule stays the terminal context of a Pane running it, and the empty state says so. **It is the only place a rule set on a since-closed Pane can be removed**, the terminal context reaching only the command its own Pane is running.
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

**Must keep presentation generations outside the union.** The strip tracks each existing member’s `ringSeq`; an increase while ringing starts one finite Workspace cue, including while that Workspace is active. Adding/restoring/transferring a member seeds its counter silently; removal and Workspace switching never synthesize a cue. Returning to an inactive indicator resumes its original animation clock. Pinned by `lib/src/lib/workspace-ring-cues.test.ts`.

**Must keep the projection display-only:** it never enters the Activity machine or fires its own ring. A Surface with no activity entry contributes nothing. Callers **must include** minimized (`Doored`) Surfaces.

**Must project every Workspace, active or not.** The Activity store spans the whole Window, so what scopes it to one Workspace is the membership each mounted Wall publishes — panes ∪ doors, on every layout commit.

Source of truth: `computeWorkspaceUnion` in `lib/src/lib/workspace-union.ts`; `setWorkspaceSurfaces` in `lib/src/lib/workspace-surfaces.ts`; `lib/src/lib/workspace-union.test.ts`; `WorkspaceRingCues` in `lib/src/lib/workspace-ring-cues.ts`.

Where it surfaces is host-specific:

- **VS Code** reflects the terminal portion onto native chrome — `docs/specs/vscode.md`, which also owns why browser-surface TODO stays webview-local.
- **Standalone** shows terminal rings/TODOs on panes and doors, and a browser Surface's `todo` on its own door. A **hidden** Workspace's tab additionally carries its union's TODO pill and bell, with `count` in the tab's accessible name; the visible Workspace's tab carries none, its panes and doors already saying it (`WorkspaceStrip` in `lib/src/components/WorkspaceStrip.tsx`).

**Must use `alarm-vs-header-inactive` for the hidden Workspace tab's bell**, matching its inactive-header background.

## UI Contract

### Pane Header

The header shows an alert bell, a fixed-text `TODO` pill when `todo === true`, a hover/focus notification preview when TODO has `notification`, and the terminal context opened by right-click or by the alert button. Placement, sizing, and width tiers belong to `docs/specs/layout.md`.

Bell rotation follows public status; motion follows latch edges. **When a track latches, ring each mounted bell for four 800ms cycles, then hold 45° until the ring clears** (test: `runs a finite ringing burst and then holds the bell at 45 degrees` in `lib/src/components/bell-icon-class.test.ts`; rationale). **A newly mounted ringing bell may replay once without advancing `ringSeq`** (test: `replays the finite burst when a ringing presentation remounts` in `lib/src/components/AlertBell.test.tsx`; rationale). **A newly latched track replays the burst; further reports on that track only enrich its summons.** `AlertState.ringSeq` counts per-Session latches and is compared by `alertStatesEqual` (tests: `counts a second track ringing behind an already-latched one` and `does not count a track that is already ringing` in `lib/src/lib/alert-manager.test.ts`, `replaces the icon when the ring counter advances` in `lib/src/components/AlertBell.test.tsx`; rationale). **Remote Clients have no counter:** `DirectoryEntry.ringing` is an edgeless boolean, so Pocket rings on mount and holds.

- **The alert button, and `a` on the selected Pane in command mode, dismiss a ringing Session and open the terminal context, whatever the status; they never edit a WATCHING rule.** The button names that action — `Dismiss alert` while ringing, `Alert settings` otherwise — not a toggle.
- **A WATCHING rule is created only in the terminal context** ("Watch all `<cmd>` commands"), which offers the row whenever a foreground command is running, and removed there or in Settings. Removing it anywhere drops it for every Session running that command.
- Right-click always opens the context. Pressing `t` toggles TODO.
- **The mobile header's alert button only dismisses** — the mobile composition has no terminal context (`docs/specs/mobile-terminal-ui.md`).

**Must keep context alert controls scoped to the source**, with TODO, running-command WATCHING, and notification detail. Settings owns the global watched-command list. **Must suppress helper alerting until promotion, including after exit**, covering bell/notification protocols, watched commands, TODO, speech, push, and attention projections; semantic command/readiness state remains active. Promotion starts ordinary alert behavior without replaying suppressed events.

Source of truth: `TerminalContext` in `lib/src/components/wall/TerminalContext.tsx`; `setHelper` in `lib/src/lib/alert-manager.ts`, which every host calls at helper spawn, listing, and promotion.

The TODO pill always displays `TODO`; remote notification text belongs in preview/detail surfaces, not inside the pill. Clicking the pill clears TODO, and on clear the pill briefly shows the success flourish before unmounting.

Spoken-alarm delivery is much louder than the bell: a pointer-transparent treatment spans the whole terminal Pane, labelled `SPEAKING` while the engine actually speaks and `SPOKEN` — quieter, and unbounded — until the ring resolves. **`prefers-reduced-motion` keeps the strong static treatment and suppresses only the pulse**, as does `cfg.alert.ringingPaused` (rationale). The layers, their strengths, placement, and sizing belong to `docs/specs/layout.md` → Spoken-alarm overlay.

Source of truth: `AlertBell` in `lib/src/components/AlertBell.tsx`; `bellIconClass` in `lib/src/components/bell-icon-class.ts`; `latchRing` in `lib/src/lib/alert-manager.ts`; `dismissSessionAlert` in `lib/src/lib/session-activity-store.ts`; `TerminalContext` in `lib/src/components/wall/TerminalContext.tsx`; `lib/src/components/TodoPillBody.tsx`; `lib/src/components/wall/AlertSpeechIndicator.tsx`.

### Door

A Door is display-only for alert state:

- show the bell only when `status !== 'WATCHING_DISABLED'`
- show the TODO pill when `todo === true`
- use the same bell tilt/animation mapping as the Pane header
- while its Session is `speaking`, replace the compact bell/TODO cluster with the explicit `SPEAKING` label and invert + pulse the whole Door — that state lasts one utterance. `spoken` persists until the ring is attended, so it keeps a static high-contrast inset and adds a speaker icon *alongside* the bell and TODO pill instead of replacing them; those are the baseboard's persistent signals and **must not go dark for an unbounded window**
- do not expose a Door-specific alert menu

Click or `Enter` on a Door reattaches into passthrough and clears a ring; `d` reattaches in command mode and leaves the ring intact (Attention).

## Text And Security

Notification text is untrusted terminal output.

- Treat all text as plain text: never interpret ANSI, OSC, HTML, Markdown, URLs, paths, or emoji shortcodes as markup.
- **Sanitize at protocol-parse time** (`sanitizeText` in `lib/src/lib/terminal-protocol.ts`), bounded and control-stripped like every retained value (`docs/specs/terminal-escapes.md` → Parsing location); every notification stored from a live PTY has been through that pass. `normalizeActivityNotification` in `lib/src/lib/alert-manager.ts` is only a *shape* check on top — known `source`, string-or-null fields, trimmed, at least one non-empty — so the cold-restore path (`seed`) re-accepts a persisted blob without re-applying the cap or the control strip (rationale).
- Keep only the latest `ActivityNotification` rather than unbounded history, and cap/expire incomplete OSC 99 parser state.
- **Never** execute commands, open URLs, copy to clipboard, read files, focus outside Dormouse, or render protocol-supplied icons/buttons/actions.
- Wherever notification text appears in visible UI or accessible labels, it is plain text, and layout must tolerate long text, CJK, RTL, combining marks, and emoji without pushing fixed controls out of bounds. Sanitized terminal-supplied `OSC 0` / `OSC 2` / `OSC 9` text also participates in normal Pane-label derivation, and that label may reach the opt-in speech and push channels — **each after its own second pass**, because a label safe to *render* is not automatically safe to hand a speech engine or an OS notification, and those two fail in different ways. See `toSpokenText` under Spoken alarms and `toPushText` under Push notifications.

Robustness: Sessions ring independently; minimize, reattach, rerender, resize, and theme changes preserve alert state without creating rings (WATCHING Track, glossary I3); an exited Session may keep ringing until attended, dismissed, or destroyed; ringing must not rely on color alone and must respect `prefers-reduced-motion`.
