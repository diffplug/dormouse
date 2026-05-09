# Alert Spec

## Goal

The alert system is an opt-in reminder for a **Session** that may finish work while the user is looking elsewhere. Alert state lives on the Session itself, not on the Pane or Door that currently displays it.

Explicit terminal notification/progress reports are the exception to the opt-in rule. `OSC 9`, `OSC 9;4`, `OSC 99`, `OSC 777`, and standalone terminal `BEL` handling is specified in [Notification protocols](#notification-protocols) below; those protocol signals may cock the bell or force `ALERT_RINGING` even when the activity monitor is disabled. The OSC sequence registry and parsing-location rules live in `docs/specs/OSC.md`.

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
- No sound, native OS notifications, or browser notifications in v1. "Alarm" means MouseTerm's existing `ALERT_RINGING` visual state.
- No standalone progress bar widget. `OSC 9;4` progress updates `protocolStatus` while active; completion/error creates TODO detail. It does not add a separate progress widget to the Pane header.
- No full iTerm2/kitty/rxvt/WezTerm feature parity. Unsupported sequences are ignored unless another spec claims them.
- No HTML, Markdown, ANSI styling, shell command parsing, or clickable action buttons inside TODO notification previews.
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
  - Internal terminal-report status owned by parsed terminal reports (see [Notification protocols](#notification-protocols)).
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
  - This metadata is attached to TODO/alert state; it does not replace the boolean `todo` model or the visible TODO pill text.
  - `OSC 9;4` progress is tracked through `protocolStatus` while active; completion/error promotes it into this notification field.

`ActivityNotification` shape (intentionally small — these are the only fields rendered):

```ts
type ActivityNotificationSource = 'OSC 9' | 'OSC 9;4' | 'OSC 99' | 'OSC 777' | 'BEL';

interface ActivityNotification {
  source: ActivityNotificationSource;
  title: string | null;
  body: string | null;
}
```

Per-source mapping rules (full protocol semantics in [Notification protocols](#notification-protocols)):

- `OSC 9` stores `{ source: 'OSC 9', title: null, body: message }`.
- `OSC 777` stores `{ source: 'OSC 777', title, body }`.
- `OSC 99` stores `{ source: 'OSC 99', title, body }` after chunk assembly and sanitization.
- `OSC 9;4` stores nothing while progress is active. On completion/error it generates `{ source: 'OSC 9;4', title, body }`, where `title` is a short summary such as `Progress complete`, `Progress error`, or `Progress warning`, and `body` contains the percent when available.
- Standalone `BEL` stores `{ source: 'BEL', title: 'Terminal bell', body: null }`.

Persistence rules:

- Persist the latest `ActivityNotification` with the Session's alert state.
- Persist only sanitized text and metadata, not raw escape sequences.
- On restore, persisted notification detail should restore TODO detail, but must not create a fresh ring or re-cock the bell by itself.

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
| `IDLE` | explicit progress completion report (`OSC 9;4;1;100`) and Session lacks attention | `ALERT_RINGING` | Create generated completion `notification`, set `todo = true`, and ring. |
| `IDLE` | explicit progress completion report (`OSC 9;4;1;100`) and Session has attention | `IDLE` | User already sees it; do not ring or create TODO. |
| `IDLE` | explicit progress error report (`OSC 9;4;2`) and Session lacks attention | `ALERT_RINGING` | Create generated error `notification`, set `todo = true`, and ring. |
| `IDLE` | explicit progress error report (`OSC 9;4;2`) and Session has attention | `IDLE` | User already sees it; do not ring or create TODO. |
| `ALERT_RINGING` | explicit attention boundary / dismiss / TODO clear | `IDLE` | Public status falls back to visual projection after protocol ring clears. |
| any | direct notification (`OSC 9`, completed `OSC 99`, `OSC 777`, standalone `BEL`) and Session lacks attention | `ALERT_RINGING` | Create `notification`, set `todo = true`, and ring immediately. |
| any | direct notification (`OSC 9`, completed `OSC 99`, `OSC 777`, standalone `BEL`) and Session has attention | unchanged | User already sees it; suppress that notification only. Do not create TODO, and do not clear unrelated active progress. |

`OSC_NOTIF_BUSY` never auto-rings because of silence. If a program starts progress and never sends completion/error, MouseTerm remains cocked until another terminal report completes/errors the progress cycle or the Session is destroyed.

### Meaningful output

`Meaningful output` means terminal output that is not suppressed as incidental UI churn. In particular:

- output during `T_RESIZE_DEBOUNCE` does not count
- theme changes, remounts, or DOM reparenting do not count
- pure selection or focus changes do not count

The implementation may later learn additional suppressions, but this spec only requires resize churn suppression today.

## Notification protocols

Protocol notifications and standalone terminal bells are explicit application requests for attention. They bypass the normal opt-in activity monitor: a Session may ring even when its alert toggle was disabled. They must not ring while the user is actively attending that Session.

Active/in-progress progress sequences do not ring immediately. They "cock" the alarm bell — MouseTerm treats active progress as an explicit finite-work cycle and exposes `OSC_NOTIF_BUSY`. Explicit completion/error progress reports may ring immediately when the Session lacks attention.

The OSC sequence registry, parser placement, and stripping behavior live in `docs/specs/OSC.md`. This section defines per-protocol semantics for the five supported notification sources.

| Protocol | Shape | Fields | Notes |
|---|---|---|---|
| `BEL` | `BEL` outside an OSC sequence | none | Generic terminal-bell notification. |
| `OSC 9` | `OSC 9 ; [message] ST` | `message` | iTerm2's legacy notification form. No title/body split. |
| `OSC 9;4` | `OSC 9 ; 4 ; [state] ; [progress] ST` or `OSC 9 ; 4 ST` | progress state/progress | Progress only. Cocks the bell and may later ring on completion/error. |
| `OSC 99` | `OSC 99 ; [metadata] ; [payload] ST` | metadata keys plus payload | kitty's rich notification protocol. Chunked and extensible. |
| `OSC 777` | `OSC 777 ; notify ; [title] ; [body] ST` | `title`, `body` | rxvt/WezTerm notification form. Only `notify` is supported. |

### Standalone BEL

A `BEL` byte outside an OSC sequence creates one generated notification:

- `source: 'BEL'`
- `title: 'Terminal bell'`
- `body: null`

Standalone `BEL` is for compatibility with tools that choose a plain terminal-bell notification channel. It strips the bell byte from visible terminal output and rings through the same protocol path as OSC notifications, subject to the shared user-attention check.

If a parse batch contains both standalone `BEL` and a richer OSC notification/progress event, MouseTerm keeps the richer OSC event and drops the generic `BEL` notification detail so `iterm2_with_bell`-style tools cannot overwrite useful TODO preview text.

### OSC 9

`OSC 9 ; [message] ST` creates one notification:

- `source: 'OSC 9'`
- `title: null`
- `body: [message]`

The message is plain text. There is no formal title, subtitle, urgency, app id, or notification id.

OSC 9 also feeds the title-candidate channel for header/door label derivation; that side effect is specified in `docs/specs/terminal-state.md` and does not affect alert behavior.

### OSC 9;4 progress

If the first OSC 9 parameter is `4`, the sequence belongs to the progress protocol:

- `OSC 9 ; 4 ST` clears progress
- `OSC 9 ; 4 ; 0 ST` clears progress
- `OSC 9 ; 4 ; 1 ; [0-100] ST` sets normal progress
- `OSC 9 ; 4 ; 2 ; [0-100?] ST` sets error progress
- `OSC 9 ; 4 ; 3 ST` sets indeterminate progress
- `OSC 9 ; 4 ; 4 ; [0-100] ST` sets warning progress

The official fields are only:

- `state`
- optional `progress` percent

There is no title, body, subtitle, notification id, application name, urgency, or message text in `OSC 9;4`.

MouseTerm behavior:

- Non-clear states create or update an internal protocol progress cycle.
- Active progress cocks the bell by setting `protocolStatus = OSC_NOTIF_BUSY`. Public `status` projects this as `OSC_NOTIF_BUSY`, which looks the same as `BUSY` but is independent of the timer-based activity monitor.
- `state = 1` with `progress < 100` is normal active progress. Do not ring.
- `state = 1` with `progress = 100` is a completion report. Ring immediately as a completed progress cycle only if the Session lacks attention.
- `state = 2` is an error signal. Ring immediately and attach a generated progress notification to the TODO only if the Session lacks attention.
- `state = 3` is indeterminate active progress. Do not ring until cleared or replaced by an error/completion signal.
- `state = 4` is warning active progress. Do not ring immediately; remember the warning internally, and if the cycle later rings MouseTerm preserves that warning in the generated progress notification.
- `state = 0` or abbreviated `OSC 9 ; 4 ST` clears progress. If it clears an active protocol progress cycle, ring as completion. If there was no active protocol progress cycle, ignore it.
- Invalid states, missing required progress values for states `1` and `4`, and out-of-range progress values are ignored. Clamp only for display if an implementation has already accepted the sequence.

Progress completion creates a generated notification, but does not invent copy beyond the normalized progress summary. The TODO preview should say things like `Progress complete`, `Progress error`, `Progress warning`, or `Progress 75%` rather than replacing the TODO pill text.

### OSC 777

`OSC 777 ; notify ; [title] ; [body] ST` creates one notification:

- `source: 'OSC 777'`
- `title: [title]`
- `body: [body]`

Only the `notify` subcommand is supported. The format has no escaping for semicolons. For compatibility, parse the title as the field after `notify` and treat the rest of the sequence after the next semicolon as the body, preserving additional semicolons in the body. A title containing a semicolon cannot be represented portably.

### OSC 99

`OSC 99 ; [metadata] ; [payload] ST` uses colon-delimited metadata where each key is a single ASCII letter. Unknown keys are ignored. Unknown payload types are ignored unless this spec adds them later.

Initial supported metadata keys:

| Key | Meaning | Initial MouseTerm behavior |
|---|---|---|
| `i` | notification identifier | Used to assemble chunks and coalesce updates for the same notification. |
| `d` | done flag, `0` or `1`, default `1` | `d=0` stores a partial notification without ringing. `d=1` completes and rings. |
| `e` | payload encoding, `0` plain or `1` base64 | Decode RFC 4648 base64 when `e=1`; reject invalid base64. |
| `p` | payload type, default `title` | Support `title` and `body`; handle management/query payloads separately. |
| `f` | base64 application name | Decode only if needed for protocol validity; do not store or render in this phase. |
| `t` | base64 notification type | Ignore in this phase. |
| `u` | urgency, `0`, `1`, or `2` | Ignore in this phase; urgency does not change alert mechanics. |
| `o` | occasion, `always`, `unfocused`, `invisible` | Parse but ignore for MouseTerm ringing; explicit OSC notifications always ring. |
| `w` | auto-close milliseconds | Parse but ignore for TODO lifetime. TODO clears only by MouseTerm's normal TODO clearing rules. |

Payload types:

| `p` value | Behavior |
|---|---|
| `title` | Append payload to the pending notification title. |
| `body` | Append payload to the pending notification body. |
| `?` | Support query. Does not ring. |
| `close` | Close/update management. Does not ring. |
| `alive` | Liveness query. Does not ring. |
| `icon` | Ignore payload content in this phase. Does not ring by itself. |
| `buttons` | Ignore payload content in this phase. Does not ring by itself. |

Official kitty OSC 99 does not define a `subtitle` payload. If real-world agent tools emit `p=subtitle`, ignore it unless a later spec chooses to render a third user-facing text field.

For a completed OSC 99 notification:

- If title and body are both empty after sanitization, ignore it.
- If there is a body but no title, the body is the primary preview line.
- If there is a title but no body, render title only.
- If the same `i` arrives again after completion, treat it as an update to the same notification detail and ring again.
- If `i` is omitted, each completed notification is unique.

Support query:

- `OSC 99 ; i=[id] : p=? ; ST` must be answered with MouseTerm's actual support.
- Initial minimal response advertises only `title` and `body`, for example: `OSC 99 ; i=[id] : p=? ; o=always:p=title,body ST`.
- Preserve a valid query id in the response metadata. If the id is missing or cannot be safely echoed in OSC 99 metadata, omit `i=[id]` and respond with `OSC 99 ; p=? ; o=always:p=title,body ST`.
- Do not advertise click reports, close reports, urgency, sounds, icons, buttons, or auto-expiry unless implemented end-to-end.

## Notification text handling

Terminal notifications are untrusted terminal output. Treat all text as plain text.

Input normalization:

- Decode UTF-8 strictly enough to avoid replacement-character floods.
- Strip C0/C1 control characters after protocol parsing.
- Collapse CR/LF/TAB and other controls to spaces.
- Trim leading/trailing whitespace.
- Do not interpret ANSI, OSC, HTML, Markdown, URLs, shell paths, or emoji shortcodes as markup.

Protocol-defined limits:

- OSC 9;4 progress carries only a numeric state and optional numeric percent. There is no user-facing text payload.
- OSC 99 defines a payload chunk limit of 2048 bytes before base64 or 4096 bytes after base64. It permits chunking title/body multiple times, while allowing terminals to impose sensible denial-of-service limits.
- OSC 9 and OSC 777 do not define formal text length limits in the referenced terminal docs.

MouseTerm-imposed limits:

- Store at most 256 Unicode grapheme clusters for `title`.
- Store at most 4096 grapheme clusters for `body`.
- Parser memory for incomplete OSC 99 chunks is capped per Session. Drop the oldest incomplete chunks when the cap is exceeded.
- Expire incomplete OSC 99 chunks after 60 seconds if no `d=1` completion arrives.

Expected UI copy length:

- Titles are expected to be one short line, usually under 80 characters.
- Bodies are expected to be a few short lines at most. In MouseTerm chrome, show a compact preview and make the full stored body available in a popover/dialog.

## Notification security

Any remote process can emit these sequences over SSH. The feature is useful because it works over SSH, but the UI must be robust against hostile text.

Requirements:

- Sanitize all text before storing or rendering.
- Cap stored text and incomplete parser state.
- Never execute commands, open URLs, copy to clipboard, read files, or focus outside MouseTerm from these sequences.
- Do not render custom icons or buttons in this phase.
- Do not let notification text alter accessible labels beyond plain-text names.
- Do not allow repeated notifications to allocate unbounded history. Store only the latest detail, not an infinite list.

## Alert trigger

Visual alert logic is driven by transitions in `visualStatus`. Protocol alert logic is driven by transitions in `protocolStatus`. The public `status` projection reflects whichever track currently has the strongest user-facing claim.

### Ringing starts when all of these are true

- the Session has an active visual activity monitor (i.e. `visualStatus !== 'ALERT_DISABLED'`)
- the Session's `visualStatus` transitions from `MIGHT_NEED_ATTENTION` into `ALERT_RINGING`
- the Session does not currently have attention

### Protocol override

Supported terminal notification reports (see [Notification protocols](#notification-protocols)) may create a protocol ring. Supported `OSC 9;4` progress sequences set `protocolStatus = OSC_NOTIF_BUSY` and may later promote to `protocolStatus = ALERT_RINGING`. Protocol rings:

- force public `status = ALERT_RINGING` even when the Session's activity monitor is disabled
- obey attention suppression because the user may already be typing into or reading that Session
- set `todo = true` and attach sanitized notification detail
- do not enable or disable the activity monitor
- return to `ALERT_DISABLED` after dismissal if no activity monitor was enabled before the protocol ring

Implementation surface inside `AlertManager`:

- A protocol-ring flag or source field independent of `ActivityMonitor`.
- `OSC 9;4` progress is tracked internally in `AlertManager`, not in public `ActivityState`.
- `getState(id).status` returns `ALERT_RINGING` while the protocol ring is active.
- `getState(id).status` returns `OSC_NOTIF_BUSY` while internal protocol progress is active and no stronger state is present.
- Dismiss/attend clears the protocol ring; status falls back to the visual track or `ALERT_DISABLED` if no `ActivityMonitor` exists.
- Completing or erroring a protocol progress cycle creates an `ActivityNotification` and promotes it into a protocol ring only if the Session lacks attention.
- Methods such as `notifyFromProtocol(id, notification)` and `updateProtocolProgress(id, state, percent)` are exposed through `PlatformAdapter` / VS Code messages.

### Ringing does not start when any of these are true

- the Session already has attention at the moment it would otherwise enter `ALERT_RINGING`
- the Session is merely re-rendered or reattached while already `ALERT_RINGING`
- the only recent output was resize noise already ignored by the completion detector
- for visual/activity-monitor rings only: the visual alert track is disabled (`visualStatus === 'ALERT_DISABLED'`)

This "fresh transition into `ALERT_RINGING` only" rule is critical. It prevents duplicate alerts on remount, theme change, or Pane <-> Door movement.

Resize/activity-monitor suppression rules apply only to visual rings. Attention suppression applies to both visual and protocol rings.

## Alert clearing rules

For activity-monitor rings, the Session leaves `ALERT_RINGING` and returns to `NOTHING_TO_SHOW` when any of these happen:

- the user attends to the Session (clicking into the Pane, typing in passthrough, restoring a Door via click/`Enter`)
- the user dismisses the alert (clicking the ringing bell, pressing `a`)
- the user marks the Session as TODO (`t` key or context menu)
- new output arrives while the Session has attention (starts a new `MIGHT_BE_BUSY` cycle; without attention the alert stays ringing — see latch in transition rules)

All attention-based dismissals (the first three above) set `todo = true` if it is not already set. This prevents phantom dismissals where the alert vanishes without a trace. Once the TODO is visible, the user can clear it explicitly from the pill/dialog or by typing `Enter` as passthrough input into that Session's shell (i.e., the keystroke is forwarded to the PTY). The command-mode `Enter` that *switches into* passthrough does not clear the TODO. Synthetic terminal reports (focus events, cursor-position responses) also do not count as user input for clearing.

For protocol rings (see [Notification protocols](#notification-protocols)), clearing the protocol ring sets `protocolStatus = IDLE` and returns public `status` to the projected visual-track state. If no visual activity monitor was enabled before the protocol ring, the Session returns to `ALERT_DISABLED`.

The visual track leaves `ALERT_RINGING` and returns to `ALERT_DISABLED` when:

- the user disables visual alerts on that Session (disposes the activity monitor)

Disabling visual alerts does not clear `protocolStatus`. If `protocolStatus` is `OSC_NOTIF_BUSY` or `ALERT_RINGING`, public `status` remains protocol-driven.

The Session's alert state is cleared entirely when:

- the Session is destroyed

If more output arrives later and the Session makes a fresh transition back into `ALERT_RINGING`, the alert rings again.

Marking a Session as TODO resets an activity-monitor alert to `NOTHING_TO_SHOW` and sets `todo = true`, but it does **not** disable future alerts. `todo` and the alert toggle are separate concerns. Protocol rings preserve the same TODO behavior; clearing TODO clears `notification` unless the user explicitly chooses a future "keep details" action.

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
- the visible pill remains `TODO`. It does not resize to arbitrary notification text, and does not adopt protocol-supplied title/body strings. It may show a small dot treatment when notification detail is present, as long as the pill remains fixed-width enough for narrow headers.

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

### Notification preview and detail

Protocol notification detail appears in a preview surface anchored below the TODO pill or alert bell:

- Shown on TODO hover/focus.
- Shown when the selected Pane has a TODO with notification detail and there is enough space.
- Shown above a Door on hover/focus without changing Door click behavior.
- Click/`Enter` on a Door remains reattach-and-attend; no Door-only menus.

Preview content:

- Primary line: `title` if present, otherwise the first body excerpt.
- Body: clamp to 3 lines in the hover preview.
- For generated `OSC 9;4` notifications, title/body already contain the progress summary; no separate progress widget is rendered.
- Footer metadata: protocol source (`OSC 9`, `OSC 9;4`, `OSC 99`, `OSC 777`, `BEL`).

A full detail dialog/popover may be opened from the preview or the existing alert context menu:

- Text wraps and can scroll.
- No raw escape sequence is shown by default.
- Focus traps and `Escape` behavior follow [Accessibility and motion](#accessibility-and-motion).

Recommended decision: do not replace TODO text with notification text. The header and Door need fixed, scannable indicators across many Sessions. Replacing `TODO` with unbounded remote-controlled text creates overflow, localization, spoofing, and attention-noise problems. A hover/selected expansion gives the notification context without destabilizing the layout.

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

### OSC 9 rings with alerts disabled

- Session starts with `status = ALERT_DISABLED`, `todo = false`.
- PTY emits `OSC 9 ; Build finished ST`.
- MouseTerm stores body `Build finished`, sets `todo = true`, and reports `ALERT_RINGING`.
- User clicks into the Pane.
- Ring clears. Because the activity monitor was disabled, status returns to `ALERT_DISABLED`; TODO remains until explicitly cleared or passthrough `Enter` is sent.

### OSC 777 preserves title and body

- PTY emits `OSC 777 ; notify ; Tests ; 341 passed ST`.
- Preview primary line is `Tests`.
- Preview body is `341 passed`.
- The TODO pill remains `TODO`.

### OSC 99 chunked title/body

- PTY emits `OSC 99 ; i=build-1:d=0 ; Build complete ST`.
- No ring yet.
- PTY emits `OSC 99 ; i=build-1:p=body:d=1 ; All tests passed ST`.
- MouseTerm combines title and body, then rings once.

### OSC 9 progress cocks the bell

- PTY emits `OSC 9 ; 4 ; 1 ; 50 ST`.
- MouseTerm stores progress `normal, 50%`.
- Public `status` becomes `OSC_NOTIF_BUSY`; the bell looks like `BUSY` without creating a TODO.
- PTY emits `OSC 9 ; 4 ; 0 ST` while the Session lacks attention.
- MouseTerm rings, sets `todo = true`, and the TODO preview says progress completed.

### OSC 9 progress error rings immediately

- PTY emits `OSC 9 ; 4 ; 2 ; 75 ST` while the Session lacks attention.
- MouseTerm stores progress `error, 75%`.
- MouseTerm rings immediately and attaches error progress detail to the TODO.

### OSC notification while typing does not ring

- User is typing into a Session in passthrough mode, so the Session has attention.
- PTY emits `OSC 9 ; Build finished ST`.
- MouseTerm does not ring and does not create a TODO because the user is already attending that Session.

### Restore does not replay old notifications

- A Session receives an OSC notification and saves state with TODO detail.
- The app reloads and replays buffered output containing the original OSC.
- The TODO detail is restored from persisted state, but no fresh ring is emitted from replay.

## Verification checklist

Visual track:

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

Notification protocols:

- `OSC 9;message` rings and stores `message`.
- `OSC 9;4;1;50` sets `OSC_NOTIF_BUSY` and stores `normal, 50%` internally.
- `OSC 9;4;3` sets `OSC_NOTIF_BUSY` and stores indeterminate progress internally.
- `OSC 9;4;4;25` sets `OSC_NOTIF_BUSY` and stores warning progress internally.
- `OSC 9;4;2` rings immediately with indeterminate error detail.
- `OSC 9;4;0` rings as completion only if there was an active progress cycle.
- `OSC 9;4;1;100` rings immediately as an explicit completion report.
- Standalone `BEL` rings and stores generated terminal-bell detail.
- `OSC 777;notify;title;body` rings and stores title/body.
- Unsupported `OSC 777` subcommands are ignored.
- OSC 99 `d=0` chunks do not ring before completion.
- OSC 99 `d=1` completion rings once with combined title/body.
- OSC 99 `p=?` is answered and does not ring; `p=close`, `p=alive`, `p=icon`, and `p=buttons` do not ring by themselves.
- Extra standalone `BEL` in the same parse batch as a richer OSC event does not replace the richer notification detail.
- Protocol notifications ring with alert disabled.
- Protocol notifications do not ring when the Session has attention.
- Dismissal returns an alert-disabled Session to `ALERT_DISABLED`.
- Dismissal returns an alert-enabled Session to its monitor-backed state.
- TODO pill text remains stable under very long notification text.
- Hover/focus preview wraps long text and does not overflow narrow headers or Doors.
- Replay/restore does not re-fire notification side effects.

## References

- iTerm2 proprietary escape codes (OSC 9, OSC 9;4): https://iterm2.com/documentation-escape-codes.html
- kitty desktop notifications (OSC 99): https://sw.kovidgoyal.net/kitty/desktop-notifications/
- WezTerm escape sequences and notification handling (OSC 9, OSC 777): https://wezterm.org/escape-sequences.html, https://wezterm.org/config/lua/config/notification_handling.html
- foot control sequences (OSC 9, OSC 99, OSC 777): https://manpages.ubuntu.com/manpages/resolute/man7/foot-ctlseqs.7.html
