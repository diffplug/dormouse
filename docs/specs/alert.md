# Alert Spec

> See `docs/specs/glossary.md` for Session / Pane / Door vocabulary. This spec uses it throughout.

Terminal alert state belongs to the **Session** Activity layer. It survives Pane <-> Door movement and is destroyed with the Session. This spec also defines how the Workspace union counts browser-surface TODO flags: a browser Surface has no Session Activity machine, can never ring, and carries only a user-set TODO flag as Surface state that is destroyed with that browser Surface.

Dormouse can owe the user attention in three ways:

- **WATCHING**: a command the user asked to be alerted about was running, its output became busy, then went quiet while the user was not attending the Session.
- **Terminal report**: the PTY emitted a supported notification or progress protocol (`BEL`, `OSC 9`, `OSC 9;4`, `OSC 99`, or `OSC 777`).
- **Command exit**: Dormouse saw a foreground command running while the user attended the Session, attention was lost while that same command was still running, and the command exited after at least `T_USER_ATTENTION`.

Terminal-report and command-exit alerts do not require WATCHING. All three share the same attention suppression rule — do not ring if the user is actively attending that Session at the completion moment — applied at the one seam every completion passes through (Completion events below).

Internally these are three independent tracks — `watchingRingingCommand` (+ `outputSinceWatchingRing`), `protocolStatus` + `progress`, and `commandExitStatus` + `commandExitWatch`. Each runs IDLE -> busy/armed -> ringing without entangling the others, and each latches its own ring in the entry until it is cleared. The output/silence detector (`QuiesceDetector`) is not a track: it is an always-on observer the WATCHING track reads.

## Non-goals

- No process heuristics. Dormouse never decides on its own that `vim`, `npm dev`, agents, or test runners deserve alerts. WATCHING applies only to command names the user explicitly asked for.
- No native OS notifications on the machine Dormouse runs on, and no separate progress-bar widget. The one audible local channel is the opt-in spoken alarm below, which says a Pane name and nothing else; Dormouse plays no sound effects. Push notifications are the deliberate exception and go only to a *remote* paired phone, never to this machine — the point is reaching a user who walked away.
- No process-tree introspection for command-exit alerts; normalized terminal semantic events are the reliable input.
- No HTML, Markdown, ANSI styling, clickable actions, custom icons, or remote-controlled buttons in notification previews.
- No Door-specific alert menu that changes the Door actions defined in `docs/specs/layout.md`.

## Public State

Source of truth: `AlertState` / `ActivityNotification` / `SessionStatus` in `lib/src/lib/alert-manager.ts`; the detector's own `QuiesceStatus`, which `SessionStatus` widens, is in `lib/src/lib/quiesce-detector.ts`.

Public `status` is a projection — first match wins:

1. `ALERT_RINGING` if any of the three tracks is ringing.
2. `OSC_NOTIF_BUSY` if protocol progress is active.
3. The output/silence detector's own state if WATCHING is on — that is, if the rule set matches the running command. The detector runs regardless; the rule is what makes its state public. WATCHING outranks the command-exit arm deliberately: a watched command is by definition running, so `COMMAND_EXIT_ARMED` would otherwise mask the detector's busy/quiet states for the whole run, and the detector is derived from real output.
4. `COMMAND_EXIT_ARMED` if command-exit alerting is armed.
5. Otherwise `WATCHING_DISABLED`.

`awaited` sits beside `status`: true while at least one `dor await` is parked on the Session (Await below). It is derived from live waiters and is **never persisted** — a wait cannot survive the process that was blocking on it.

Persist only `todo` and the sanitized `notification` (plus `status` for diagnostics). Restore replays those two and nothing else: it must not recreate a ring, protocol progress, or a command-exit arm. WATCHING is not per-Session state and is never persisted per Session — it is re-derived from the rule set below at the next command start. Replay filtering in `docs/specs/terminal-escapes.md` prevents old terminal output from firing notification side effects again.

## Attention

`attentionSessionId` is set only by explicit user actions that plausibly mean "I am looking at this Session":

- clicking a Pane body or Pane header
- entering passthrough on a Pane
- typing into a Session in passthrough
- clicking a Door or pressing `Enter` on a Door, because both reattach into passthrough

These do not count as attention: mere visibility, command-mode selection, hover, a Door existing in the baseboard, or reattaching a Door with `d` into command mode.

Attention is lost when the attention timer expires, the app loses focus, the attended Session is minimized or destroyed, or another Session becomes attended. `T_USER_ATTENTION` also acts as the minimum runtime for command-exit alerts: a command that ran for less than the walk-away window was probably watched, so its exit does not ring.

`T_USER_ATTENTION` is the user-facing **inactivity timeout** (Alarm settings below). It is instance state on the `AlertManager`, not a module constant, and both uses above follow the configured value. Changing it re-arms a live attention timer from that moment, so shortening the window applies immediately rather than after the window already running.

Source of truth: `cfg.alert` in `lib/src/cfg.ts` defines the shipped default for `T_USER_ATTENTION` and the other timer defaults and their purpose; `AlertManager.setInactivityTimeoutMs` installs the configured override.

## Completion events

Every completion — a detector settle, a command finish, a direct notification, and the end of a protocol progress cycle (completion or error) — is dispatched as a `CompletionEvent` **before** any suppression runs. Nothing is decided at the point of detection, so an observer sees the three-second `npm test` that finishes while the user is watching it and would never have rung anyone.

Claimants are registered per Session and get first refusal, in registration order; the first to return `true` claims the event and the rest are not offered it. A claimed event never rings, never sets TODO, and never stores an `ActivityNotification` — it stops before the ring rules. An unclaimed event falls through to its track's ring rule, which is where the attention suppression above and the command-exit armed and minimum-runtime checks live. With no claimant registered, the three tracks below behave exactly as they always have.

Two ordering rules matter. The progress cycle is cleared *before* dispatch — a completion or error ends the cycle whether or not the event is claimed, so `OSC_NOTIF_BUSY` falls back either way. And a command finish is dispatched for every watch that existed, including the short, unarmed, and attended ones the ring rule then discards.

Source of truth: `registerCompletionClaimant` / `dispatchCompletion` in `lib/src/lib/alert-manager.ts`.

## Await

An **await** parks on one Session until it finishes what it is doing, then reports why the wait ended. It is the claimant the seam above exists for, and its caller is `dor await` — a program, not a human. That single fact drives the rules below: where a human and a program want different things, an await serves the program and leaves the human's channels alone.

Source of truth: `awaitCompletion` in `lib/src/lib/alert-manager.ts`, reached through `PlatformAdapter.alertAwait`.

**The signals.** `until` — `dor await`'s required `--until` flag — names how much evidence of completion the caller will accept. The two values are a permissiveness ladder, not orthogonal modes.

| `until` | Resolves on | `cause` | For |
|---|---|---|---|
| `quiet` | The Session settled, **or** the foreground command exited, **or** the Session emitted a notification | `quiet` / `exit` / `bell` | Agents that never exit — `claude`, `codex` |
| `exit` | The foreground command exited. Nothing else | `exit` | Builds, test runs, migrations |

`quiet` includes exit because no caller wants "wake me when it settles" and also wants to keep blocking after the thing died — without it, a peer that crashes hangs its caller until the timeout. It includes the bell because an explicit `OSC 9` / `BEL` is stronger evidence than inferred silence: ignoring the peer saying "I need input" while waiting for it to go quiet would be perverse. `exit` excludes the bell deliberately — plenty of build tools ring on a warning, and being the strict one is `exit`'s whole job.

`--until` has no default and is never inferred from the WATCHING rule set. That rule set is a human notification preference — app-global, edited from a dialog — and binding a program's wake condition to it would mean an unrelated edit (removing a command from the watched set to quiet the bell) silently changes what every `await` on that Session is waiting for. The caller states its own intent instead.

Settling comes from the always-on detector, which needs no shell integration, runs for every Session regardless of the WATCHING rule set (WATCHING Track below), and cannot fire until it has been BUSY. A Session at a prompt is silent, but silent is not settled, which is what stops `dor send` followed immediately by an await from racing on the silence before the peer's first byte.

**Is there anything to wait for?** The one thing silence cannot distinguish is a peer that delivered its final answer long ago from one working quietly.

| At await time | Behavior |
|---|---|
| A foreground command is running (`commandExitWatch`) | There is something to wait for. Park, with no grace window. A silent build therefore resolves on its exit rather than being guessed at. |
| Nothing running | Park for one grace window. A *command start* cancels it under either condition — it is the same "there is something to wait for" the row above tests, arriving a moment late. Under `quiet` *output* cancels it too; under `exit` output alone does not. Whichever arrives, the await goes on waiting for a real signal. Neither → resolve `cause: idle`. |

`idle` is a resolution, not a failure: a caller that asked for quiet and found quiet got what it asked for. It is a distinct `cause` rather than a distinct failure so simple callers can treat success as success, while a careful one can still tell "it settled" from "there was never anything there". Absent shell integration, "is a command running" is unanswerable, so an `exit` await on such a shell falls back to the grace window and resolves `idle` — the host cannot distinguish a shell with no integration from one sitting at a prompt, so it degrades rather than erroring.

**Resolution consumes only the ring it resolved on.** An await that arrives while the Session is already ringing resolves immediately, with the cause named by *that ring's own source*: a protocol ring is `bell`, a command-exit ring is `exit`, a WATCHING ring is `quiet`. Under `exit` only a command-exit ring counts; the others are the human's and the await keeps waiting. A command-exit ring is skipped while a foreground command is running: it latches past the run that raised it, so once another command has started it can only describe the previous one, and answering "the command exited" about the command still running is exactly the misreport `dor send` followed by `dor await --until exit` would act on. A WATCHING ring is skipped once output has resumed since it latched. It legitimately describes the command still running — a long-running watched command going quiet is what `--until quiet` exists for — but it is an inference from silence rather than a discrete event, and nothing clears it when the peer starts talking again, so the entry records whether any output has arrived since the latch and the ring is consumed only while that is still false; otherwise the await parks for the real settle rather than answering "output stopped" about a turn that is mid-flight, which is what would make the documented `await && read` idiom read a half-drawn screen. The detector cannot stand in for that record — it never latches, so it reports how output looks *now*: it stays `NOTHING_TO_SHOW` for a full `busyCandidateGap` after output resumes, which is longer than the two CLI round trips between a `dor send` and the await that follows it, and it returns there when a burst was too sparse to confirm BUSY. The bell is never skipped: an `OSC 9` is a discrete "I need input" that stays true until it is answered, so a peer ringing mid-run still means what it said whenever the await arrives. Consuming releases that one track's latch and **nothing else** — `todo` is neither set nor cleared, no `ActivityNotification` is dropped, `attentionDismissedRing` is untouched, and `attentionSessionId` is never set.

Setting a TODO after a successful await was considered and rejected. TODO means *a human owes this pane attention*, and after an await nobody does: a program asked to be told, was told, and acted. It would also leak — the last await of an orchestration would strand a marker for an event that was fully handled — and because TODO feeds the Workspace union, an orchestration awaiting across several panes would light the whole Workspace up as needing attention. Not clearing a *pre-existing* TODO is the same rule in reverse: one left by an unrelated earlier event is still owed to the human.

**Absorption: absorb the summons, keep the receipt.** A completion an await consumes never latches a ring, so it does not ring the bell, speak an alarm, or push to a paired phone — the program is already handling it, and summoning the human too is noise. Nothing quieter is substituted: a receipt the human must clear by hand is the same noise in a smaller font, and forensics after a failure come from the pane's own scrollback. Absorption is **per-signal, not per-Session**: an await consumes the signal it resolved on, and if the human independently holds a WATCHING rule on that Session, the next settle rings for them as usual. A failed await absorbs nothing — a timeout, a death, or a cancel claims no completion, so a crashed orchestration cannot silently eat the one signal that would have told the human the build finished.

Claiming is delivery. Once a completion has been handed to an await the wait is settled and a later `cancel()` is a no-op; there is no release-after-claim. The window between claiming and the caller actually reading the outcome is therefore unacknowledged, and that is accepted: closing it would need a two-phase claim on every completion to cover a process that dies in the microseconds after its answer was computed.

**Timing.** Every window derives from `cfg.alert`, so an await inherits the tuning the bell has had in the field:

| Window | Value | Source |
|---|---|---|
| Grace — "did anything start?" | 2000ms | `AWAIT_GRACE_MS` = `busyCandidateGap` + `busyConfirmGap`, the detector's actual floor for reaching BUSY |
| Settle — "has it stopped?" | 5000ms | `mightNeedAttention` + `needsAttentionConfirm` |
| Ceiling | `timeoutMs` | `dor await`'s `--timeout` (seconds, default 600), and the only number not derived from `cfg.alert` |

`timeoutMs` is not an alert-tuning knob: it is the safety rail on a blocking call inside an agent loop, so a wedged peer cannot hang its caller forever. It is enforced **host-side**, alongside the grace and settle windows, so no intermediate hop can reap a parked await early and no caller can park forever by lying about its own deadline. The CLI accepts whole-second ceilings from 1 through 86400 (24h). Like the inactivity timeout it originates a process away and ends up in `setTimeout`, so a non-finite, non-positive, or over-ceiling host request is rejected — the request settles `cancelled`, having absorbed nothing. The host's ceiling is `MAX_AWAIT_TIMEOUT_MS` (24h), matching the CLI's cap: `setTimeout`'s delay is a signed 32-bit millisecond count, so a larger value would overflow and fire at once, turning a long park into an instant `timeout`. The webview handler rejects the same values with a visible error rather than letting them settle silently.

Several awaits may park on one Session. They share a single claimant, so one completion is delivered to every await whose condition it satisfies rather than only to whoever registered first, and each resolves on the first qualifying signal after it registered.

In VS Code the `AlertManager` lives in the extension host while `dor` control requests land in a webview, so an await crosses that boundary: the webview posts `alert:await` and, if it gives up, `alert:awaitCancel`; the host answers exactly one `alert:awaitResult` per request — a cancel included, so a claim is never released twice. The wait itself never leaves the host. A webview that disposes cancels everything it had parked, because a caller that cannot be answered must not go on absorbing; it answers those requests itself, synchronously, since the cancelled outcome would otherwise arrive a microtask after the router stopped posting. `cancelled` has no wire outcome of its own — the webview reports it to `dor` as an error, which is also what forgets the in-flight control request. Source of truth: `vscode-ext/src/message-router.ts` and `VSCodeAdapter.alertAwait`; the other hosts run the `AlertManager` in the same process and call `awaitCompletion` directly. The Pocket phone adapter (`RemotePtyAdapter`) has no `dor` and protocol-v1 carries no await, so it settles any request `cancelled` at once rather than parking a promise that can never resolve.

| Situation | Outcome |
|---|---|
| Already ringing at call time | Resolves immediately, `waitedMs: 0`, cause = that ring's source. |
| `quiet`, peer mid-turn and animating | Parks; resolves `quiet` on the settle. |
| `quiet`, WATCHING ring latched but output has resumed | Parks; the stale ring is left for the human and the await resolves `quiet` on the next settle. |
| `quiet`, peer already delivered its answer | Nothing running, no output within the grace window → `idle`. |
| `quiet`, silent build running | A command is running, so no grace window. Resolves `exit` when it exits. |
| `exit`, command hangs on an interactive prompt | Blocks to the ceiling → `timeout`. `quiet` is the answer for callers who want waking when a build stalls. |
| Peer emits `OSC 9` "needs input" | `quiet` resolves `bell`; `exit` ignores it. The await claims a human-directed request on the grounds that its caller is the one positioned to answer it. |
| PTY exits, or the Session is removed | Every await still parked resolves `died`. A command-exit dispatch runs first, so a peer that ends by finishing a command resolves normally instead. |
| The manager is disposed | Everything parked resolves `cancelled`. |

## WATCHING Track

**WATCHING is a property of the command, not of a Session.** The user maintains a set of watched command names; WATCHING is on for a Session exactly while its foreground command's name is in that set. Turning alerts on while `claude` runs means every Session running `claude` watches — the ones open now and the ones opened later. Turning them off anywhere removes the rule everywhere. There is no per-Session enable, and no per-Session mute.

**The output/silence detector is always on.** Every Session runs one `QuiesceDetector` for its whole lifetime, fed by every output chunk and reset at every command boundary. It is a plain observer: it never latches and knows nothing about attention or rules. The rule set decides only whether the detector's state is publicly visible and whether a settle — a busy Session that stayed quiet — is allowed to *ring*.

Because a chunk creates the Session's entry, `remove(id)` also has to keep it removed: `disposeSession` retires the alert state and only *then* kills the PTY, so output already in flight would otherwise rebuild an entry and a detector that nothing ever disposes. Raw output and resizes therefore cannot revive a retired id — they are exactly what a dying PTY emits. A semantic or protocol event can, because an id may be handed to a replacement pane and its first reported command start is the evidence that somebody is home (the WATCHING rule set is meant to apply to that pane immediately).

Rules:

- The key is `commandArgv0(rawCommandLine)` in `lib/src/lib/terminal-state.ts`: take everything before the first pipeline/compound boundary, skip leading `VAR=value` assignments and a leading `env`, then reduce argv[0] to its basename. `claude`, `/usr/local/bin/claude --resume`, and `FOO=1 env BAR=2 claude` all key on `claude`. `foo | claude` keys on `foo`, matching what bash's `DEBUG` trap reports.
- Every command boundary — `commandStart`, `commandFinish`, `promptStart`, `promptEnd`, and PTY exit — resets the detector, so one command's output history can never leak into the next one's reading. Editing the rule set re-derives WATCHING across every live Session immediately, and because the detector kept running underneath, enabling a rule mid-command shows what that command is doing *right now* rather than a fresh `NOTHING_TO_SHOW`.
- A WATCHING ring outlives the command that raised it. Watching switches off the moment the watched command exits, which is usually the same moment the ring was raised, so the ring and its originating command key are held in the Session entry (`watchingRingingCommand`).
- Removing a rule is the one thing that *does* silence a WATCHING ring: it is the user saying "stop alerting on this". The latched originating key makes this work after the command has exited and watching is already off. A command merely ending never clears the ring.
- The rule set is app-global and persisted (`dormouse:watched-commands`). It starts empty, so WATCHING is off everywhere until the user turns it on. Source of truth: `lib/src/lib/watched-commands.ts` (renderer mirror) and `lib/src/lib/watched-command-host.ts` (multi-renderer coordinator). In VS Code the shared extension host is authoritative: the first renderer seeds it from persisted storage, edits cross the boundary as single-command mutations, and the host broadcasts its canonical snapshot to every webview. A stale webview can therefore neither replace unrelated rules nor keep reporting an obsolete rule list.

**Limitation:** WATCHING needs the shell to report command boundaries (`OSC 633` / `OSC 133`). Shells without integration — `cmd.exe`, `fish`, or any shell where injection did not take (`docs/specs/terminal-escapes.md`) — never report a command name, so WATCHING never engages there and the bell reports "nothing is running". Terminal-report and command-exit alerts are unaffected. This is accepted rather than worked around: the keystroke fallback in `docs/specs/terminal-state.md` is renderer-side and lower confidence, and routing it into the manager would buy those shells a worse version of a feature at the cost of a second command-tracking path.

| State | Meaning |
|---|---|
| `WATCHING_DISABLED` | No rule matches the foreground command, so the detector's state is not shown. |
| `NOTHING_TO_SHOW` | A rule matches, but no reminder is owed. |
| `MIGHT_BE_BUSY` | Output may be turning into ongoing work. Debounce state. |
| `BUSY` | Enough output has arrived to treat the Session as doing work. |
| `MIGHT_NEED_ATTENTION` | A busy Session went quiet. Debounce state. |
| `ALERT_RINGING` | WATCHING observed likely completion while the Session lacked attention. |

Source of truth: `QuiesceDetector` in `lib/src/lib/quiesce-detector.ts` implements the detector's `QuiesceStatus` transitions; `AlertManager.onSettled` in `lib/src/lib/alert-manager.ts` reports every settle into the completion-event seam above, whose `settled` ring rule decides whether it rings. Meaningful output excludes resize redraw noise during `T_RESIZE_DEBOUNCE`; theme changes, remounts, DOM reparenting, selection, and focus changes are not output. The invariants the implementation must honor:

- Output drives the detector up the chain `NOTHING_TO_SHOW` -> `MIGHT_BE_BUSY` -> `BUSY`; silence drives it down `BUSY` -> `MIGHT_NEED_ATTENTION` -> settled. The `MIGHT_*` states are debounce windows in both directions.
- First output starts candidate tracking without changing status; unconfirmed `MIGHT_BE_BUSY` returns to `NOTHING_TO_SHOW`.
- The detector never holds `ALERT_RINGING`. A settle is reported once and the detector immediately returns to `NOTHING_TO_SHOW`; the ring it may raise latches in the Session entry (`watchingRingingCommand`), which is what makes the public status `ALERT_RINGING` and what keeps it there through further output.
- A settle rings only if a rule matches the foreground command *and* the Session lacks attention at the confirmation moment. Attention at confirmation time suppresses the ring.
- Attention alone never resets the detector: an in-flight `BUSY` -> `MIGHT_NEED_ATTENTION` -> settled transition continues, so a parked quiet await still receives its completion. Only attending or dismissing an actual WATCHING ring resets it.
- Attending or dismissing a WATCHING ring resets the detector to `NOTHING_TO_SHOW`.
- Rings must be caused by a fresh transition — a settle the detector just reported — never by rerender, theme change, remount, minimize, or reattach.

## Terminal reports

Terminal notifications are explicit requests for attention and are independent of WATCHING. A direct notification rings immediately only when the Session lacks attention; if the user has attention it is suppressed and unrelated protocol progress is left alone. A ring sets `todo = true`, stores the latest sanitized `ActivityNotification`, and sets `protocolStatus = ALERT_RINGING`; clearing it returns `protocolStatus` to `IDLE` and public status falls back to the other tracks.

Sequence syntax for every row below lives in `docs/specs/terminal-escapes.md`; parsing is `lib/src/lib/terminal-protocol.ts`. What each one means here:

- **Standalone `BEL`** — a `BEL` outside an OSC is stripped from visible output and creates `TERMINAL_BELL_NOTIFICATION`. If the same parse batch also holds a richer OSC notification or progress event, drop the generic bells so they cannot overwrite useful preview text; multiple bells in one batch collapse to one notification.
- **`OSC 9`** — the message becomes the body, title null. Empty sanitized messages are ignored. It also feeds title-candidate derivation in `docs/specs/terminal-state.md`, which does not change alert behavior.
- **`OSC 777`** — only the `notify` subcommand is supported. The first field after `notify` is the title; everything after the next semicolon is body, preserving semicolons there. Unsupported subcommands and empty sanitized notifications are ignored.
- **`OSC 99`** (kitty) — metadata keys are single ASCII letters separated by `:`; unknown keys are ignored. `i` groups chunks of one pending notification, `d` is the done flag (default `1`), `e` selects plain or base64 payload encoding, and `p` selects the payload type (default `title`). `title`/`body` chunks append to the pending notification; completion rings once if the sanitized title or body is nonempty. Without `i`, only a complete single-sequence notification is meaningful. Management payloads contribute no content: `p=?` sends `OSC99_SUPPORT_PAYLOAD`, and `p=close` / `p=alive` / `p=icon` / `p=buttons` are consumed. Like any chunk, a management chunk carrying the default `d=1` still completes a pending same-`i` notification, which may then ring on its accumulated title/body — kitty's done-flag semantics apply regardless of the final chunk's payload type. The pending-chunk TTL and max-pending-id cap live in `terminal-protocol.ts`.
- **`OSC 9;4` progress** — progress only: no title, body, urgency, id, app name, or action fields. Active normal, warning, or indeterminate progress sets `protocolStatus = OSC_NOTIF_BUSY` and creates no TODO; it never rings because of silence. `state=1, progress=100` rings as completion and `state=2` rings as error, both only when unattended. A clear rings as completion only if there was an active cycle, otherwise it is ignored. Warning progress does not ring by itself, but completing a warning cycle rings with a generated warning title. Invalid states, missing required percents for states `1` and `4`, and out-of-range percents are ignored. Completion or error while attended clears the progress without TODO or ring. Source of truth for the generated titles/bodies: `completeProtocolProgress` / `finishProtocolProgressCycle` in `lib/src/lib/alert-manager.ts`.

## Command-exit Track

The command-exit track consumes normalized semantic command events from `docs/specs/terminal-state.md` (`OSC 133`, `OSC 633`, or equivalent). It must not parse raw OSC itself.

Rules:

- A command start creates `commandExitWatch` for the current foreground command. If the Session has attention, mark the command as seen.
- If the user attends while a command is already running, mark that command as seen.
- If attention is later lost while that same seen command is still running, set `commandExitStatus = COMMAND_EXIT_ARMED`.
- If the same command finishes, or the PTY exits before a finish event, ring only when all are true: it was armed, the Session still lacks attention, and runtime is at least `T_USER_ATTENTION`.
- A command-exit ring sets `todo = true` and stores the COMMAND_EXIT notification built by `setCommandExitRinging` / `formatCommandExitBody` in `lib/src/lib/alert-manager.ts` (title "Command finished", body = summarized command + exit code).
- Returning to the Session before finish disarms the watch. A quick finish, a different command start, or Session destruction clears it without ringing.
- Race rule: attention must be lost before the finish event is observed.
- Precedence rule: a protocol ring must keep its richer `ActivityNotification`; command-exit must not overwrite it.

Command starts and finishes are also what drive the WATCHING rule above, so the two tracks share one `commandExitWatch` record and one `resolveCommandStart` helper with the terminal-state reducer.

## Clearing And TODO

`todo` is a boolean reminder. Protocol and command-exit rings create it immediately. WATCHING rings create it when the user attends, dismisses, or marks TODO, so a dismissed ring does not disappear without a trace.

Clearing behavior:

- Attending a ringing Session clears active rings on all three tracks, sets `todo = true`, and sets `attentionDismissedRing = true`.
- Clicking the ringing bell or pressing `a` dismisses the ring, sets `todo = true`, and opens the alert/TODO dialog.
- Marking TODO clears any active ring and leaves the WATCHING rule in place for future cycles.
- Clearing TODO sets `todo = false`, clears `notification`, and clears active rings.
- Typing passthrough `Enter` into the Session clears TODO. Command-mode `Enter` that only enters passthrough does not.
- Removing a WATCHING rule turns watching off wherever it matched and silences the WATCHING rings it raised. It does not stop the detector, nor clear protocol progress, command-exit arms, TODO, or notification detail.
- Destroying the Session clears all alert, TODO, notification, attention, protocol, and command-exit state.

`attentionDismissedRing` exists so the next bell click after an attention-based dismissal opens the dialog instead of silently editing a rule. Turning WATCHING on or off, or advancing another alarm track, does not consume the flag; only the explicit dismiss path does.

## Alarm settings

A second app-global store sits beside the WATCHING rule set: the alarm settings, edited in the app-global **Settings** dialog reached from the far right of the baseboard (`lib/src/components/SettingsDialog.tsx`). That dialog also carries the theme picker on hosts that do not own the theme; the alarm sections specified here are the rest of it. Theme selection is specified in [theme.md](./theme.md) and keeps its own store — it is never folded into `AlertSettings`, which is relayed wholesale to the VS Code extension host.

Source of truth: `AlertSettings` in `lib/src/lib/alert-settings.ts` (renderer mirror, persisted at `dormouse:alert-settings`) and `lib/src/lib/alert-settings-host.ts` (multi-renderer coordinator).

| Field | Meaning |
|---|---|
| `inactivityTimeoutMs` | `T_USER_ATTENTION` — the walk-away window defined under Attention above. |
| `speakEnabled` / `speakDelayMs` | Spoken alarms, below. |
| `pushEnabled` / `pushDelayMs` | Push notifications, below. |

Rules:

- Every field is validated and clamped on read *and* on write (`normalizeAlertSettings`), so a hand-edited `localStorage` blob or a hostile message can never install a `NaN` or absurd timer. Unknown keys are dropped and missing keys defaulted, so the blob evolves additively with no version field. The shipped defaults come from `cfg.alert`, keeping `lib/src/cfg.ts` the one place a default is written down.
- Distribution mirrors the WATCHING rule set exactly, and for the same reason — in VS Code the `AlertManager` lives in the shared extension host, and each webview has its own origin and therefore its own `localStorage`. The first renderer seeds the host, an edit replaces the host's copy, and the host broadcasts its canonical snapshot to every webview. The **whole** blob is relayed, not just the field the host consumes, so two webviews cannot disagree about whether alarms speak. The host revalidates everything it receives.
- Single-webview hosts (standalone, browser sidecar, Storybook) own the `AlertManager` in the renderer, so they apply the settings inline and broadcast nothing back.

### Spoken alarms

When a Session transitions into `ALERT_RINGING` and is still ringing `speakDelayMs` later, Dormouse says that Pane's name out loud. Source of truth: `lib/src/lib/alert-speech.ts`, armed once by `useAlertSpeech` in `Wall`.

- Any of the three tracks qualifies. "Not attended" is track-agnostic.
- **The derived Pane label is spoken, including terminal-supplied title overrides.** It comes from `deriveSessionLabel` in `lib/src/lib/session-label.ts` — the one id-keyed label derivation shared with the dev-server chip — and falls back to `terminal`. `OSC 0`, `OSC 2`, and legacy `OSC 9` message text can therefore be spoken when that text currently wins the normal Pane-label derivation. This is deliberate: opting into spoken alarms opts into hearing the Pane name Dormouse displays, even when a program supplied that name. A ringing `ActivityNotification` title/body is not itself the speech payload, but an `OSC 9` message body is also an input to normal Pane-label derivation and can be spoken on that basis.
- **The label is sanitized before it reaches the engine** (`toSpokenText` in `lib/src/lib/alert-speech.ts`): angle brackets, ampersands, asterisks, and control characters become spaces, whitespace collapses, the result is capped, and an empty result falls back to `terminal`. This is a robustness *and* security requirement, not tidiness — WebKit silently drops an utterance containing angle brackets **and leaves the synthesizer wedged**, so every later utterance is dropped too until the page reloads. Pane labels carry chrome like `<idle>`, and terminal-supplied titles reach speech, so without sanitization any program could permanently disable spoken alarms for the session by putting a `<` in its title. Asterisks go through the same substitution for clarity rather than safety: a label such as `eight *` must not be announced as “eight asterisk”, and replacing it with a space that then collapses away reads as `eight`.
- The trigger is a fresh transition into `ALERT_RINGING`, held to the same standard as the bell (WATCHING Track, last bullet). A Session observed for the first time *already* ringing never speaks, which is what keeps a restore or a reconnect replaying a latched ring silent.
- Attending, dismissing, or killing the Pane during the delay cancels the utterance; so does switching the setting off. Both the ring and the setting are re-read when the timer fires rather than captured when it was scheduled.
- One utterance per ring. A Session that rings, is cleared, and rings again speaks twice. Sessions ring and speak independently.
- **Delivery state follows actual engine callbacks, not queue admission.** `AlertSpeechState` in `lib/src/lib/alert-speech-state.ts` is a renderer-local `speaking | spoken` map keyed by Session. The engine's `start` event publishes `speaking`; `end`, or `error` after a real start, publishes `spoken`. An utterance that never starts publishes neither. Each utterance carries an opaque generation token, so a late callback from a resolved or older ring cannot overwrite a newer ring or resurrect a cleared marker.
- **Nothing in the settle path may assume the callback arrives after `speak()` returns.** An engine may dispatch `start` and then `end`/`error` *synchronously* inside `speechSynthesis.speak()` — Chrome reports `not-allowed` that way when speech is invoked without a user gesture, which is exactly this call site. The handlers therefore close over the utterance itself and registration happens before dispatch; a handler reading a variable the caller assigns afterward would drop the settle and pin the Session at `speaking` for the rest of the ring. A dispatch the engine refuses outright settles too.
- **Attending mid-sentence cuts the utterance off.** The announcement exists to summon the user; once a deliberate action resolves the ring, finishing the sentence is noise, so the engine is silenced rather than the overlay merely un-rendered. What counts as mid-sentence is the sink's own record that an utterance started — its generation token — not the rendered `speaking` state. Web Speech has no per-utterance stop, so `cancel()` empties the whole queue; every still-ringing Session whose current-ring utterance had been accepted but had not started is therefore re-dispatched, since attending one Pane must not silence another Pane's alarm. A queued index entry is pruned as soon as its ring resolves, so an unrelated later `cancel()` cannot re-dispatch that stale entry under a subsequent ring, bypass the new delay, and speak twice; the engine may still own the old utterance, since removing it individually would require the same global `cancel()`. A re-dispatch is a fresh decision to speak, held to the same gates as the first: a Session attended in the meantime, or the setting switched off mid-utterance, drops out instead of being replayed. A Session that is only queued is never cut: it has nothing audible to stop, and cutting it would take the Pane that *is* talking with it.
- **Teardown silences the engine, not just the callbacks.** Detaching handlers only protects the renderer's own state; `speechSynthesis` still owns its queue, so the disposer calls `cancel()`. Otherwise a webview that unmounts mid-alarm — closing a VS Code webview, switching workspaces — keeps reading Pane names aloud with no visible source and no UI left to stop it.
- **In-flight tracking is bounded.** A dropped utterance (the WebKit wedge above) never fires a callback to retire itself, so both the teardown set and the Session-keyed queued index evict their matching oldest entry past a small shared cap rather than pinning an utterance and handler closure per ring for the life of the app. An evicted utterance that does still fire settles normally; it is merely no longer eligible for collateral re-dispatch after an unrelated `cancel()`. After teardown the generation token makes any late callback inert.
- `speaking` / `spoken` remains only while the originating Session is still `ALERT_RINGING`. Any deliberate action that resolves the ring clears it: clicking or entering the Pane, typing in passthrough, clicking/pressing `Enter` on its Door, dismissing the bell, or marking/clearing TODO. Mere visibility, hover, or command-mode selection does not. Killing the Session also clears it. The state is not persisted or sent to the host, so restore/reconnect never recreates it.
- Renderer-side, via `window.speechSynthesis`. Where that is absent — Tauri on Linux (WebKitGTK ships no speech backend), or a test environment — speaking is a silent no-op rather than an error. `speak()` is the single seam a native host path would replace.
- Desktop shell only: `MobileWall` / Pocket does not arm it and has no settings UI (no baseboard, so no Settings dialog).

### Push notifications

When a Session transitions into `ALERT_RINGING` and is still ringing `pushDelayMs` later, Dormouse sends that Pane's name to every paired phone that has enabled alerts. Desktop shell only, and only where a Host runs — a build with no enrollment has nowhere to push.

**The two halves run in different processes.** Ring *detection* is webview state — the activity store, the alarm settings, the Pane's derived label — so `watchPushRings` (`lib/src/remote/host/alert-push.ts`) stays in the webview and fires one `push { sessionId, title }` command at the Host service. *Delivery* needs the enrollment and the ACL, which only the Host holds, so `sendPush` (`lib/src/remote/host/push-delivery.ts`) runs in the service's process and touches no DOM or store. **A webview cannot choose recipients:** it names the Session and what to call it, and the service reads its own active ACL at send time. Watching is armed only while the service reports an enrollment (`enrolled-gate.ts`), so a machine that never enrolls pays no activity-store subscription; a `push` that arrives with no Host running is simply not sent, since there is no ACL to read and nothing the webview could do about it. Both halves live under `remote/host/` to keep the sink inside the lazily-imported `RemotePairingModalHost` chunk, so hosts that never set `enableRemoteHost` never fetch it; the shared ring machine and the device store stay in the common bundle, since speech and the settings dialog need them everywhere.

Push and speech are independent: both fire when both are on, each on its own delay.

- **The trigger is shared with spoken alarms**, not reimplemented: `watchUnattendedRings` in `lib/src/lib/alert-ring-watch.ts` owns fresh-ring detection, the delay, the fire-time re-check, and every cancellation rule, with speech and push as two sinks over it. A Session observed for the first time *already* ringing never pushes, which is what keeps a restored session blob from buzzing the phone at every app launch.
- **The derived Pane label is the payload**, on the same rule as speech: the ringing `ActivityNotification`'s title/body is not selected as the payload, but terminal-supplied `OSC 0` / `OSC 2` / `OSC 9` text can appear when it is the winning Pane label. The body is a fixed string; the Pane name carries the information.
- **The label is sanitized by `toPushText` — the sink's cap and fallback over the shared `boundedPushText` — which is deliberately not `toSpokenText`.** The rule keeps angle brackets — the speech restriction exists only because WebKit's synthesizer wedges on them — and instead strips control characters and the Unicode bidi and zero-width format characters (including the Arabic letter mark), which can visually reorder or hide text in an OS notification; the cap counts code points, so a cut never ships half a surrogate pair. `boundedPushText` lives in `server-lib-common/src/security/push.ts` so the Host and the Server run the *same* rule rather than a strong copy and a weak one; `lib/pocket/public/sw.js` mirrors it a third time at the render sink, being a verbatim-copied file that can import nothing.
- **The Host names its targets; the Server rejects a send that does not.** Targets are the Host's *active* ACL records, read from the running Host at send time so a revocation during the delay takes effect, and the Server intersects them with its own subscriptions. Nothing propagates a revocation today (`docs/specs/remote-security-model.md` -> Future), so a revoked Client keeps its subscription row — a Server that chose recipients itself would keep pushing Pane labels to a de-authorized phone. The Host deliberately does **not** ask which devices are subscribed first: the Server applies that filter anyway, so the target set is identical and the alarm costs one round trip instead of two.
- **One notification per Session at a time.** Each push carries the Session id as a collapse tag, so a Pane that rings, is cleared, and rings again replaces its own notification rather than stacking copies on the lock screen.
- **Attending before `pushDelayMs` cancels**, matching speech. A push already delivered is *not* recalled: reaching the phone again means sending a second push, and `userVisibleOnly` guarantees that would itself be visible — so recall would trade one stale notification for one confusing one.
- Delivery is an HTTP POST to the Server, not a relay frame ([server.md](./server.md) -> Web Push). The relay routes between two live sockets; a push exists to reach a phone whose app is closed.
- A failed send warns and is dropped. That covers both failure classes: a non-2xx response is checked rather than ignored so a revoked host token cannot leave push permanently broken and silent, and a 2xx whose counts report `failed > 0` or `delivered: 0` warns too — the Server answers 200 even when a push service refused every delivery, folding the outcome into the `PushSendResponse` counts (and logging the refusal server-side). There is nothing useful to retry against: by the next ring the alarm is already stale.
- The settings dialog re-reads the device list when it opens (`refreshPushDevicesNow`). A phone can enable alerts long after this machine booted, so a list fetched only at Host start would name the wrong devices — or none — for the rest of the session. The list is the Host's join of the Server's subscriptions against its own ACL labels, so it comes back over the same bridge as a `pushDevices` command and answers `null` — rendered `no-host` — when no Host is running. Writes are latest-request-wins, fenced on request order, so a slow startup refresh cannot overwrite a newer dialog refresh. The same fence carries "the Host went away": when the enrolled gate disarms it calls `invalidatePushDeviceRefreshes()` and `clearPushDevices()`, so a request already on the wire cannot resolve afterwards and repopulate the dialog with phones there is no longer anything to push to. `clearPushDevices` returns the store to `no-host` and *keeps* the refresher, which stays installed on an un-enrolled machine so the dialog can still ask and be told `no-host`; `resetPushDevices` drops the refresher too and is full teardown (a Storybook story, a test).


### Settings dialog

Reached from any of the controls at the far right of the baseboard; placement and the baseboard's right cluster belong to `docs/specs/layout.md`. Source of truth: `lib/src/components/SettingsDialog.tsx`. The alarm sections below sit under the theme row specified in [theme.md](./theme.md); when that row is hidden (VS Code), the rule list is first and drops its section divider.

- Lists every watched command with a remove control, and **cannot add one**. WATCHING is keyed on a running command's name, so creating a rule stays a bell click / `a` press in the tab running it; the empty state says so. This dialog and the bell dialog are the two places a rule set on a since-closed Pane can be found and removed — they render the same `WatchedCommandList`, so the list has one implementation.
- Delays are shown in seconds and committed on blur or `Enter`, never per keystroke — typing `3` on the way to `30` must not briefly install a 3-second timer. An out-of-range or empty entry snaps back to whatever the store clamped it to.
- The push group's device line names every device a push would reach, and otherwise states why there is none — no Host enrolled, nothing subscribed yet, or the server could not be asked. A push that silently goes nowhere is indistinguishable from a broken one.

## Workspace union

> See `docs/specs/glossary.md` for the Workspace / Window containers and the definitions of the three union fields (`ringing`, `todo`, `count`).

The projection is a pure function — `computeWorkspaceUnion(surfaceIds, activitySnapshot)` in `lib/src/lib/workspace-union.ts`. It is display-only: it never enters the Activity state machine and never fires a ring of its own, so it simply mirrors whichever per-Session rings survive attention suppression. Membership includes minimized (`Doored`) Surfaces and, in standalone, the Surfaces of inactive (unmounted) Workspaces, because a Session's Activity survives minimize and unmount (glossary I2/I3) and a browser Surface's `todo` survives in its persisted `alert` blob.

Where it surfaces is host-specific:

- **VS Code** reflects the terminal portion of each Workspace's union onto native chrome (editor-tab title, sidebar view badge) — implemented; see `docs/specs/vscode.md`. Browser-surface TODO stays webview-local until the webview->host Surface-state channel staged in that spec's `## Future` lands.
- **Standalone** shows terminal rings/TODOs on panes and doors, and a browser Surface's `todo` on its own door. The workspace-strip union indicators are staged with the rest of the strip — see `docs/specs/layout.md` `## Future` (workspaces-rollout).

## UI Contract

### Pane Header

The header shows an alert bell, a fixed-text `TODO` pill when `todo === true`, a hover/focus notification preview when TODO has `notification`, and a dialog opened by right-click or by some left-click actions. Placement, sizing, and width tiers belong to `docs/specs/layout.md`.

Bell visual state is a pure function of public status. Source of truth: `bellIconClass` in `lib/src/components/bell-icon-class.ts` defines the tilt/animation mapping.

The bell names the command it would act on ("Alert on all `claude`"), not an abstract toggle, because that is the scope of what a click changes.

Bell interactions — one transition table, in `dismissOrToggleAlert` in `lib/src/lib/session-activity-store.ts`:

- Left-click `ALERT_RINGING`: dismiss, create TODO if needed, open dialog.
- Left-click after `attentionDismissedRing`: consume the flag and open dialog.
- Otherwise, with a command running: toggle that command's WATCHING rule on or off. Turning it off drops the rule for every Session running it.
- Exception: from `OSC_NOTIF_BUSY` or `COMMAND_EXIT_ARMED` with no rule set, open the dialog instead. Those alarms need no rule, so a click on them must not create one by surprise, and it must not clear the progress or the arm.
- With no command running: change nothing and open the dialog, which explains that alerts are per command.
- Pressing `a` on the selected Pane in command mode uses the same action. Right-click always opens the dialog.
- Pressing `t` toggles TODO.

The dialog carries the TODO switch, the WATCHING rule switch for the running command, notification detail, and the list of every watched command with a remove control. The list is load-bearing, not decoration: it is the only place a rule set on a since-closed Pane can be found and removed.

The TODO pill always displays `TODO`; remote notification text belongs in preview/detail surfaces, not inside the pill. Clicking the pill clears TODO. On clear, the pill briefly shows the success flourish before unmounting.

Spoken-alarm delivery is deliberately much louder than the bell. While the engine is actually speaking, a pointer-transparent treatment spans the whole terminal Pane with a wash, an animated high-contrast inset, and an explicit `SPEAKING` label. After the utterance settles, the animation stops but a static high-contrast inset, a `SPOKEN` label, and a half-strength wash remain until the ring is resolved — `SPOKEN` is an unbounded window, so the haze stays light enough to read terminal text through. `prefers-reduced-motion` keeps the strong static `SPEAKING` treatment and suppresses only the pulse, as does `cfg.alert.ringingPaused` (the Chromatic freeze that pins the bell — an infinite opacity cycle would otherwise snapshot at an arbitrary phase). Layering, placement, and sizing belong to `docs/specs/layout.md`; source of truth: `lib/src/components/wall/AlertSpeechIndicator.tsx`.

### Door

A Door is display-only for alert state:

- show the bell only when `status !== 'WATCHING_DISABLED'`
- show the TODO pill when `todo === true`
- use the same bell tilt/animation mapping as the Pane header
- while its Session is `speaking`, replace the compact bell/TODO cluster with the explicit `SPEAKING` label and invert + pulse the whole Door — that state lasts one utterance. `spoken` persists until the ring is attended, so it keeps a static high-contrast inset and adds a speaker icon *alongside* the bell and TODO pill instead of replacing them; those are the baseboard's persistent signals and must not go dark for an unbounded window
- do not expose a Door-specific alert menu

Click or `Enter` on a Door reattaches into passthrough, counts as attention, and clears a ring. `d` reattaches in command mode, does not count as attention, and leaves the ring intact.

## Text And Security

Notification text is untrusted terminal output.

- Treat all text as plain text: never interpret ANSI, OSC, HTML, Markdown, URLs, paths, or emoji shortcodes as markup.
- Strip C0/C1 controls after protocol parsing, collapse whitespace controls to spaces, and trim.
- Store at most the `TITLE_LIMIT` / `BODY_LIMIT` code points defined in `lib/src/lib/terminal-protocol.ts`, only the latest `ActivityNotification` rather than unbounded history, and cap/expire incomplete OSC 99 parser state.
- Never execute commands, open URLs, copy to clipboard, read files, focus outside Dormouse, or render protocol-supplied icons/buttons/actions.
- Wherever notification text appears in visible UI or accessible labels, it is plain text, and layout must tolerate long text, CJK, RTL, combining marks, and emoji without pushing fixed controls out of bounds. Sanitized terminal-supplied `OSC 0` / `OSC 2` / `OSC 9` text also participates in normal Pane-label derivation, and the resulting label may be sent to the opt-in speech channel as defined above — after a second, speech-specific pass, because a label that is safe to *render* is not automatically safe to hand a speech engine. See `toSpokenText` under Spoken alarms and `toPushText` under Push notifications — two passes with deliberately different rules, because a speech engine and an OS notification fail in different ways.

Alert-specific robustness requirements: multiple Sessions ring independently; minimize, reattach, rerender, resize, and theme changes preserve existing alert state without creating new rings; an exited Session may keep ringing until attended, dismissed, or destroyed; ringing must not rely on color alone and must respect `prefers-reduced-motion`.

## Files

| File | Role |
|------|------|
| `lib/src/lib/quiesce-detector.ts` | The always-on per-Session output/silence detector: `QuiesceStatus` timers, `onSettled`, `reset()` |
| `lib/src/lib/alert-manager.ts` | `AlertManager`: the three tracks, the detectors, the rule set, attention, TODO, notification storage, status projection, the completion-event seam, and `awaitCompletion` |
| `lib/src/lib/watched-commands.ts` | Persisted WATCHING rule set and its push to the host |
| `lib/src/lib/watched-command-host.ts` | First-seed + mutation/broadcast coordinator for a host shared by multiple renderers |
| `lib/src/lib/alert-settings.ts` | Persisted alarm settings, their validation/clamping, and their push to the host |
| `lib/src/lib/alert-settings-host.ts` | First-seed + replace/broadcast coordinator for the settings blob |
| `lib/src/lib/alert-ring-watch.ts` | The shared unattended-ring machine: fresh-ring detection, the delay, the re-check, cancellation |
| `lib/src/lib/alert-speech.ts` | The speech sink and `toSpokenText` |
| `lib/src/lib/alert-speech-state.ts` | Transient per-Session `speaking` / `spoken` delivery state |
| `lib/src/remote/host/alert-push.ts` | Webview half: `watchPushRings` ring detection, `toPushText`, and the device-list commit |
| `lib/src/remote/host/push-delivery.ts` | Service half: `sendPush` / `loadPushDevices`, the ACL-intersected recipients, and `boundedPushText` |
| `lib/src/remote/host/enrolled-gate.ts` | `armWhileEnrolled`: the edge-triggered gate that arms ring watching only while the service reports an enrollment |
| `lib/src/remote/host/activation.ts` | Arms the push sink for the lifetime of the remote Host (start, stop, re-enroll) |
| `lib/src/lib/push-devices.ts` | Renderer-only store of the devices a push would reach, read by the settings dialog |
| `lib/src/lib/session-label.ts` | `deriveSessionLabel`: the id-keyed Surface label over the live stores |
| `lib/src/components/wall/use-alert-speech.ts` | Arms spoken alarms for the lifetime of the desktop shell |
| `lib/src/lib/terminal-protocol.ts` | Notification/progress OSC parsing (`OSC 9` / `9;4` / `99` / `777`, BEL), sanitization limits, OSC 99 chunk state |
| `lib/src/lib/session-activity-store.ts` | React activity snapshot store, primed alert state, bell transition table, platform delegates |
| `lib/src/lib/workspace-union.ts` | `computeWorkspaceUnion` projection |
| `lib/src/components/bell-icon-class.ts` | Bell tilt/animation mapping from public status |
| `lib/src/components/wall/TerminalPaneHeader.tsx` | Bell button, TODO pill, notification preview |
| `lib/src/components/wall/AlertSpeechIndicator.tsx` | Whole-Pane `SPEAKING` / `SPOKEN` treatment |
| `lib/src/components/TodoAlertDialog.tsx` | TODO + WATCHING-rule switches, notification detail, watched-command list |
| `lib/src/components/SettingsDialog.tsx` | App-global Settings dialog: theme row (see [theme.md](./theme.md)), shell row (standalone, see [standalone.md](./standalone.md)), rule list, inactivity timeout, spoken alarms, push notifications |
| `lib/src/components/WatchedCommandList.tsx` | The WATCHING rule set with per-rule remove, shared by both dialogs |
| `lib/src/components/Door.tsx` | Door bell + TODO display |
