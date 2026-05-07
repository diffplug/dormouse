# iTerm2 Compatibility Spec

> See `docs/specs/ontology.md` for canonical Session vocabulary and `docs/specs/alert.md` for the Activity state machine. This spec defines terminal-emulator identity and explicit terminal notification escape sequences.

## Goal

MouseTerm should be compatible with applications that look for iTerm2-style terminal behavior when they want to notify the user from inside a PTY. The first supported surfaces are terminal notifications and progress-driven alert arming:

- `OSC 9` iTerm2 notification form
- `OSC 9;4` iTerm2 progress form
- `OSC 99` kitty desktop notification protocol
- `OSC 777` rxvt / WezTerm `notify` form

Notification sequences are explicit application requests for attention. They bypass the normal opt-in activity monitor. If a Session receives a complete displayable notification sequence, the Session may ring even when its alert toggle was disabled. It must not ring while the user is actively attending that Session.

Progress sequences do not ring immediately. They "cock" the alarm bell: MouseTerm treats active progress as an explicit finite-work cycle, exposes `OSC_NOTIF_BUSY`, and rings when the progress cycle completes or enters an error state.

## Non-goals

- No native OS notifications, browser notifications, or sound in this phase. "Alarm" means MouseTerm's existing `ALERT_RINGING` visual state.
- No standalone progress bar in this phase. `OSC 9;4;...` updates `protocolStatus` and internal progress state while active; completion/error creates TODO detail. It does not add a separate progress widget to the Pane header.
- No full iTerm2 feature parity. Unsupported iTerm2, kitty, rxvt, or WezTerm sequences are ignored unless another spec claims them.
- No HTML, markdown, ANSI styling, shell command parsing, or clickable action buttons inside TODO notification previews.

## Identity

MouseTerm should report an iTerm2-compatible identity only to unlock behavior that this spec or later specs intentionally support.

Environment for spawned PTYs:

| Variable | Value |
|---|---|
| `TERM_PROGRAM` | `iTerm.app` |
| `TERM_PROGRAM_VERSION` | MouseTerm's chosen iTerm2 compatibility version, not the package version |
| `LC_TERMINAL` | `iTerm2` only if needed by real-world shell integrations |
| `LC_TERMINAL_VERSION` | same compatibility version as `TERM_PROGRAM_VERSION` |

Device/version query:

- On `CSI > q`, respond with `DCS > | iTerm2 [version] ST`, matching iTerm2's extended device attributes response shape.
- Use a single compatibility version across env and device responses.
- Do not advertise feature-specific support until the relevant behavior exists.

Because this identity can cause tools to emit more iTerm2 escape codes, unsupported escape codes must fail inertly: consume or ignore them without visible terminal garbage, privilege escalation, clipboard access, file access, or focus stealing.

## Supported Protocols

All three notification families use OSC sequences introduced by `ESC ]`. MouseTerm must accept either `BEL` (`\x07`) or `ST` (`ESC \`) terminators for these notification families.

| Protocol | Shape | Fields | Notes |
|---|---|---|---|
| `OSC 9` | `OSC 9 ; [message] ST` | `message` | iTerm2's legacy notification form. No title/body split. |
| `OSC 9;4` | `OSC 9 ; 4 ; [state] ; [progress] ST` or `OSC 9 ; 4 ST` | progress state/progress | Progress only. Cocks the bell and may later ring on completion/error. |
| `OSC 99` | `OSC 99 ; [metadata] ; [payload] ST` | metadata keys plus payload | kitty's rich notification protocol. Chunked and extensible. |
| `OSC 777` | `OSC 777 ; notify ; [title] ; [body] ST` | `title`, `body` | rxvt/WezTerm notification form. Only `notify` is supported. |

### OSC 9

`OSC 9 ; [message] ST` creates one notification:

- `source: 'OSC 9'`
- `title: null`
- `body: [message]`

The message is plain text. There is no formal title, subtitle, urgency, app id, or notification id.

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

- `OSC 99 ; i=[id] : p=? ; ST` may be answered with MouseTerm's actual support.
- Initial minimal response should advertise only `title` and `body`, for example: `OSC 99 ; i=[id] : p=? ; o=always:p=title,body ST`.
- Do not advertise click reports, close reports, urgency, sounds, icons, buttons, or auto-expiry unless implemented end-to-end.

## Normalized Data Model

Protocol notifications are normalized before they touch UI. Keep this shape intentionally small: these are only fields MouseTerm plans to render.

```typescript
type ActivityNotificationSource = 'OSC 9' | 'OSC 9;4' | 'OSC 99' | 'OSC 777';

interface ActivityNotification {
  source: ActivityNotificationSource;
  title: string | null;
  body: string | null;
}
```

Extend `ActivityState` with:

```typescript
interface ActivityState {
  status: SessionStatus; // projected public status, may be OSC_NOTIF_BUSY
  todo: boolean;
  notification: ActivityNotification | null;
}
```

`todo` remains a boolean. Do not replace the TODO pill text with arbitrary notification or progress text. `notification` is the only user-facing detail attached to TODO/alert state.

Mapping rules:

- `OSC 9` stores `{ source: 'OSC 9', title: null, body: message }`.
- `OSC 777` stores `{ source: 'OSC 777', title, body }`.
- `OSC 99` stores `{ source: 'OSC 99', title, body }` after chunk assembly and sanitization.
- `OSC 9;4` stores nothing while progress is active. On completion/error it generates `{ source: 'OSC 9;4', title, body }`, where `title` is a short summary such as `Progress complete`, `Progress error`, or `Progress warning`, and `body` contains the percent when available.

Persistence:

- Persist the latest `ActivityNotification` with the Session's alert state.
- Persist only sanitized text and metadata, not raw escape sequences.
- On restore, persisted notification detail should restore TODO detail, but must not create a fresh ring or re-cock the bell by itself.

## Text Handling

Terminal notifications are untrusted terminal output. Treat all text as plain text.

Input normalization:

- Decode UTF-8 strictly enough to avoid replacement-character floods.
- Strip C0/C1 control characters after protocol parsing.
- Collapse CR/LF/TAB and other controls to spaces.
- Trim leading/trailing whitespace.
- Do not interpret ANSI, OSC, HTML, Markdown, URLs, shell paths, or emoji shortcodes as markup.

Protocol limits:

- OSC 9;4 progress carries only a numeric state and optional numeric percent. There is no user-facing text payload.
- OSC 99 defines a payload chunk limit of 2048 bytes before base64 or 4096 bytes after base64. It permits chunking title/body multiple times, while allowing terminals to impose sensible denial-of-service limits.
- OSC 9 and OSC 777 do not define formal text length limits in the referenced terminal docs.

MouseTerm limits:

- Store at most 256 Unicode grapheme clusters for `title`.
- Store at most 4096 grapheme clusters for `body`.
- Parser memory for incomplete OSC 99 chunks is capped per Session. Drop the oldest incomplete chunks when the cap is exceeded.
- Expire incomplete OSC 99 chunks after 60 seconds if no `d=1` completion arrives.

Expected UI copy length:

- Titles are expected to be one short line, usually under 80 characters.
- Bodies are expected to be a few short lines at most. In MouseTerm chrome, show a compact preview and make the full stored body available in a popover/dialog.

## Alert and TODO Integration

Protocol notification receipt creates a **protocol ring**. This is independent of the opt-in activity monitor.

Protocol progress receipt creates an internal **protocol progress cycle** by setting `protocolStatus = OSC_NOTIF_BUSY`. This is also independent of the opt-in activity monitor.

When a complete displayable protocol notification arrives:

1. Normalize and sanitize the payload.
2. Store it as the Session's latest `notification`.
3. Set `todo = true`.
4. Force the Session's public `status` to `ALERT_RINGING`.
5. Notify activity subscribers immediately.

Important rules:

- Protocol notifications ring even when the Session's activity monitor is disabled.
- Protocol notifications do not ring when the Session has attention.
- Protocol notifications do not enable the activity monitor. After dismissal, a Session whose alert toggle was disabled returns to `ALERT_DISABLED`.
- Protocol notifications do not disable future activity-monitor alerts.
- A protocol ring and an activity-monitor ring can coexist. Dismissing/attending clears the protocol ring first, then public `status` falls back to the monitor's current state. If the monitor is also ringing, public `status` remains `ALERT_RINGING`; if no monitor exists, it returns to `ALERT_DISABLED`.
- `OSC_NOTIF_BUSY` does not participate in visual activity timers. Silence does not promote it to `MIGHT_NEED_ATTENTION` or `ALERT_RINGING`.
- More PTY output does not clear a protocol notification ring without user action.
- User attention, bell dismissal, `t` TODO marking, or TODO clearing follows `docs/specs/alert.md`, with the addition that protocol notification detail remains attached while `todo === true`.
- Clearing TODO clears `notification` unless the user explicitly chooses a future "keep details" action.

Implementation shape inside `AlertManager`:

- Add a protocol-ring flag or source field independent of `ActivityMonitor`.
- Track pending `OSC 9;4` progress internally in `AlertManager`, not in public `ActivityState`.
- `getState(id).status` returns `ALERT_RINGING` while protocol ring is active.
- `getState(id).status` returns `OSC_NOTIF_BUSY` while internal protocol progress is active and no stronger state is present.
- Dismiss/attend clears protocol ring. If no `ActivityMonitor` exists, status becomes `ALERT_DISABLED`; otherwise status falls back to the monitor's current status.
- Completing or erroring a protocol progress cycle creates an `ActivityNotification` and promotes it into a protocol ring only if the Session lacks attention.
- Add methods such as `notifyFromProtocol(id, notification)` and `updateProtocolProgress(id, state, percent)` and expose them through `PlatformAdapter` / VS Code messages.

## UI

The TODO pill stays compact and stable:

- The visible pill remains `TODO`.
- It does not resize to arbitrary notification text.
- It may show a small dot treatment when protocol detail is present, as long as the pill remains fixed-width enough for narrow headers.

Protocol detail appears in a preview surface anchored to the TODO pill or alert bell:

- Show on TODO hover/focus.
- Show when the selected Pane has a TODO with notification detail and there is enough space.
- Show above a Door on hover/focus without changing Door click behavior.
- Keep click/`Enter` on a Door as reattach-and-attend; do not add Door-only menus.

Preview content:

- Primary line: title if present, otherwise the first body excerpt.
- Body: clamp to 3 lines in a hover preview.
- For generated `OSC 9;4` notifications, title/body already contain the progress summary; no separate progress object is rendered.
- Footer metadata: protocol source (`OSC 9`, `OSC 9;4`, `OSC 99`, `OSC 777`).

A full detail dialog/popover may be opened from the preview or existing alert context menu:

- Text wraps and can scroll.
- No raw escape sequence is shown by default.
- Focus traps and `Escape` behavior follow `docs/specs/alert.md`.

Recommended decision: do not replace TODO text with notification text. The header and Door need fixed, scannable indicators across many Sessions. Replacing `TODO` with unbounded remote-controlled text creates overflow, localization, spoofing, and attention-noise problems. A hover/selected expansion gives the notification context without destabilizing the layout.

## Parsing Location

Parse notification OSCs at the platform PTY data boundary, not only in an xterm.js parser hook:

- VS Code owns the authoritative `AlertManager` in the extension host.
- Standalone and fake adapters own `AlertManager` in the frontend adapter.
- Parsing at the platform boundary lets the owner update alert/TODO state before forwarding output to xterm.

The parser should also classify whether a PTY data chunk has visible output after removing notification/progress OSCs:

- If the chunk contains only notification/progress OSCs, do not feed it to activity-monitor `onData()` as generic meaningful output.
- If the chunk contains visible output plus notification/progress OSCs, the visible output still counts as activity.
- Replay/restore output must not re-fire protocol notifications or progress completion. Saved scrollback may contain raw OSCs, but replay filtering must suppress protocol side effects.

## Security and Abuse

Any remote process can emit these sequences over SSH. The feature is useful because it works over SSH, but the UI must be robust against hostile text.

Requirements:

- Sanitize all text before storing or rendering.
- Cap stored text and incomplete parser state.
- Never execute commands, open URLs, copy to clipboard, read files, or focus outside MouseTerm from these sequences.
- Do not render custom icons or buttons in this phase.
- Do not let notification text alter accessible labels beyond plain-text names.
- Do not allow repeated notifications to allocate unbounded history. Store only the latest detail, not an infinite list.

## Scenarios

### OSC 9 rings with alerts disabled

- Session starts with `status = ALERT_DISABLED`, `todo = false`.
- PTY emits `OSC 9 ; Build finished ST`.
- MouseTerm stores body `Build finished`, sets `todo = true`, and reports `ALERT_RINGING`.
- User clicks into the Pane.
- Ring clears. Because the activity monitor was disabled, status returns to `ALERT_DISABLED`; TODO remains until explicitly cleared or passthrough Enter is sent.

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

## Verification Checklist

- `OSC 9;message` rings and stores `message`.
- `OSC 9;4;1;50` sets `OSC_NOTIF_BUSY` and stores `normal, 50%` internally.
- `OSC 9;4;3` sets `OSC_NOTIF_BUSY` and stores indeterminate progress internally.
- `OSC 9;4;4;25` sets `OSC_NOTIF_BUSY` and stores warning progress internally.
- `OSC 9;4;2` rings immediately with indeterminate error detail.
- `OSC 9;4;0` rings as completion only if there was an active progress cycle.
- `OSC 9;4;1;100` rings immediately as an explicit completion report.
- `OSC 777;notify;title;body` rings and stores title/body.
- Unsupported `OSC 777` subcommands are ignored.
- OSC 99 `d=0` chunks do not ring before completion.
- OSC 99 `d=1` completion rings once with combined title/body.
- OSC 99 `p=?`, `p=close`, `p=alive`, `p=icon`, and `p=buttons` do not ring by themselves.
- Protocol notifications ring with alert disabled.
- Protocol notifications do not ring when the Session has attention.
- Dismissal returns an alert-disabled Session to `ALERT_DISABLED`.
- Dismissal returns an alert-enabled Session to its monitor-backed state.
- TODO pill text remains stable under very long notification text.
- Hover/focus preview wraps long text and does not overflow narrow headers or Doors.
- Replay/restore does not re-fire notification side effects.

## References

- iTerm2 proprietary escape codes: `OSC 9` notification, `OSC 9;4` progress, and `CSI > q` response shape.
  https://iterm2.com/documentation-escape-codes.html
- kitty desktop notifications: `OSC 99` format, fields, chunking, payload limits, and plain-text rules.
  https://sw.kovidgoyal.net/kitty/desktop-notifications/
- WezTerm escape sequence table and notification handling: `OSC 9` and `OSC 777;notify;title;body`.
  https://wezterm.org/escape-sequences.html
  https://wezterm.org/config/lua/config/notification_handling.html
- foot control sequences: `OSC 9`, `OSC 99`, and `OSC 777` notification forms.
  https://manpages.ubuntu.com/manpages/resolute/man7/foot-ctlseqs.7.html
