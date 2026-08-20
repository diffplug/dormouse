# Alert Spec

> See `docs/specs/glossary.md` for Session / Pane / Door vocabulary. This spec uses it throughout.

Terminal alert state belongs to the **Session** Activity layer. It survives Pane <-> Door movement and is destroyed with the Session. This spec also defines how the Workspace union counts browser-surface TODO flags: a browser Surface has no Session Activity machine, can never ring, and carries only a user-set TODO flag as Surface state that is destroyed with that browser Surface.

Dormouse can owe the user attention in three ways:

- **WATCHING**: a command the user asked to be alerted about was running, its output became busy, then went quiet while the user was not attending the Session.
- **Terminal report**: the PTY emitted a supported notification or progress protocol (`BEL`, `OSC 9`, `OSC 9;4`, `OSC 99`, or `OSC 777`).
- **Command exit**: Dormouse saw a foreground command running while the user attended the Session, attention was lost while that same command was still running, and the command exited after at least `T_USER_ATTENTION`.

Terminal-report and command-exit alerts do not require WATCHING. All three share the same attention suppression rule: do not ring if the user is actively attending that Session at the completion moment.

Internally these are three independent tracks — `watchingRingingCommand` + the `ActivityMonitor`, `protocolStatus` + `progress`, and `commandExitStatus` + `commandExitWatch`. Each runs IDLE -> busy/armed -> ringing without entangling the others, and each latches its own ring in the entry until it is cleared.

## Non-goals

- No process heuristics. Dormouse never decides on its own that `vim`, `npm dev`, agents, or test runners deserve alerts. WATCHING applies only to command names the user explicitly asked for.
- No native OS notifications on the machine Dormouse runs on, and no separate progress-bar widget. The one audible local channel is the opt-in spoken alarm below, which says a Pane name and nothing else; Dormouse plays no sound effects. Push notifications are the deliberate exception and go only to a *remote* paired phone, never to this machine — the point is reaching a user who walked away.
- No process-tree introspection for command-exit alerts; normalized terminal semantic events are the reliable input.
- No HTML, Markdown, ANSI styling, clickable actions, custom icons, or remote-controlled buttons in notification previews.
- No Door-specific alert menu that changes the Door actions defined in `docs/specs/layout.md`.

## Public State

Source of truth: `AlertState` / `ActivityNotification` in `lib/src/lib/alert-manager.ts` and `SessionStatus` in `lib/src/lib/activity-monitor.ts`.

Public `status` is a projection — first match wins:

1. `ALERT_RINGING` if any of the three tracks is ringing.
2. `OSC_NOTIF_BUSY` if protocol progress is active.
3. The `ActivityMonitor`'s own state if WATCHING is on. WATCHING outranks the command-exit arm deliberately: a watched command is by definition running, so `COMMAND_EXIT_ARMED` would otherwise mask the monitor's busy/quiet states for the whole run, and the monitor is derived from real output.
4. `COMMAND_EXIT_ARMED` if command-exit alerting is armed.
5. Otherwise `WATCHING_DISABLED`.

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

## WATCHING Track

**WATCHING is a property of the command, not of a Session.** The user maintains a set of watched command names; a Session runs the output/silence monitor exactly while its foreground command's name is in that set. Turning alerts on while `claude` runs means every Session running `claude` watches — the ones open now and the ones opened later. Turning them off anywhere removes the rule everywhere. There is no per-Session enable, and no per-Session mute.

Rules:

- The key is `commandArgv0(rawCommandLine)` in `lib/src/lib/terminal-state.ts`: take everything before the first pipeline/compound boundary, skip leading `VAR=value` assignments and a leading `env`, then reduce argv[0] to its basename. `claude`, `/usr/local/bin/claude --resume`, and `FOO=1 env BAR=2 claude` all key on `claude`. `foo | claude` keys on `foo`, matching what bash's `DEBUG` trap reports.
- A `commandStart` for a watched name starts a **fresh** monitor; `commandFinish`, `promptStart`, and `promptEnd` end the command and dispose it. Editing the rule set re-derives WATCHING across every live Session immediately.
- A WATCHING ring outlives its monitor. Watching switches off the moment the watched command exits, which is usually the same moment the ring was raised, so the ring and its originating command key are held in the Session entry (`watchingRingingCommand`) rather than in the monitor.
- Removing a rule is the one thing that *does* silence a WATCHING ring: it is the user saying "stop alerting on this". The latched originating key makes this work after the command has exited and its monitor is gone. A command merely ending never clears the ring.
- The rule set is app-global and persisted (`dormouse:watched-commands`). It starts empty, so WATCHING is off everywhere until the user turns it on. Source of truth: `lib/src/lib/watched-commands.ts` (renderer mirror) and `lib/src/lib/watched-command-host.ts` (multi-renderer coordinator). In VS Code the shared extension host is authoritative: the first renderer seeds it from persisted storage, edits cross the boundary as single-command mutations, and the host broadcasts its canonical snapshot to every webview. A stale webview can therefore neither replace unrelated rules nor keep reporting an obsolete rule list.

**Limitation:** WATCHING needs the shell to report command boundaries (`OSC 633` / `OSC 133`). Shells without integration — `cmd.exe`, `fish`, or any shell where injection did not take (`docs/specs/terminal-escapes.md`) — never report a command name, so WATCHING never engages there and the bell reports "nothing is running". Terminal-report and command-exit alerts are unaffected. This is accepted rather than worked around: the keystroke fallback in `docs/specs/terminal-state.md` is renderer-side and lower confidence, and routing it into the manager would buy those shells a worse version of a feature at the cost of a second command-tracking path.

| State | Meaning |
|---|---|
| `WATCHING_DISABLED` | No monitor exists. |
| `NOTHING_TO_SHOW` | Monitor is active, but no reminder is owed. |
| `MIGHT_BE_BUSY` | Output may be turning into ongoing work. Debounce state. |
| `BUSY` | Enough output has arrived to treat the Session as doing work. |
| `MIGHT_NEED_ATTENTION` | A busy Session went quiet. Debounce state. |
| `ALERT_RINGING` | WATCHING observed likely completion while the Session lacked attention. |

Source of truth: `ActivityMonitor` in `lib/src/lib/activity-monitor.ts` implements the transitions. Meaningful output excludes resize redraw noise during `T_RESIZE_DEBOUNCE`; theme changes, remounts, DOM reparenting, selection, and focus changes are not output. The invariants the implementation must honor:

- Output drives the monitor up the chain `NOTHING_TO_SHOW` -> `MIGHT_BE_BUSY` -> `BUSY`; silence drives it down `BUSY` -> `MIGHT_NEED_ATTENTION` -> `ALERT_RINGING`. The `MIGHT_*` states are debounce windows in both directions.
- First output starts candidate tracking without changing status; unconfirmed `MIGHT_BE_BUSY` returns to `NOTHING_TO_SHOW`; `ALERT_RINGING` ignores new output until the Session has attention.
- Attention at confirmation time suppresses the ring and resets to `NOTHING_TO_SHOW`. `ALERT_RINGING` otherwise latches; new output with attention starts a fresh `MIGHT_BE_BUSY` cycle.
- Attending or dismissing a WATCHING ring resets the monitor to `NOTHING_TO_SHOW`.
- Rings must be caused by a fresh transition into `ALERT_RINGING`, never by rerender, theme change, remount, minimize, or reattach.

## Terminal reports

Terminal notifications are explicit requests for attention and are independent of WATCHING. A direct notification rings immediately only when the Session lacks attention; if the user has attention it is suppressed and unrelated protocol progress is left alone. A ring sets `todo = true`, stores the latest sanitized `ActivityNotification`, and sets `protocolStatus = ALERT_RINGING`; clearing it returns `protocolStatus` to `IDLE` and public status falls back to the other tracks.

Sequence syntax for every row below lives in `docs/specs/terminal-escapes.md`; parsing is `lib/src/lib/terminal-protocol.ts`. What each one means here:

- **Standalone `BEL`** — a `BEL` outside an OSC is stripped from visible output and creates `TERMINAL_BELL_NOTIFICATION`. If the same parse batch also holds a richer OSC notification or progress event, drop the generic bells so they cannot overwrite useful preview text; multiple bells in one batch collapse to one notification.
- **`OSC 9`** — the message becomes the body, title null. Empty sanitized messages are ignored. It also feeds title-candidate derivation in `docs/specs/terminal-state.md`, which does not change alert behavior.
- **`OSC 777`** — only the `notify` subcommand is supported. The first field after `notify` is the title; everything after the next semicolon is body, preserving semicolons there. Unsupported subcommands and empty sanitized notifications are ignored.
- **`OSC 99`** (kitty) — metadata keys are single ASCII letters separated by `:`; unknown keys are ignored. `i` groups chunks of one pending notification, `d` is the done flag (default `1`), `e` selects plain or base64 payload encoding, and `p` selects the payload type (default `title`). `title`/`body` chunks append to the pending notification; completion rings once if the sanitized title or body is nonempty. Without `i`, only a complete single-sequence notification is meaningful. Management payloads contribute no content: `p=?` sends `OSC99_SUPPORT_PAYLOAD`, and `p=close` / `p=alive` / `p=icon` / `p=buttons` are consumed. Like any chunk, a management chunk carrying the default `d=1` still completes a pending same-`i` notification, which may then ring on its accumulated title/body — kitty's done-flag semantics apply regardless of the final chunk's payload type. The pending-chunk TTL and max-pending-id cap live in `terminal-protocol.ts`.
- **`OSC 9;4` progress** — progress only: no title, body, urgency, id, app name, or action fields. Active normal, warning, or indeterminate progress sets `protocolStatus = OSC_NOTIF_BUSY` and creates no TODO; it never rings because of silence. `state=1, progress=100` rings as completion and `state=2` rings as error, both only when unattended. A clear rings as completion only if there was an active cycle, otherwise it is ignored. Warning progress does not ring by itself, but completing a warning cycle rings with a generated warning title. Invalid states, missing required percents for states `1` and `4`, and out-of-range percents are ignored. Completion or error while attended clears the progress without TODO or ring. Source of truth for the generated titles/bodies: `ringOrSuppressProtocolProgress` / `completeProtocolProgress` in `lib/src/lib/alert-manager.ts`.

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
- Removing a WATCHING rule disposes the monitors it owned and silences their WATCHING rings. It does not clear protocol progress, command-exit arms, TODO, or notification detail.
- Destroying the Session clears all alert, TODO, notification, attention, protocol, and command-exit state.

`attentionDismissedRing` exists so the next bell click after an attention-based dismissal opens the dialog instead of silently editing a rule. Starting or stopping a WATCHING monitor, or advancing another alarm track, does not consume the flag; only the explicit dismiss path does.

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
- Each alarm sink carries a **try it now** control — **Play test sound** and **Send test push** — because an alarm is otherwise unobservable until it fires unattended, which is the moment its being wrong costs the most. Source of truth: `lib/src/components/AlarmTestButtons.tsx`. Both sit outside the switch's dimming and stay enabled while the sink is off: checking that the speakers work, or that the phone buzzes, is most useful *before* committing to the alarm. Each reports its own outcome inline and clears it after a few seconds, because for both sinks a working path and a broken one produce the same observation — silence.
  - **Play test sound** speaks a fixed phrase through the same sanitizer as a real alarm, but deliberately not through `speak()`: that publishes the transient per-Session `speaking` / `spoken` state Panes and Doors render, and no Session rang. It reports a webview with no speech backend rather than degrading silently the way the alarm path correctly does.
  - **Send test push** goes through the real Host, ACL and server, so what it proves is what the alarm will do. It is the one caller of the push path that must **not** swallow failures — the ring path's rule that a failed push never breaks the alert path would make a test button report success over a fan-out that reached nobody. It distinguishes four outcomes: no devices targeted (the ordinary answer on a freshly enrolled machine, and not a failure), nothing delivered, a partial fan-out, and success. The button is hidden entirely where no Host service exists, matching the Remote control section ([server.md](./server.md)).

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
| `lib/src/lib/activity-monitor.ts` | Per-Session WATCHING state machine (output/silence timers) |
| `lib/src/lib/alert-manager.ts` | `AlertManager`: the three tracks, the rule set, attention, TODO, notification storage, status projection |
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
| `lib/src/components/SettingsDialog.tsx` | App-global Settings dialog: theme row (see [theme.md](./theme.md)), shell row (standalone, see [standalone.md](./standalone.md)), rule list, inactivity timeout, spoken alarms, push notifications, remote control (see [server.md](./server.md)) |
| `lib/src/components/AlarmTestButtons.tsx` | The two alarm sinks' "try it now" controls: Play test sound, Send test push |
| `lib/src/components/WatchedCommandList.tsx` | The WATCHING rule set with per-rule remove, shared by both dialogs |
| `lib/src/components/Door.tsx` | Door bell + TODO display |
