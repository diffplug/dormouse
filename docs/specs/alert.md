# Alert Spec

> See `docs/specs/glossary.md` for Session / Pane / Door vocabulary. This spec uses it throughout.
>
> Owns the Session Activity layer — the three alert tracks, attention, TODO, notification text and its sanitization, the two alarm sinks, and the Workspace union projection. `docs/specs/layout.md` defers here for all alert/TODO behavior and owns placement and sizing.

Alert state is Activity-layer state: it survives minimize/reattach (glossary I3) and dies with the Session. **A browser Surface has no Activity machine** — it can never ring, and carries only a user-set TODO flag, destroyed with that Surface.

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

`awaited` sits beside `status`: true while at least one `dor await` is parked on the Session (Await). It is derived from live waiters and **never persisted** — a wait cannot survive the process that was blocking on it.

**Persist only** `todo` and the sanitized `notification` (plus `status` for diagnostics); restore replays those two and **must not** recreate a ring, protocol progress, or a command-exit arm. **WATCHING is never persisted per Session** — it is re-derived from the rule set below at the next command start. Replay filtering in `docs/specs/terminal-escapes.md` keeps old terminal output from firing notification side effects again.

Source of truth: `AlertState` / `ActivityNotification` / `SessionStatus` in `lib/src/lib/alert-manager.ts`; `QuiesceStatus`, which `SessionStatus` widens, in `lib/src/lib/quiesce-detector.ts`.

## Attention

**Set `attentionId` only from explicit user actions** that plausibly mean "I am looking at this Session": clicking a Pane body or header, entering passthrough on a Pane, typing into a Session in passthrough, and clicking a Door or pressing `Enter` on one (both reattach into passthrough).

**Never count** visibility, command-mode selection, hover, a Door existing in the baseboard, or reattaching a Door with `d` into command mode.

Attention is lost when the attention timer expires, the app loses focus, the attended Session is minimized or destroyed, or another Session becomes attended.

`T_USER_ATTENTION` is the user-facing **inactivity timeout** (Alarm settings) and also the **minimum runtime for a command-exit ring** — a command shorter than the walk-away window was probably watched. It is instance state on the `AlertManager`, not a module constant, and both uses follow the configured value; changing it re-arms a live attention timer from that moment, so a shortened window applies immediately.

Source of truth: `cfg.alert` in `lib/src/cfg.ts`; `setInactivityTimeoutMs` in `lib/src/lib/alert-manager.ts`.

## Completion events

Every completion — a detector settle, a command finish, a direct notification, and the end of a protocol progress cycle (completion or error) — is **dispatched as a `CompletionEvent` before any suppression runs**, so an observer sees even a completion that would never have rung anyone (rationale).

Claimants get first refusal per Session in registration order; the first to return `true` claims the event and the rest are not offered it. **A claimed event never rings, never sets TODO, and never stores an `ActivityNotification`** — it stops before the ring rules, where attention suppression and the command-exit armed and minimum-runtime checks live.

With `deferAlertsUntilQuiet` enabled:

- **Must defer an eligible unattended terminal-notification ring while the private detector is fully armed** — `BUSY` or `MIGHT_NEED_ATTENTION`, including when WATCHING is off or another track masks that projection (rationale).
- **Never defer `MIGHT_BE_BUSY`, a detector settle, or a command-finish ring** — unconfirmed, already quiet, and authoritative respectively (rationale).
- **Must fold a pending terminal notification into an eligible command-finish ring immediately**, so protocol detail enriches that ring instead of publishing stale later.
- **Must defer after claimants and ring eligibility, never redispatch the historical `CompletionEvent`** (rationale).
- **Keep pending intent live-only and bounded** to the latest protocol notification. Meaningful output moves its quiet deadline; command-boundary detector resets do not drop it.
- **Cancel pending delivery on attendance, dismissal, TODO changes, removal, seeding, or teardown.** Disabling the setting releases it immediately; otherwise confirmed quiet latches the protocol track in one fresh ring, after which speech/push begin their own delays. Continuous output may defer forever.

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
- **Consuming releases that one track's latch and nothing else** — `todo` is neither set nor cleared, no `ActivityNotification` is dropped, `attentionDismissedRing` is untouched, and `attentionId` is never set.

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

**A PTY exit or Session removal resolves every waiter still parked as `died`**, after command-finish dispatch gets first chance to resolve normally. Manager disposal resolves every waiter as `cancelled`.

Source of truth: `awaitCompletion` in `lib/src/lib/alert-manager.ts`; `alertAwait` in `lib/src/lib/platform/types.ts` and `lib/src/lib/platform/vscode-adapter.ts`; `vscode-ext/src/message-router.ts`.

## WATCHING Track

**WATCHING is a property of the command, not of a Session.** The user maintains a set of watched command names; WATCHING is on for a Session exactly while its foreground command's name is in that set, so a rule reaches every Session running that command and removing it anywhere removes it everywhere (rationale). There is no per-Session enable, and no per-Session mute.

**The output/silence detector is always on.** Every Session runs one `QuiesceDetector` for its whole lifetime, fed by every output chunk and reset at every command boundary. It never latches and knows nothing about attention or rules; the rule set decides only whether its state is publicly visible and whether a settle — a busy Session that stayed quiet — may *ring*.

**A retired id must stay retired.** `disposeSession` retires the alert state and only *then* kills the PTY. **Raw output and resizes never revive a retired id**; a semantic or protocol event may (rationale).

Rules:

- The key is `commandArgv0(rawCommandLine)`: everything before the first pipeline/compound boundary, skipping leading `VAR=value` assignments and a leading `env`, then argv[0] reduced to its basename minus any launcher suffix (`docs/specs/terminal-state.md`). So `foo | claude` keys on `foo`, matching what bash's `DEBUG` trap reports. Pinned by `lib/src/lib/watched-commands.test.ts`.
- **Every command boundary resets the detector** — `commandStart`, `commandFinish`, `promptStart`, `promptEnd`, and PTY exit — so one command's output history can never leak into the next one's reading.
- **Editing the rule set re-derives WATCHING across every live Session immediately**, so a mid-command enable shows what that command is doing *right now* rather than a fresh `NOTHING_TO_SHOW` (rationale).
- **A WATCHING ring outlives the command that raised it.** Watching switches off the moment the watched command exits — usually the moment the ring was raised — so the ring and its originating command key are held in the Session entry (`watchingRingingCommand`).
- **Removing a rule is the one thing that silences a WATCHING ring**; the latched originating key makes that work after the command has exited and watching is already off. A command merely ending never clears the ring.
- **The rule set is app-global and persisted** (`dormouse:watched-commands`), starting empty, so WATCHING is off everywhere until the user turns it on. **In VS Code the shared extension host is authoritative**, so a stale webview can neither replace unrelated rules nor keep reporting an obsolete list; the seed/mutation/broadcast wire contract is `docs/specs/transport.md`.

**Limitation:** WATCHING needs the shell to report command boundaries (`OSC 633` / `OSC 133`). Shells without integration — `cmd.exe`, `fish`, or any where injection did not take (`docs/specs/terminal-escapes.md`) — never report a command name, so WATCHING never engages there and the bell reports "nothing is running"; the other two tracks are unaffected. Accepted rather than worked around: **never route the keystroke fallback in `docs/specs/terminal-state.md` into the `AlertManager`** (rationale).

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
- **The detector never holds `ALERT_RINGING`.** A settle is reported once and the detector immediately returns to `NOTHING_TO_SHOW`; the ring it may raise latches in the Session entry (`watchingRingingCommand`), which makes the public status `ALERT_RINGING` and keeps it there through further output.
- **A settle rings only if** a rule matches the foreground command *and* the Session lacks attention at the confirmation moment.
- **Attention alone never resets the detector** — an in-flight `BUSY` -> `MIGHT_NEED_ATTENTION` -> settled transition continues, so a parked quiet await still receives its completion. **Only attending or dismissing an actual WATCHING ring resets it**, to `NOTHING_TO_SHOW`, so the tail of the run that just rang cannot settle again.
- **Rings must be caused by a fresh transition** — a settle the detector just reported — never by rerender, theme change, remount, minimize, or reattach.

Source of truth: `commandArgv0` in `lib/src/lib/terminal-state.ts`; `QuiesceDetector` in `lib/src/lib/quiesce-detector.ts`; `onSettled` in `lib/src/lib/alert-manager.ts`; renderer mirror `lib/src/lib/watched-commands.ts`, multi-renderer coordinator `lib/src/lib/watched-command-host.ts`.

## Terminal reports

**Terminal notifications are independent of WATCHING** and are explicit requests for attention: one rings immediately, but only when the Session lacks attention; an attended one is suppressed and unrelated protocol progress left alone. A ring sets `todo = true`, stores the latest sanitized `ActivityNotification`, and sets `protocolStatus = ALERT_RINGING`; clearing returns it to `IDLE` and public status falls back to the other tracks.

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

- Attending a ringing Session clears active rings on all three tracks, sets `todo = true`, and sets `attentionDismissedRing = true`.
- Dismissing the ring from the bell or `a` (Pane Header) sets `todo = true` and opens the alert/TODO dialog.
- Marking TODO clears any active ring and leaves the WATCHING rule in place for future cycles.
- Clearing TODO sets `todo = false`, clears `notification`, and clears active rings.
- Passthrough `Enter` typed into the Session clears TODO. Command-mode `Enter` that only enters passthrough does not.
- Removing a WATCHING rule turns watching off wherever it matched and silences the WATCHING rings it raised. It does not stop the detector, nor clear protocol progress, command-exit arms, TODO, or notification detail.
- Destroying the Session clears all alert, TODO, notification, attention, protocol, and command-exit state.

`attentionDismissedRing` exists so the next bell click after an attention-based dismissal opens the dialog instead of silently editing a rule. **Only the explicit dismiss path consumes the flag** — turning WATCHING on or off, or advancing another alarm track, does not.

## Alarm settings

The alarm settings are a second app-global store beside the WATCHING rule set, edited in the app-global **Settings** dialog (below), which also carries the theme picker ([theme.md](./theme.md)), the shell picker ([standalone.md](./standalone.md)), and the remote-control section ([server.md](./server.md)). **Each of those keeps its own store — never fold one into `AlertSettings`**, which is relayed wholesale to the VS Code extension host.

| Field | Meaning |
|---|---|
| `inactivityTimeoutMs` | `T_USER_ATTENTION` — the walk-away window defined under Attention. |
| `deferAlertsUntilQuiet` | Defer eligible terminal-notification rings while the animation watcher is fully armed. Default off. (rationale) |
| `speakEnabled` / `speakDelayMs` | Spoken alarms, below. |
| `pushEnabled` / `pushDelayMs` | Push notifications, below. |

Rules:

- **Validate and clamp every field on read *and* on write** (`normalizeAlertSettings`), so a hand-edited `localStorage` blob or a hostile message can never install a `NaN` or absurd timer. Unknown keys are dropped and missing keys defaulted, so the blob evolves additively with no version field. `cfg.alert` owns the inactivity default; `DEFAULT_ALERT_SETTINGS` owns the sink and boolean defaults.
- **Distribution follows the WATCHING rule set's seed/broadcast shape** (rationale), except that an edit **relays the whole blob** rather than a per-command delta, so two webviews cannot disagree about whether alarms speak. Wire contract and host revalidation: `docs/specs/transport.md`.
- Single-webview hosts (standalone, browser sidecar, Storybook) own the `AlertManager` in the renderer, so they apply the settings inline and broadcast nothing back.

**Both sinks run over one machine**, `watchUnattendedRings` (rationale):

- It fires on a *fresh* transition into `ALERT_RINGING` — any of the three tracks; "not attended" is track-agnostic.
- **Re-read both the ring and the setting after the delay**, so attending, dismissing, killing the Pane, or switching the sink off during the delay cancels.
- **A Session observed for the first time *already* ringing never fires**, so a restore or reconnect replaying a latched ring stays silent (rationale).
- One fire per ring: a Session that rings, is cleared, and rings again fires twice.
- Sessions are independent, as are the two sinks — both fire when both are on, each on its own delay.

| Contract | Speech | Push |
|---|---|---|
| Gate | Desktop shell, after `speakDelayMs`; a missing backend is a silent no-op. | Desktop shell with an enrolled Host, after `pushDelayMs`. |
| Payload | Pane label via `toSpokenText`; fallback `terminal`. | Same label via `toPushText`, plus a fixed body; fallback `terminal`. |
| Never payload | The ringing `ActivityNotification`. | The ringing `ActivityNotification`. |
| Delivery identity | Renderer-local generation token; `speaking` / `spoken` while the ring is live. | HTTP push tagged by Session id, so a newer ring replaces the prior notification. |
| After delivery | Attending cuts off speech. | **Never recall** — another push would only replace one stale notice with another. |
| Failure | A refused or unavailable engine produces no marker. | Warn on non-2xx, partial, or zero delivery; **never retry** stale alarms. |
| Authority | The renderer invokes `window.speechSynthesis`. | The webview names Session/title; the Host selects active ACL devices, the Server intersects subscriptions. |

Source of truth: `AlertSettings` in `lib/src/lib/alert-settings.ts` (renderer mirror, persisted at `dormouse:alert-settings`); `lib/src/lib/alert-settings-host.ts`; `watchUnattendedRings` in `lib/src/lib/alert-ring-watch.ts`.

### Spoken alarms

- **The label must be sanitized before it reaches the engine** (`toSpokenText`): all Unicode punctuation, symbols, and `Other` characters (including controls, bidi controls, and zero-width formats) become spaces, except apostrophes, which are elided so contractions survive; letters, numbers, and their combining marks from every script remain. Whitespace collapses, the result is capped in code points, and an empty result falls back to `terminal`. **Security, not tidiness:** WebKit wedges its synthesizer on angle brackets, and terminal-supplied text reaches Pane labels (rationale).
- **Delivery state follows actual engine callbacks, not queue admission.** `AlertSpeechState` is a renderer-local `speaking | spoken` map keyed by Session: `start` publishes `speaking`; `end`, or `error` after a real start, publishes `spoken`; an utterance that never starts publishes neither. Each utterance carries an opaque generation token, so a late callback from a resolved or older ring cannot overwrite a newer ring or resurrect a cleared marker.
- **Nothing in the settle path may assume the callback arrives after `speak()` returns** — an engine may dispatch `start` then `end`/`error` *synchronously* inside `speechSynthesis.speak()` (rationale). Handlers therefore close over the utterance itself and registration happens before dispatch. A dispatch the engine refuses outright settles too.
- **Attending mid-sentence cuts the utterance off** — silence the engine, not merely un-render the overlay. "Mid-sentence" is the sink's own record that an utterance started — its generation token — never the rendered `speaking` state.
- Web Speech has no per-utterance stop, so `cancel()` empties the whole queue. **Re-dispatch every still-ringing Session whose current-ring utterance was accepted but never started**, because attending one Pane must not silence another's alarm, and hold each re-dispatch to the same gates as the first (attended meanwhile, or the setting switched off, drops out). **Prune a queued entry as soon as its ring resolves**, so a later unrelated `cancel()` cannot re-dispatch a stale one, bypass the new ring's delay, and speak twice. **Never cut a Session that is only queued** — cutting it would take the Pane that *is* talking with it.
- **Teardown must `cancel()` the engine, not just detach the callbacks** — a webview that unmounts mid-alarm would otherwise keep reading Pane names aloud with no UI left to stop it.
- **In-flight tracking is bounded.** A dropped utterance never fires a callback to retire itself, so the tracking set and the Session-keyed queued index evict their oldest entry past a small shared cap. An evicted utterance that does still fire settles normally; it is only no longer eligible for collateral re-dispatch.
- `speaking` / `spoken` remains only while the originating Session is still `ALERT_RINGING`: any action that resolves the ring (Clearing And TODO) clears it, killing the Session included, while visibility, hover, and command-mode selection do not. **Never persist it or send it to the host**, so restore/reconnect cannot recreate it.

Source of truth: `toSpokenText` in `lib/src/lib/alert-speech.ts`, armed by `lib/src/components/wall/use-alert-speech.ts`; label derivation in `lib/src/lib/session-label.ts`; `AlertSpeechState` in `lib/src/lib/alert-speech-state.ts`.

### Push notifications

**The two halves run in different processes.** Ring *detection* is webview state, so `watchPushRings` stays in the webview and fires one `push { sessionId, title }` command at the Host service. *Delivery* needs the enrollment and the ACL, which only the Host holds, so `sendPush` runs in the service's process and touches no DOM or store. **A webview cannot choose recipients:** it names the Session and what to call it; the service reads its own active ACL at send time. **Arm watching only while the service reports an enrollment** (`enrolled-gate.ts`), so an un-enrolled machine pays no activity-store subscription; a `push` arriving with no Host running is not sent. **Keep both halves under `remote/host/`**, inside the lazily-imported `RemotePairingModalHost` chunk, so a host without `enableRemoteHost` never fetches it (rationale).

- **The label is sanitized by `toPushText` at send time, in the delivery half, and not by `toSpokenText`'s rule** (rationale). It keeps angle brackets and instead strips control characters and the Unicode bidi and zero-width format characters (including the Arabic letter mark), which can visually reorder or hide text in an OS notification; the cap counts code points, so a cut never ships half a surrogate pair. `toPushText` is only this sink's limit and fallback over `boundedPushText` in `server-lib-common/src/security/push.ts`.
- **The Host bounds, then seals; the worker re-bounds at the render sink.** Title, body, and tag are sealed to each recipient's own Client static and the Server forwards ciphertext, so the second pass runs in `lib/src/remote/pocket-app/sw.ts`, which imports the *same* `boundedPushText` rather than mirroring it (`docs/specs/remote-security-model.md` -> Push sealing).
- **The Host names its targets; the Server rejects a send that does not.** Targets are the Host's *active* ACL records, read at send time so a revocation during the delay takes effect, and the Server intersects them with its own subscriptions. **One sealed envelope per recipient** — a Client static is not a group key — so a send names each `deliveryId` beside the ciphertext only that phone can open, **clamped to `MAX_PUSH_QUERY_DELIVERY_IDS`** because the route refuses the whole POST past it. Nothing propagates a revocation today (`docs/specs/remote-security-model.md` -> Future), so a Server that chose recipients itself would keep pushing to a de-authorized phone (rationale). The Host does **not** ask which devices are subscribed first (rationale).
- **The settings dialog re-reads the device list when it opens** (`refreshPushDevicesNow`) — a phone can enable alerts long after this machine booted. The list is the Host's join of the Server's subscriptions against its own ACL labels, arriving over the same bridge as a `pushDevices` command and answering `null` — rendered `no-host` — when no Host is running.
- **Writes are fenced on request order** (latest-request-wins), and the enrolled gate's disarm both invalidates in-flight refreshes and clears the list, so nothing already on the wire can repopulate the dialog with phones there is no longer anything to push to. `clearPushDevices` keeps the refresher installed — an un-enrolled machine may still ask and be told `no-host` — while `resetPushDevices` drops it too and is full teardown.

Source of truth: `watchPushRings` / `invalidatePushDeviceRefreshes` in `lib/src/remote/host/alert-push.ts`; `sendPush` / `toPushText` in `lib/src/remote/host/push-delivery.ts`; `refreshPushDevicesNow` / `clearPushDevices` / `resetPushDevices` in `lib/src/lib/push-devices.ts`.

### Settings dialog

Reached from the controls at the far right of the baseboard; placement and that cluster belong to `docs/specs/layout.md`. The alarm sections sit under the theme and shell rows; when both are hidden (VS Code owns the theme and the shells), the rule list is first and drops its section divider.

- Lists every watched command with a remove control, and **cannot add one** — WATCHING is keyed on a running command's name, so creating a rule stays a bell click / `a` press in the tab running it, and the empty state says so. With the bell dialog it is one of the two places a rule set on a since-closed Pane can be removed; both render the same `WatchedCommandList`.
- The watcher group carries the **Defer alerts until animation stops** switch and explains that only a fully armed watcher delays terminal notifications.
- **Delays are committed on blur or `Enter`, never per keystroke** — typing `3` on the way to `30` must not briefly install a 3-second timer. They are shown in seconds; an out-of-range or empty entry snaps back to whatever the store clamped it to.
- **The push group's device line names every device a push would reach**, and otherwise says why there is none — no Host enrolled, nothing subscribed yet, or the server could not be asked (rationale).
- Each alarm sink carries a **try it now** control outside the switch's dimming; both report inline and clear after a few seconds.

  | Control | Path and result |
  |---|---|
  | **Play test sound** | Fixed phrase through the real sanitizer, but not `speak()` because no Session rang; unlike alarm delivery, reports a missing backend. |
  | **Send test push** | Real Host→ACL→Server path; does not swallow failures and distinguishes no targets, zero delivery, partial delivery, and success. Hidden without a Host service. |

Source of truth: `lib/src/components/SettingsDialog.tsx`; `lib/src/components/WatchedCommandList.tsx`; `lib/src/components/AlarmTestButtons.tsx`.

## Workspace union

> `docs/specs/glossary.md` defines the Workspace / Window containers and the three union fields (`ringing`, `todo`, `count`).

The projection is a pure function — `computeWorkspaceUnion(surfaceIds, activitySnapshot)` in `lib/src/lib/workspace-union.ts`. **Display-only:** it never enters the Activity state machine and never fires a ring of its own, mirroring whichever per-Session rings survive attention suppression. A Surface with no activity entry contributes nothing, and one that is both ringing and TODO counts once. Callers **must include** minimized (`Doored`) Surfaces — and, once Workspaces are more than one, the Surfaces of inactive (unmounted) Workspaces — because Activity survives minimize and unmount (glossary I2/I3) and a browser Surface's `todo` survives in its persisted `alert` blob.

Where it surfaces is host-specific:

- **VS Code** reflects the terminal portion onto native chrome — `docs/specs/vscode.md`, which also owns why browser-surface TODO stays webview-local.
- **Standalone** shows terminal rings/TODOs on panes and doors, and a browser Surface's `todo` on its own door. The workspace-strip union indicators are staged with the strip — `docs/specs/layout.md` `## Future` (workspaces-rollout).

## UI Contract

### Pane Header

The header shows an alert bell, a fixed-text `TODO` pill when `todo === true`, a hover/focus notification preview when TODO has `notification`, and a dialog opened by right-click or by some left-click actions. Placement, sizing, and width tiers belong to `docs/specs/layout.md`.

Bell rotation is a pure function of public status; its motion is not. **Ring the bell for four 800ms cycles per latched track, then hold it at 45° until the ring clears** (test: `runs a finite ringing burst and then holds the bell at 45 degrees` in `lib/src/components/bell-icon-class.test.ts`; rationale). **A track latching behind an already-latched one replays the burst; a track already ringing does not** — that is enrichment of one summons, not a new one. Both are keyed on `AlertState.ringSeq`, a per-Session count of latches, read only for change and compared by `alertStatesEqual` (rationale; pinned by `counts a second track ringing behind an already-latched one` and `does not count a track that is already ringing` in `lib/src/lib/alert-manager.test.ts`, `replaces the icon when the ring counter advances` in `lib/src/components/AlertBell.test.tsx`). **Remote Clients have no counter** — `DirectoryEntry.ringing` is an edgeless boolean, so a Pocket bell rings on mount and then holds. **The bell names the command it would act on** ("Alert on all `claude`"), not an abstract toggle — that is the scope of what a click changes.

Bell interactions — one transition table, in `dismissOrToggleAlert`:

- Left-click `ALERT_RINGING`: dismiss, create TODO if needed, open dialog.
- Left-click after `attentionDismissedRing`: consume the flag and open dialog.
- Otherwise, with a command running: toggle that command's WATCHING rule on or off. Turning it off drops the rule for every Session running it.
- Exception: from `OSC_NOTIF_BUSY` or `COMMAND_EXIT_ARMED` with no rule set, open the dialog instead. Those alarms need no rule, so a click must not create one by surprise, and must not clear the progress or the arm.
- With no command running: change nothing and open the dialog, which explains that alerts are per command.
- Pressing `a` on the selected Pane in command mode uses the same action. Right-click always opens the dialog.
- Pressing `t` toggles TODO.

The dialog carries the TODO switch, the WATCHING rule switch for the running command, notification detail, and the same `WatchedCommandList` the Settings dialog renders — load-bearing, not decoration, for the reason under Settings dialog.

The TODO pill always displays `TODO`; remote notification text belongs in preview/detail surfaces, not inside the pill. Clicking the pill clears TODO, and on clear the pill briefly shows the success flourish before unmounting.

Spoken-alarm delivery is much louder than the bell: a pointer-transparent treatment spans the whole terminal Pane, labelled `SPEAKING` while the engine actually speaks and `SPOKEN` — quieter, and unbounded — until the ring resolves. **`prefers-reduced-motion` keeps the strong static treatment and suppresses only the pulse**, as does `cfg.alert.ringingPaused` (rationale). The layers, their strengths, placement, and sizing belong to `docs/specs/layout.md` → Spoken-alarm overlay.

Source of truth: `AlertBell` in `lib/src/components/AlertBell.tsx`; `bellIconClass` in `lib/src/components/bell-icon-class.ts`; `latchRing` in `lib/src/lib/alert-manager.ts`; `dismissOrToggleAlert` in `lib/src/lib/session-activity-store.ts`; `lib/src/components/TodoPillBody.tsx`; `lib/src/components/wall/AlertSpeechIndicator.tsx`.

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

Alert-specific robustness requirements: multiple Sessions ring independently; minimize, reattach, rerender, resize, and theme changes preserve existing alert state without creating new rings (WATCHING Track, glossary I3); an exited Session may keep ringing until attended, dismissed, or destroyed; ringing must not rely on color alone and must respect `prefers-reduced-motion`.
