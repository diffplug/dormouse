# Alert Spec

## Goal

The alert system is an opt-in reminder for a **Session** that may finish work while the user is looking elsewhere. Alert state lives on the Session itself, not on the Pane or Door that currently displays it.

Explicit terminal notification/progress reports are the exception to the opt-in rule. `OSC 9`, `OSC 9;4`, `OSC 99`, `OSC 777`, and standalone terminal `BEL` handling is specified in `docs/specs/iTerm2.md`; those protocol signals may cock the bell or force `ALERT_RINGING` even when the activity monitor is disabled.

This spec uses semantic state names that describe what the Session currently owes the user:

- `NOTHING_TO_SHOW`
- `MIGHT_BE_BUSY`
- `BUSY`
- `OSC_NOTIF_BUSY`
- `MIGHT_NEED_ATTENTION`
- `ALERT_RINGING`

This document is the source of truth for the naming and behavior of this state machine.

## Non-goals

- No command sniffing or per-tool heuristics. We do not try to guess whether `vim`, `npm dev`, `claude`, or any other command is "appropriate" for alerts.
- No sound, OS notifications, or browser notifications in v1.
- No Door-specific alert menu that overrides the existing click-to-reattach behavior from `docs/specs/layout.md`.

## When alerts are useful

Alerts are most useful for sessions such as:

- long-running jobs that eventually finish, such as signing, notarization, deploys, or test runs
- slow human-in-the-loop sessions, such as AI chats where the user may switch to other work

Alerts are usually not useful for sessions such as:

- continuous background output, such as `npm dev`
- fast local interactive tools where the user is already present
- read-only streams that the user expects to keep changing forever

This is guidance only. The system does not auto-enable or auto-disable alerts based on process name, shell command, exit code, or output patterns.

## Data model

Each Session owns:

- `status: 'ALERT_DISABLED' | 'NOTHING_TO_SHOW' | 'MIGHT_BE_BUSY' | 'BUSY' | 'OSC_NOTIF_BUSY' | 'MIGHT_NEED_ATTENTION' | 'ALERT_RINGING'`
  - This is the public projected alert and activity state for the Session.
  - `ALERT_DISABLED`: visual alert tracking is off and no protocol state is active. Default state.
  - Stable states: `ALERT_DISABLED`, `NOTHING_TO_SHOW`, `BUSY`, `OSC_NOTIF_BUSY`, `ALERT_RINGING`.
  - Transitional states: `MIGHT_BE_BUSY`, `MIGHT_NEED_ATTENTION`.
  - When the user enables the visual alert track, `visualStatus` transitions from `ALERT_DISABLED` to `NOTHING_TO_SHOW` and timer-based activity tracking begins fresh from that moment.
  - When the user disables the visual alert track, timer-based activity tracking stops and `visualStatus` returns to `ALERT_DISABLED`. Public `status` may still be `OSC_NOTIF_BUSY` or `ALERT_RINGING` if `protocolStatus` is active.
- `visualStatus: 'ALERT_DISABLED' | 'NOTHING_TO_SHOW' | 'MIGHT_BE_BUSY' | 'BUSY' | 'MIGHT_NEED_ATTENTION' | 'ALERT_RINGING'`
  - Internal timer-based status owned by the existing visual activity monitor.
  - It is driven only by meaningful output, silence timers, and attention.
  - It may be deleted in a future terminal-report-only implementation without changing the protocol notification model.
- `protocolStatus: 'IDLE' | 'OSC_NOTIF_BUSY' | 'ALERT_RINGING'`
  - Internal terminal-report status owned by parsed terminal reports from `docs/specs/iTerm2.md`.
  - It is driven only by terminal reports such as `OSC 9`, `OSC 9;4`, `OSC 99`, `OSC 777`, and standalone `BEL`.
  - It does not use output/silence timers from the visual activity monitor.
  - It does use the shared attention model. A protocol completion/notification received while the user is actively attending that Session must not ring.
  - `OSC_NOTIF_BUSY` means a terminal report says work is in progress, but there is not yet a notification owed to the user.
  - `ALERT_RINGING` means a terminal report explicitly created a notification or completed/errored a reported progress cycle.
- `todo: boolean`
  - Reminder state for the Session. Default `false`.
  - `false`: no TODO.
  - `true`: TODO is shown. It may be set explicitly by the user, or auto-created when a ringing alert is dismissed by attention or by the bell.
  - Dismissing a ringing alert when `todo` is already `true` leaves it `true`.
  - Legacy persisted TODO encodings migrate into this boolean shape: `-1` / `false` / unknown values become `false`; numeric soft buckets, `2`, `'soft'`, and `'hard'` become `true`.

Each Session also owns:

- `attentionDismissedRing: boolean`
  - True when the user attended to a ringing Session (clicked into the Pane, typed in passthrough, etc.). Cleared when the bell is next clicked or the alert is toggled/disabled. Used by the bell button to show the context menu on the next click instead of immediately disabling.
- `notification: ActivityNotification | null`
  - Latest explicit protocol notification detail, when a Session received a supported terminal notification sequence.
  - Defined in `docs/specs/iTerm2.md`.
  - This metadata is attached to TODO/alert state; it does not replace the boolean `todo` model or the visible TODO pill text.
  - `OSC 9;4` progress is tracked through `protocolStatus` while active; completion/error promotes it into this notification field.

The workspace owns:

- `attentionSessionId: string | null`
  - Which Session currently has the user's attention.
- `attentionTimer: timeout handle | null`
  - Auto-clears `attentionSessionId` after `T_USER_ATTENTION`. Reset on each new attention event.

Important invariants:

- Alert state is session-scoped and survives Pane <-> Door transitions.
- `visualStatus` describes what the timer-based track owes the user since the last explicit attention boundary.
- `protocolStatus` describes what terminal reports say independently of the visual track.
- Public `status` is a projection of those tracks for existing UI.
- Destroying a Session clears `todo`, `notification`, and `protocolStatus` with it; the activity monitor is disposed.
- Re-rendering, theme changes, resize reflow, or remounting a Pane must not create a new alert by themselves.

## Attention model

We only ring when a Session produces a completion signal and the user is not actively attending to that Session.

`attentionSessionId` is set only by explicit user actions that plausibly mean "I am looking at this Session now":

- clicking a Pane body or Pane header
- entering passthrough on a Pane
- typing into a Session in passthrough
- clicking a Door or pressing `Enter` on a Door, because both reattach into passthrough

These do **not** count as attention:

- a Session merely being visible
- a Session merely being selected in command mode
- hovering
- a Door existing in the baseboard
- reattaching a Door with `d`, because that restores the Pane but stays in command mode

Attention is cleared when:

- the user has not explicitly interacted with that Session for `T_USER_ATTENTION`
- the app loses focus
- the Session is minimized into a Door while it had attention
- the Session is destroyed

`T_USER_ATTENTION` is intentionally finite so a user can run a slow command, walk away, and still get a visual alert later even if that Pane remained selected. Start with 15s and tune with real usage.

Doors never directly hold attention. A Door can only regain attention by being restored into a Pane through an action that enters passthrough.

## State model

There are two independent state models:

- **Visual track**: the existing timer-based activity monitor. It watches meaningful output, silence, and user attention. Its internal state is `visualStatus`.
- **Terminal-report track**: parsed terminal notification/progress reports from the PTY. It relies entirely on terminal reports and never uses the output/silence timers. Its internal state is `protocolStatus`.

The public `status` is a projection used by existing UI:

1. If `protocolStatus === 'ALERT_RINGING'`, public `status = ALERT_RINGING`.
2. Else if `visualStatus === 'ALERT_RINGING'`, public `status = ALERT_RINGING`.
3. Else if `protocolStatus === 'OSC_NOTIF_BUSY'`, public `status = OSC_NOTIF_BUSY`.
4. Else public `status = visualStatus`.

This projection is deliberate. Deleting the visual track should leave `protocolStatus: IDLE | OSC_NOTIF_BUSY | ALERT_RINGING` plus the same public projection behavior. The terminal-report path must be able to cock the bell and ring without `ActivityMonitor`, silence timers, or meaningful-output heuristics. It still relies on the shared user-attention model.

### Visual track

The point of the state machine is not to model every output blip. It is to answer a narrow question:

- Does this Session currently have nothing worth surfacing?
- Does it appear to be busy with ongoing work?
- Has it likely finished and now needs attention?

The `MIGHT_*` states exist only to absorb uncertainty. They are debounce states, not user-facing end states.

### Timing reference

| Timer | Value | Purpose |
|---|---|---|
| `T_BUSY_CANDIDATE_GAP` | 1.5 s | enough elapsed time to treat ongoing output as a possible busy transition |
| `T_BUSY_CONFIRM_GAP` | 500 ms | window in `MIGHT_BE_BUSY` before reverting to `NOTHING_TO_SHOW` if no further output |
| `T_MIGHT_NEED_ATTENTION` | 2 s | silence after `BUSY` before suspecting completion |
| `T_ALERT_RINGING_CONFIRM` | 3 s | additional silence before confirming `ALERT_RINGING` |
| `T_RESIZE_DEBOUNCE` | 500 ms | ignore resize redraw noise |
| `T_USER_ATTENTION` | 15 s | attention idle expiry |

All values are configurable via `cfg.alert`. Total silence from last meaningful output to `ALERT_RINGING`: 5 s (`T_MIGHT_NEED_ATTENTION` + `T_ALERT_RINGING_CONFIRM`).

### State semantics

- `NOTHING_TO_SHOW`
  - Default state.
  - The Session does not currently owe the user a reminder.
  - Immediate command echo or a single quick response is not enough to leave this state.

- `MIGHT_BE_BUSY`
  - Transitional state entered when output suggests the Session may be moving from a quick response into ongoing work.
  - If that suspicion is not confirmed quickly, fall back to `NOTHING_TO_SHOW`.

- `BUSY`
  - Stable state.
  - There is enough evidence that the Session is doing ongoing work and may later produce something worth surfacing.

- `OSC_NOTIF_BUSY`
  - Stable projected state from the terminal-report track.
  - The terminal explicitly reported ongoing progress or a similar protocol-backed busy condition.
  - It looks the same as `BUSY` in the Pane header and Door, but it does not participate in visual-track timers.
  - Visual-track silence does not move it to `MIGHT_NEED_ATTENTION`; only a terminal report can clear it or promote it to `ALERT_RINGING`.

- `MIGHT_NEED_ATTENTION`
  - Transitional state entered when a `BUSY` Session goes quiet.
  - This may be true completion, or only a pause in output.

- `ALERT_RINGING`
  - Stable state.
  - The Session likely completed a meaningful unit of work and the alert is actively ringing.

### Transition rules

| Current | Event | Next | Notes |
|---|---|---|---|
| any | explicit attention boundary | `NOTHING_TO_SHOW` | Clicking into the Pane, typing in passthrough, or restoring a Door via click/`Enter` starts a new cycle. |
| `NOTHING_TO_SHOW` | first meaningful output after an attention boundary | `NOTHING_TO_SHOW` | A single output burst may be only immediate feedback. |
| `NOTHING_TO_SHOW` | another meaningful output arrives after `T_BUSY_CANDIDATE_GAP`, or multiple rapid outputs continue through that gap | `MIGHT_BE_BUSY` | The Session may be entering a longer-running phase. |
| `MIGHT_BE_BUSY` | further output confirms ongoing work within `T_BUSY_CONFIRM_GAP` | `BUSY` | Enough evidence to treat the Session as busy. |
| `MIGHT_BE_BUSY` | output stops before confirmation | `NOTHING_TO_SHOW` | False positive; it was just a quick response. |
| `BUSY` | more meaningful output | `BUSY` | Stay busy. |
| `BUSY` | no meaningful output for `T_MIGHT_NEED_ATTENTION` | `MIGHT_NEED_ATTENTION` | The Session may have finished, or may only be pausing. |
| `MIGHT_NEED_ATTENTION` | output resumes | `BUSY` | It was only a pause. |
| `MIGHT_NEED_ATTENTION` | silence continues for `T_ALERT_RINGING_CONFIRM` and the Session lacks attention | `ALERT_RINGING` | This is the alert-eligible completion transition. |
| `MIGHT_NEED_ATTENTION` | silence continues for `T_ALERT_RINGING_CONFIRM` but the Session has attention | `NOTHING_TO_SHOW` | The user already sees it; no reminder is owed. |
| `ALERT_RINGING` | explicit attention boundary | `NOTHING_TO_SHOW` | The user attended to the result. |
| `ALERT_RINGING` | new meaningful output and the Session has attention | `MIGHT_BE_BUSY` | A new work cycle may be starting. |
| `ALERT_RINGING` | new meaningful output but the Session lacks attention | `ALERT_RINGING` | Latch: new output does not silently clear the alert without user awareness. |

These transition rules apply to the visual track only. `OSC_NOTIF_BUSY` is not entered, exited, or promoted by these timers.

### Terminal-report track

| Current | Event | Next | Notes |
|---|---|---|---|
| `IDLE` | terminal report starts progress (`OSC 9;4` active state) | `OSC_NOTIF_BUSY` | Cock the bell without enabling the visual activity monitor. |
| `OSC_NOTIF_BUSY` | terminal report updates progress | `OSC_NOTIF_BUSY` | Refresh internal progress state. Public UI remains visually identical to `BUSY`. |
| `OSC_NOTIF_BUSY` | terminal report completes progress and Session lacks attention | `ALERT_RINGING` | Create `notification`, set `todo = true`, and ring. |
| `OSC_NOTIF_BUSY` | terminal report completes progress and Session has attention | `IDLE` | User already sees it; do not ring or create TODO. |
| `OSC_NOTIF_BUSY` | terminal report errors progress and Session lacks attention | `ALERT_RINGING` | Create error `notification`, set `todo = true`, and ring. |
| `OSC_NOTIF_BUSY` | terminal report errors progress and Session has attention | `IDLE` | User already sees it; do not ring or create TODO. |
| `OSC_NOTIF_BUSY` | Session destroyed | `IDLE` | Session teardown clears protocol state. |
| `ALERT_RINGING` | explicit attention boundary / dismiss / TODO clear | `IDLE` | Public status falls back to visual projection after protocol ring clears. |
| any | direct notification (`OSC 9`, completed `OSC 99`, `OSC 777`, standalone `BEL`) and Session lacks attention | `ALERT_RINGING` | Create `notification`, set `todo = true`, and ring immediately. |
| any | direct notification (`OSC 9`, completed `OSC 99`, `OSC 777`, standalone `BEL`) and Session has attention | `IDLE` | User already sees it; do not ring or create TODO. |

`OSC_NOTIF_BUSY` never auto-rings because of silence. If a program starts progress and never sends completion/error, MouseTerm remains cocked until another terminal report completes/errors the progress cycle or the Session is destroyed.

### Meaningful output

`Meaningful output` means terminal output that is not suppressed as incidental UI churn. In particular:

- output during `T_RESIZE_DEBOUNCE` does not count
- theme changes, remounts, or DOM reparenting do not count
- pure selection or focus changes do not count

The implementation may later learn additional suppressions, but this spec only requires resize churn suppression today.

## Alert trigger

Visual alert logic is driven by transitions in `visualStatus`. Protocol alert logic is driven by transitions in `protocolStatus`. The public `status` projection reflects whichever track currently has the strongest user-facing claim.

### Ringing starts when all of these are true

- the Session has an active visual activity monitor (i.e. `visualStatus !== 'ALERT_DISABLED'`)
- the Session's `visualStatus` transitions from `MIGHT_NEED_ATTENTION` into `ALERT_RINGING`
- the Session does not currently have attention

### Protocol override

Supported terminal notification reports from `docs/specs/iTerm2.md` may create a protocol ring. Supported `OSC 9;4` progress sequences set `protocolStatus = OSC_NOTIF_BUSY` and may later promote to `protocolStatus = ALERT_RINGING`. Protocol rings:

- force public `status = ALERT_RINGING` even when the Session's activity monitor is disabled
- obey attention suppression because the user may already be typing into or reading that Session
- set `todo = true` and attach sanitized notification detail
- do not enable or disable the activity monitor
- return to `ALERT_DISABLED` after dismissal if no activity monitor was enabled before the protocol ring

### Ringing does not start when any of these are true

- the Session already has attention at the moment it would otherwise enter `ALERT_RINGING`
- the Session is merely re-rendered or reattached while already `ALERT_RINGING`
- the only recent output was resize noise already ignored by the completion detector
- the visual alert track is disabled (`visualStatus === 'ALERT_DISABLED'`)

This "fresh transition into `ALERT_RINGING` only" rule is critical. It prevents duplicate alerts on remount, theme change, or Pane <-> Door movement.

Resize/activity-monitor suppression rules apply only to visual rings. Attention suppression applies to both visual and protocol rings.

## Alert clearing rules

For activity-monitor rings, the Session leaves `ALERT_RINGING` and returns to `NOTHING_TO_SHOW` when any of these happen:

- the user attends to the Session (clicking into the Pane, typing in passthrough, restoring a Door via click/`Enter`)
- the user dismisses the alert (clicking the ringing bell, pressing `a`)
- the user marks the Session as TODO (`t` key or context menu)
- new output arrives while the Session has attention (starts a new `MIGHT_BE_BUSY` cycle; without attention the alert stays ringing — see latch in transition rules)

All attention-based dismissals (the first three above) set `todo = true` if it is not already set. This prevents phantom dismissals where the alert vanishes without a trace. Once the TODO is visible, the user can clear it explicitly from the pill/dialog or by typing `Enter` as passthrough input into that Session's shell (i.e., the keystroke is forwarded to the PTY). The command-mode `Enter` that *switches into* passthrough does not clear the TODO. Synthetic terminal reports (focus events, cursor-position responses) also do not count as user input for clearing.

For protocol rings from `docs/specs/iTerm2.md`, clearing the protocol ring sets `protocolStatus = IDLE` and returns public `status` to the projected visual-track state. If no visual activity monitor was enabled before the protocol ring, the Session returns to `ALERT_DISABLED`.

The visual track leaves `ALERT_RINGING` and returns to `ALERT_DISABLED` when:

- the user disables visual alerts on that Session (disposes the activity monitor)

Disabling visual alerts does not clear `protocolStatus`. If `protocolStatus` is `OSC_NOTIF_BUSY` or `ALERT_RINGING`, public `status` remains protocol-driven.

The Session's alert state is cleared entirely when:

- the Session is destroyed

If more output arrives later and the Session makes a fresh transition back into `ALERT_RINGING`, the alert rings again.

Marking a Session as TODO resets an activity-monitor alert to `NOTHING_TO_SHOW` and sets `todo = true`, but it does **not** disable future alerts. `todo` and the alert toggle are separate concerns. Protocol rings preserve the same TODO behavior, with return-state details defined in `docs/specs/iTerm2.md`.

Disabling alerts disposes the visual activity monitor and returns `visualStatus` to `ALERT_DISABLED`. Public `status` returns to `ALERT_DISABLED` only when `protocolStatus === 'IDLE'`.

## UI

### Pane header

The Pane header exposes two independent concepts:

- TODO pill
- alert button

TODO pill:

- toggled in command mode with `t` (`false` -> `true` -> `false`)
- shown when `todo === true`
- auto-created on alert dismiss or attention-based alert clearing
- typing `Enter` as passthrough input (forwarded to the Session's shell) clears the TODO; the command-mode `Enter` that switches *into* passthrough does not
- clicking the TODO pill clears it
- when TODO clears, the pill briefly morphs to a `✓` glyph in the success color (~500 ms) before unmounting — this marks the moment of completion so the pill never vanishes silently
- no empty placeholder when off

Alert button:

- shown in all header tiers, including compact and minimal
- icon-only control with tooltip and accessible label
- visual states (pure function of `status`):
  - `ALERT_DISABLED`: `BellSlashIcon`, muted
  - `NOTHING_TO_SHOW`: `BellIcon` filled, muted, upright
  - `MIGHT_BE_BUSY`: `BellIcon` filled, muted, tilted slightly (-22.5°)
  - `BUSY`: `BellIcon` filled, muted, tilted 45°
  - `OSC_NOTIF_BUSY`: same visual treatment as `BUSY`
  - `MIGHT_NEED_ATTENTION`: `BellIcon` filled, muted, tilted 60°
  - `ALERT_RINGING`: `BellIcon` filled, warning color, rocking animation (±45° bell-ring keyframe); reduced-motion: static 45° tilt
- escalation is conveyed by increasing tilt angle, not by a separate badge element
- the tilt/animation must not change the button's layout size

Interaction (`dismissOrToggleAlert` state machine):

- left-click the bell while `ALERT_DISABLED`: enables the alert (creates activity monitor)
- left-click the bell while `ALERT_RINGING`: dismisses the alert, creates a TODO if none exists, then opens the context menu anchored below the button
- left-click the bell after an attention-based dismissal (`attentionDismissedRing` is set): clears the flag and opens the context menu. This lets the user access TODO/disable options after attending to a ringing Session without requiring a right-click.
- left-click the bell while `OSC_NOTIF_BUSY`: does not clear protocol progress. If the visual track is enabled, disables only the visual track; if the visual track is disabled, opens the context menu.
- left-click the bell in any other enabled state: disables the alert (destroys activity monitor)
- pressing `a` on a selected Pane in command mode: same as left-click
- right-click the bell (any state): opens a context menu with:
  - a TODO on/off switch with `[t]` shortcut hint
  - an alert on/off switch with `[a]` shortcut hint
  - brief description of TODO clearing behavior
- tooltip includes "Right-click for options" hint

The alert control has higher layout priority than split or zoom controls. Long titles must truncate before the bell disappears.

### Door

A Door is display-only for alert state in v1. It must not replace the existing Door primary actions defined in `docs/specs/layout.md`.

Door indicators:

- show bell indicator only when `status !== 'ALERT_DISABLED'`
- show TODO pill when `todo === true`
- if `status === 'ALERT_RINGING'`, the Door bell icon uses warning color and the same rocking animation as the Pane header
- the Door bell icon shows the same tilt angles as the Pane header for escalation states
- `OSC_NOTIF_BUSY` uses the same Door bell treatment as `BUSY`

Door interaction:

- click or `Enter` keeps its existing meaning: reattach and enter passthrough
- `d` keeps its existing meaning: reattach and stay in command mode
- alert-specific actions are manipulated after restore, from the Pane header UI

Consequences:

- clicking or `Enter` on a ringing Door counts as attention and clears the ring
- `d` on a ringing Door does not count as attention, so the ring remains until the user explicitly attends, dismisses, or disables

## Hardening requirements

### Text overflow and narrow layouts

- Session titles may contain long text, emoji, CJK, RTL text, combining marks, and shell prompts with paths.
- Pane titles and Door titles must use `min-width: 0` plus truncation so indicators do not overflow their containers.
- Bell and TODO indicators must be fixed-width, non-shrinking affordances.
- The ringing treatment must not change layout size. No border-width jumps, no icon-size jumps.
- If header space becomes extremely tight, the TODO pill may collapse before the alert control does.

### Accessibility and motion

- Ringing must not rely on color alone. Use icon state plus outline, fill, or pulse.
- Respect `prefers-reduced-motion`. In reduced-motion mode, replace the rocking animation with a steady 45° tilt. All tilt states are static transforms and work unchanged regardless of motion preference.
- Bell button must expose accurate `aria-label` text:
  - "Enable alert"
  - "Disable alert"
  - "Alert ringing"
- TODO pill and bell actions must remain keyboard reachable.
- Any ringing modal or popover must trap focus, support `Escape`, and restore focus to the bell button when closed.

### Session and lifecycle edge cases

- Multiple Sessions may ring at once. Alert state is independent per Session.
- Minimizing or reattaching a ringing Session preserves the ring because the ring belongs to the Session.
- A Session that exits while ringing continues to ring until attended, dismissed, disabled, or destroyed by the user.
- Killing the Session clears all alert and TODO state because the Session no longer exists.
- If output resumes while a Session is ringing and the Session has attention, the ring clears and the Session returns to the normal state-machine flow. If the Session lacks attention, the ring persists (latch behavior prevents silent dismissal).
- App blur clears attention but does not dismiss existing rings.

### Internationalization

- Icon-only header controls avoid fixed-width translated labels.
- Tooltips, menus, and modal actions must wrap cleanly for longer translations.
- Use logical CSS properties where layout direction matters so RTL remains correct.
- The literal TODO pill may remain `TODO` in v1, but the layout must tolerate a longer localized label later.

## Scenarios

### Slow response, same pane, user walks away

- User enables alert on a Pane.
- User runs a slow command.
- The Session progresses through `MIGHT_BE_BUSY` and `BUSY`.
- The Session later goes quiet, then transitions through `MIGHT_NEED_ATTENTION` into `ALERT_RINGING`.
- If `T_USER_ATTENTION` has expired, the Pane rings even if it remained selected.

### Slow response, user switched elsewhere

- User enables alert on Session A.
- Session A becomes `MIGHT_BE_BUSY`, then `BUSY`.
- User works in Session B or another app.
- Session A later goes quiet long enough to transition into `ALERT_RINGING`.
- Session A rings because it does not have attention.

### Door rings, user wants to inspect immediately

- User minimizes an alert-enabled Session into a Door.
- The Session later transitions into `ALERT_RINGING`.
- The Door rings.
- User clicks the Door.
- The Session reattaches into passthrough and the ring clears.

### Door rings, user wants to keep command-mode control

- User minimizes an alert-enabled Session into a Door.
- The Door starts ringing.
- User presses `d` on the Door in command mode.
- The Pane is restored, but the ring remains because the user has not yet explicitly attended to the Session.

### User dismisses, then new output arrives

- A Session rings.
- User clicks into the pane to read the output.
- The alert clears, and a TODO appears.
- User presses `Enter` into the Session → the `TODO` pill morphs to a `✓` and clears (they engaged).
- The Session later emits new output, progresses through `BUSY`, and eventually reaches `ALERT_RINGING` again.

### User dismisses but doesn't engage

- A Session rings.
- User clicks into the pane briefly, then switches to another session.
- The alert clears, and a TODO appears.
- User never presses `Enter` into the terminal → TODO persists.
- User later notices the TODO pill and clicks it to clear it.

## Verification checklist

- Alert only rings on a fresh transition into `ALERT_RINGING`
- Single quick responses stay in `NOTHING_TO_SHOW`
- short pauses in a `BUSY` session only reach `MIGHT_NEED_ATTENTION`, not `ALERT_RINGING`
- Resize noise cannot cause a ring
- Minimize/reattach preserves alert state (`status` and `todo`)
- `d` restore from a Door does not silently clear a ring
- click/`Enter` restore from a Door does clear a ring
- very long titles do not push bell or TODO indicators out of bounds
- ringing is still understandable with reduced motion enabled
- multiple simultaneous ringing Sessions remain independently dismissible
