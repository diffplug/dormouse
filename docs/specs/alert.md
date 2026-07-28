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
- No sound, native OS notifications, browser notifications, or separate progress-bar widget.
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

Attention is lost when the attention timer expires, the app loses focus, the attended Session is minimized or destroyed, or another Session becomes attended. `T_USER_ATTENTION` also acts as the minimum runtime for command-exit alerts.

Source of truth: `cfg.alert` in `lib/src/cfg.ts` defines `T_USER_ATTENTION` and the other timer defaults and their purpose.

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

### Door

A Door is display-only for alert state:

- show the bell only when `status !== 'WATCHING_DISABLED'`
- show the TODO pill when `todo === true`
- use the same bell tilt/animation mapping as the Pane header
- do not expose a Door-specific alert menu

Click or `Enter` on a Door reattaches into passthrough, counts as attention, and clears a ring. `d` reattaches in command mode, does not count as attention, and leaves the ring intact.

## Text And Security

Notification text is untrusted terminal output.

- Treat all text as plain text: never interpret ANSI, OSC, HTML, Markdown, URLs, paths, or emoji shortcodes as markup.
- Strip C0/C1 controls after protocol parsing, collapse whitespace controls to spaces, and trim.
- Store at most the `TITLE_LIMIT` / `BODY_LIMIT` code points defined in `lib/src/lib/terminal-protocol.ts`, only the latest `ActivityNotification` rather than unbounded history, and cap/expire incomplete OSC 99 parser state.
- Never execute commands, open URLs, copy to clipboard, read files, focus outside Dormouse, or render protocol-supplied icons/buttons/actions.
- Notification text may appear only as plain text in visible UI and accessible labels, and layout must tolerate long text, CJK, RTL, combining marks, and emoji without pushing fixed controls out of bounds.

Alert-specific robustness requirements: multiple Sessions ring independently; minimize, reattach, rerender, resize, and theme changes preserve existing alert state without creating new rings; an exited Session may keep ringing until attended, dismissed, or destroyed; ringing must not rely on color alone and must respect `prefers-reduced-motion`.

## Files

| File | Role |
|------|------|
| `lib/src/lib/activity-monitor.ts` | Per-Session WATCHING state machine (output/silence timers) |
| `lib/src/lib/alert-manager.ts` | `AlertManager`: the three tracks, the rule set, attention, TODO, notification storage, status projection |
| `lib/src/lib/watched-commands.ts` | Persisted WATCHING rule set and its push to the host |
| `lib/src/lib/watched-command-host.ts` | First-seed + mutation/broadcast coordinator for a host shared by multiple renderers |
| `lib/src/lib/terminal-protocol.ts` | Notification/progress OSC parsing (`OSC 9` / `9;4` / `99` / `777`, BEL), sanitization limits, OSC 99 chunk state |
| `lib/src/lib/session-activity-store.ts` | React activity snapshot store, primed alert state, bell transition table, platform delegates |
| `lib/src/lib/workspace-union.ts` | `computeWorkspaceUnion` projection |
| `lib/src/components/bell-icon-class.ts` | Bell tilt/animation mapping from public status |
| `lib/src/components/wall/TerminalPaneHeader.tsx` | Bell button, TODO pill, notification preview |
| `lib/src/components/TodoAlertDialog.tsx` | TODO + WATCHING-rule switches, notification detail, watched-command list |
| `lib/src/components/Door.tsx` | Door bell + TODO display |
