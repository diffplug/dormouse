# Alert Spec

Alert state belongs to the **Session** Activity layer. It survives Pane <-> Door movement and is destroyed with the Session.

Dormouse can owe the user attention in three ways:

- **WATCHING**: the user enabled the timer-based output monitor, output became busy, then went quiet while the user was not attending the Session.
- **Terminal report**: the PTY emitted a supported notification or progress protocol (`BEL`, `OSC 9`, `OSC 9;4`, `OSC 99`, or `OSC 777`).
- **Command exit**: Dormouse saw a foreground command running while the user attended the Session, attention was lost while that same command was still running, and the command exited after at least `T_USER_ATTENTION`.

Terminal-report and command-exit alerts do not require WATCHING to be enabled. All three paths share the same attention suppression rule: do not ring if the user is actively attending that Session at the completion moment.

## Non-goals

- No command/process heuristics. Dormouse does not guess that `vim`, `npm dev`, agents, or test runners deserve special alert behavior.
- No sound, native OS notifications, browser notifications, or separate progress-bar widget.
- No process-tree introspection for command-exit alerts; normalized terminal semantic events are the reliable input.
- No HTML, Markdown, ANSI styling, clickable actions, custom icons, or remote-controlled buttons in notification previews.
- No Door-specific alert menu that changes the Door actions defined in `docs/specs/layout.md`.

## Public State

The public Activity state is:

```ts
type WatchingSessionStatus =
  | 'WATCHING_DISABLED'
  | 'NOTHING_TO_SHOW'
  | 'MIGHT_BE_BUSY'
  | 'BUSY'
  | 'MIGHT_NEED_ATTENTION'
  | 'ALERT_RINGING';

type SessionStatus =
  | WatchingSessionStatus
  | 'OSC_NOTIF_BUSY'
  | 'COMMAND_EXIT_ARMED';

type TodoState = boolean;

interface ActivityNotification {
  source: 'OSC 9' | 'OSC 9;4' | 'OSC 99' | 'OSC 777' | 'BEL' | 'COMMAND_EXIT';
  title: string | null;
  body: string | null;
}

interface AlertState {
  status: SessionStatus;
  watchingEnabled: boolean;
  todo: TodoState;
  notification: ActivityNotification | null;
  attentionDismissedRing: boolean;
}
```

Internal state is deliberately split into independent tracks:

- `watchingStatus`: `WatchingSessionStatus`, or `WATCHING_DISABLED` when no `ActivityMonitor` exists.
- `protocolStatus`: `IDLE | OSC_NOTIF_BUSY | ALERT_RINGING`.
- `commandExitStatus`: `IDLE | COMMAND_EXIT_ARMED | ALERT_RINGING`.
- `progress`: active `OSC 9;4` progress, if any.
- `commandExitWatch`: the current foreground command eligible for command-exit alerting, if any.

Public `status` is a projection:

1. `ALERT_RINGING` if `protocolStatus`, `commandExitStatus`, or `watchingStatus` is ringing, in that order.
2. `OSC_NOTIF_BUSY` if protocol progress is active.
3. `COMMAND_EXIT_ARMED` if command-exit alerting is armed.
4. Otherwise `watchingStatus`.

Persist `status`, `watchingEnabled`, `todo`, and sanitized `notification`. Restore `todo` and `notification`, then restart WATCHING only if `watchingEnabled` is true. Restore must not recreate protocol progress, command-exit arms, or a fresh ring; replay filtering in `docs/specs/terminal-escapes.md` prevents old terminal output from firing notification side effects again.

Legacy TODO values migrate to boolean: `2`, numeric soft buckets `[0, 1]`, `'soft'`, and `'hard'` become `true`; `false`, `-1`, and unknown values become `false`.

## Attention

`attentionSessionId` is set only by explicit user actions that plausibly mean "I am looking at this Session":

- clicking a Pane body or Pane header
- entering passthrough on a Pane
- typing into a Session in passthrough
- clicking a Door or pressing `Enter` on a Door, because both reattach into passthrough

These do not count as attention: mere visibility, command-mode selection, hover, a Door existing in the baseboard, or reattaching a Door with `d` into command mode.

Attention is lost when the attention timer expires, the app loses focus, the attended Session is minimized or destroyed, or another Session becomes attended. `T_USER_ATTENTION` is 15 seconds by default and also acts as the minimum runtime for command-exit alerts.

## WATCHING Track

WATCHING is the user-controlled output/silence monitor. It starts fresh when enabled and is disposed when disabled. Meaningful output excludes resize redraw noise during `T_RESIZE_DEBOUNCE`; theme changes, remounts, DOM reparenting, selection, and focus changes are not output.

| State | Meaning |
|---|---|
| `WATCHING_DISABLED` | No monitor exists. |
| `NOTHING_TO_SHOW` | Monitor is active, but no reminder is owed. |
| `MIGHT_BE_BUSY` | Output may be turning into ongoing work. Debounce state. |
| `BUSY` | Enough output has arrived to treat the Session as doing work. |
| `MIGHT_NEED_ATTENTION` | A busy Session went quiet. Debounce state. |
| `ALERT_RINGING` | WATCHING observed likely completion while the Session lacked attention. |

Timers live in `cfg.alert`:

| Timer | Default | Purpose |
|---|---:|---|
| `busyCandidateGap` | 1500 ms | elapsed output window before busy is plausible |
| `busyConfirmGap` | 500 ms | confirmation window for `MIGHT_BE_BUSY` |
| `mightNeedAttention` | 2000 ms | silence after `BUSY` before possible completion |
| `needsAttentionConfirm` | 3000 ms | additional silence before ringing |
| `resizeDebounce` | 500 ms | ignore resize redraw output |
| `userAttention` | 15000 ms | attention idle expiry and command-exit minimum runtime |

WATCHING transitions:

- First output in `NOTHING_TO_SHOW` starts candidate tracking but stays `NOTHING_TO_SHOW`.
- Continued output across `busyCandidateGap` enters `MIGHT_BE_BUSY`; more output confirms `BUSY`, while no confirmation returns to `NOTHING_TO_SHOW`.
- Output in `BUSY` restarts the silence timer.
- Silence moves `BUSY -> MIGHT_NEED_ATTENTION -> ALERT_RINGING`, unless the Session has attention at confirmation time; if attended, reset to `NOTHING_TO_SHOW`.
- Output in `MIGHT_NEED_ATTENTION` returns to `BUSY`.
- `ALERT_RINGING` latches. New output without attention does not clear it; new output with attention starts a new `MIGHT_BE_BUSY` cycle.
- Attending or dismissing a WATCHING ring resets the monitor to `NOTHING_TO_SHOW`.

Rings must be caused by a fresh transition into `ALERT_RINGING`, never by rerender, theme change, remount, minimize, or reattach.

## Protocol Track

Terminal notifications are explicit requests for attention and bypass the WATCHING toggle. Direct notifications ring immediately only when the Session lacks attention; if the user has attention, that notification is suppressed and unrelated protocol progress is left alone.

`OSC 9;4` active progress sets public `status = OSC_NOTIF_BUSY`. It never rings because of silence. It rings only when a completion, clear, or error report arrives while the Session lacks attention. Completion/error while attended clears the protocol progress without TODO or ring.

Protocol rings set `todo = true`, store the latest sanitized `ActivityNotification`, and set `protocolStatus = ALERT_RINGING`. Clearing the protocol ring returns `protocolStatus` to `IDLE` and public status falls back to command-exit or WATCHING state.

### Standalone BEL

A `BEL` byte outside an OSC sequence is stripped from visible output and creates:

```ts
{ source: 'BEL', title: 'Terminal bell', body: null }
```

If a parse batch also contains a richer OSC notification/progress event, drop the generic `BEL` detail so it cannot overwrite useful preview text. Multiple standalone bells in one batch collapse to one notification.

### OSC 9

`OSC 9 ; <message> ST` creates:

```ts
{ source: 'OSC 9', title: null, body: message }
```

Empty sanitized messages are ignored. OSC 9 also feeds title-candidate derivation in `docs/specs/terminal-state.md`; that does not change alert behavior.

### OSC 9;4 Progress

`OSC 9;4` is progress only. It has no title, body, urgency, id, app name, or action fields.

| Sequence | Meaning |
|---|---|
| `OSC 9 ; 4 ST` or `OSC 9 ; 4 ; 0 ST` | clear progress |
| `OSC 9 ; 4 ; 1 ; <0-100> ST` | normal progress; `100` is completion |
| `OSC 9 ; 4 ; 2 ; <0-100?> ST` | error progress; percent optional |
| `OSC 9 ; 4 ; 3 ST` | indeterminate active progress |
| `OSC 9 ; 4 ; 4 ; <0-100> ST` | warning active progress |

Rules:

- Active normal, warning, or indeterminate progress sets `protocolStatus = OSC_NOTIF_BUSY` and does not create TODO.
- `state=1, progress=100` rings as completion if unattended.
- `state=2` rings as error if unattended.
- Clear rings as completion only if there was an active progress cycle; otherwise ignore it.
- Warning progress does not ring by itself, but completion of a warning cycle uses the generated title `Progress warning`.
- Invalid states, missing required percents for states `1` and `4`, and out-of-range percents are ignored.

Generated notifications use source `OSC 9;4`, title `Progress complete`, `Progress warning`, or `Progress error`, and body `Progress <n>%` when a percent is known.

### OSC 777

`OSC 777 ; notify ; <title> ; <body> ST` creates:

```ts
{ source: 'OSC 777', title, body }
```

Only `notify` is supported. The first field after `notify` is the title; everything after the next semicolon is body, preserving additional semicolons there. Unsupported subcommands and empty sanitized notifications are ignored.

### OSC 99

`OSC 99 ; <metadata> ; <payload> ST` is kitty's notification protocol. Metadata keys are single ASCII letters separated by `:`; unknown keys are ignored.

Supported keys:

| Key | Meaning | Dormouse behavior |
|---|---|---|
| `i` | notification id | assemble chunks for the same pending notification |
| `d` | done flag, default `1` | `d=0` stores partial data; `d=1` completes and may ring |
| `e` | encoding, `0` plain or `1` base64 | decode base64 or reject invalid payload |
| `p` | payload type, default `title` | support `title`, `body`, `?`, `close`, `alive`, `icon`, `buttons` |

`title` and `body` chunks append to the pending notification. Completion rings once if the sanitized title or body is nonempty. If `i` is omitted, only a complete single-sequence notification is meaningful.

Management payloads do not ring:

- `p=?` sends a support response advertising `o=always:p=title,body`.
- `p=close`, `p=alive`, `p=icon`, and `p=buttons` are consumed or ignored without creating notification UI.

Pending OSC 99 chunks expire after 60 seconds, and at most 64 pending ids are retained per parser.

## Command-exit Track

The command-exit track consumes normalized semantic command events from `docs/specs/terminal-state.md` (`OSC 133`, `OSC 633`, or equivalent). It must not parse raw OSC itself.

Rules:

- A command start creates `commandExitWatch` for the current foreground command. If the Session has attention, mark the command as seen.
- If the user attends while a command is already running, mark that command as seen.
- If attention is later lost while that same seen command is still running, set `commandExitStatus = COMMAND_EXIT_ARMED`.
- If the same command finishes, or the PTY exits before a finish event, ring only when all are true: it was armed, the Session still lacks attention, and runtime is at least `T_USER_ATTENTION`.
- A command-exit ring sets `todo = true` and stores `{ source: 'COMMAND_EXIT', title: 'Command finished', body }`, where body is the summarized command plus exit code when known.
- Returning to the Session before finish disarms the watch. A quick finish, a different command start, or Session destruction clears it without ringing.
- Race rule: attention must be lost before the finish event is observed.
- Precedence rule: a protocol ring must keep its richer `ActivityNotification`; command-exit must not overwrite it.

## Clearing And TODO

`todo` is a boolean reminder. Protocol and command-exit rings create it immediately. WATCHING rings create it when the user attends, dismisses, or marks TODO, so a dismissed ring does not disappear without a trace.

Clearing behavior:

- Attending a ringing Session clears active protocol/command rings, resets a WATCHING ring, sets `todo = true`, and sets `attentionDismissedRing = true`.
- Clicking the ringing bell or pressing `a` dismisses the ring, sets `todo = true`, and opens the alert/TODO dialog.
- Marking TODO clears any active ring and leaves WATCHING enabled for future cycles.
- Clearing TODO sets `todo = false`, clears `notification`, and clears active protocol/command rings.
- Typing passthrough `Enter` into the Session clears TODO. Command-mode `Enter` that only enters passthrough does not.
- Disabling WATCHING disposes only the activity monitor. It does not clear protocol progress, command-exit arms, TODO, or notification detail.
- Destroying the Session clears all alert, TODO, notification, attention, protocol, and command-exit state.

`attentionDismissedRing` exists so the next bell click after an attention-based dismissal opens the dialog instead of silently disabling WATCHING.

## UI Contract

### Pane Header

The header shows:

- an alert bell in every width tier
- a fixed-text `TODO` pill when `todo === true`, except in the minimal tier
- a hover/focus notification preview when TODO has `notification`
- a dialog from right-click or some left-click actions, containing TODO and WATCHING switches plus notification detail

Bell visual state is a pure function of public `status`:

| Status | Visual |
|---|---|
| `WATCHING_DISABLED` | outline bell, muted |
| `NOTHING_TO_SHOW` | filled bell, muted, upright |
| `MIGHT_BE_BUSY` | filled bell, muted, -22.5 degree tilt |
| `BUSY` | filled bell, muted, 45 degree tilt |
| `OSC_NOTIF_BUSY` | same as `BUSY` |
| `COMMAND_EXIT_ARMED` | same as `BUSY` |
| `MIGHT_NEED_ATTENTION` | filled bell, muted, 60 degree tilt |
| `ALERT_RINGING` | filled bell, warning color, rocking animation; reduced motion uses static 45 degree tilt |

Tilt and animation must not change layout size. Long titles truncate before alert/TODO controls disappear.

Bell interactions:

- Left-click `WATCHING_DISABLED`: enable WATCHING.
- Left-click `ALERT_RINGING`: dismiss, create TODO if needed, open dialog.
- Left-click after `attentionDismissedRing`: clear the flag and open dialog.
- Left-click `OSC_NOTIF_BUSY` or `COMMAND_EXIT_ARMED`: if WATCHING is enabled, disable only WATCHING; otherwise open dialog. Do not clear protocol progress or command-exit arm.
- Left-click any other WATCHING-enabled state: disable WATCHING.
- Pressing `a` on the selected Pane in command mode uses the same action.
- Right-click always opens the dialog.
- Pressing `t` toggles TODO.

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

Sanitization and limits:

- Treat all text as plain text.
- Strip C0/C1 controls after protocol parsing, collapse whitespace controls to spaces, and trim.
- Do not interpret ANSI, OSC, HTML, Markdown, URLs, paths, or emoji shortcodes as markup.
- Store at most 256 Unicode code points for title and 4096 for body.
- Store only the latest `ActivityNotification`, not unbounded history.
- Cap and expire incomplete OSC 99 parser state as described above.

Security requirements:

- Never execute commands, open URLs, copy to clipboard, read files, focus outside Dormouse, or render protocol-supplied icons/buttons/actions.
- Notification text may appear only as plain text in visible UI and accessible labels.
- Layout must tolerate long text, CJK, RTL, combining marks, and emoji without pushing fixed controls out of bounds.

## Hardening

- Multiple Sessions can ring independently.
- Minimize, reattach, rerender, resize, and theme changes must preserve existing alert state without creating new rings.
- An exited Session may keep ringing until attended, dismissed, disabled, or destroyed.
- Ringing must not rely on color alone, and `prefers-reduced-motion` must be respected.
- Bell, TODO, preview, and dialog controls must remain keyboard reachable; dialogs trap focus and support `Escape`.
- Tooltips, dialog copy, and future localized TODO labels must wrap in narrow layouts.

## Verification Checklist

- WATCHING rings only on a fresh unattended transition into `ALERT_RINGING`.
- Quick output stays in `NOTHING_TO_SHOW`; pauses in busy output debounce through `MIGHT_NEED_ATTENTION`.
- Resize noise cannot cause a WATCHING ring.
- Alert/TODO state survives Pane <-> Door transitions.
- Door click/`Enter` clears a ring; Door `d` does not.
- Protocol notifications ring with WATCHING disabled, but not while the Session has attention.
- `OSC 9;4` active progress shows `OSC_NOTIF_BUSY`; completion, error, and active-progress clear ring only when unattended.
- Standalone `BEL` does not replace richer OSC detail in the same parse batch.
- OSC 99 chunking, base64, support query, and management payloads behave as specified.
- Command-exit arms only after a seen command loses attention and rings only on the same command after the minimum runtime.
- Protocol detail wins over generated command-exit detail.
- Dismiss/attend creates TODO; passthrough `Enter` clears TODO.
- Restore/replay does not refire old notification side effects.
- Long titles and notification text do not overflow fixed header or Door controls.

## References

- iTerm2 proprietary escape codes (OSC 9, OSC 9;4): https://iterm2.com/documentation-escape-codes.html
- kitty desktop notifications (OSC 99): https://sw.kovidgoyal.net/kitty/desktop-notifications/
- WezTerm escape sequences and notification handling (OSC 9, OSC 777): https://wezterm.org/escape-sequences.html, https://wezterm.org/config/lua/config/notification_handling.html
- foot control sequences (OSC 9, OSC 99, OSC 777): https://manpages.ubuntu.com/manpages/resolute/man7/foot-ctlseqs.7.html
